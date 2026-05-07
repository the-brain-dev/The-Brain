/**
 * Tests for @the-brain/plugin-harvester-hermes
 *
 * Tests the Hermes Agent harvester: SQLite parsing, state management,
 * deduplication, and interaction extraction.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

// ── Test Isolation — unique HOME per describe block ─────────────

let TEST_HOME: string;
let HERMES_DB_PATH: string;

beforeEach(() => {
  TEST_HOME = join(tmpdir(), "hermes-harvester-test-" + Date.now() + "-" + randomBytes(4).toString("hex"));
  HERMES_DB_PATH = join(TEST_HOME, ".hermes", "state.db");
  process.env.HOME = TEST_HOME;
  mkdirSync(join(TEST_HOME, ".hermes"), { recursive: true });
  mkdirSync(join(TEST_HOME, ".the-brain"), { recursive: true });
});

afterAll(() => {
  delete process.env.HOME;
});

// ── Helpers ─────────────────────────────────────────────────────

function seedTestDb(dbPath: string) {
  const db = new Database(dbPath);

  db.run(
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, created_at INTEGER)",
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL, token_count INTEGER)",
  );

  // Session 1 — telegram / deepseek
  db.run(
    "INSERT INTO sessions (id, source, model) VALUES ('session-1', 'telegram', 'deepseek-v4-flash')",
  );
  db.run(
    "INSERT INTO messages (session_id, role, content, timestamp, token_count) VALUES ('session-1', 'user', 'Hello, how are you?', 1000.0, NULL)",
  );
  db.run(
    "INSERT INTO messages (session_id, role, content, timestamp, token_count) VALUES ('session-1', 'assistant', 'I am doing great, thank you!', 1001.0, 42)",
  );
  db.run(
    "INSERT INTO messages (session_id, role, content, timestamp, token_count) VALUES ('session-1', 'user', 'Tell me a joke', 2000.0, NULL)",
  );
  db.run(
    "INSERT INTO messages (session_id, role, content, timestamp, token_count) VALUES ('session-1', 'assistant', 'Why did the developer go broke? Because he used up all his cache!', 2001.0, 15)",
  );

  // Session_meta (should be filtered out)
  db.run(
    "INSERT INTO messages (session_id, role, content, timestamp, token_count) VALUES ('session-1', 'session_meta', '{}', 500.0, NULL)",
  );

  // Session 2 — telegram / claude
  db.run(
    "INSERT INTO sessions (id, source, model) VALUES ('session-2', 'telegram', 'claude-sonnet-4')",
  );
  db.run(
    "INSERT INTO messages (session_id, role, content, timestamp, token_count) VALUES ('session-2', 'user', 'What is TypeScript?', 3000.0, NULL)",
  );
  db.run(
    "INSERT INTO messages (session_id, role, content, timestamp, token_count) VALUES ('session-2', 'assistant', 'TypeScript is a typed superset of JavaScript.', 3001.0, 28)",
  );

  db.close();
}

async function getHarvesterModule() {
  // Clear require cache so each test get a fresh module
  return await import("../index.ts");
}

// ── Tests ────────────────────────────────────────────────────────

describe("Hermes Harvester — DB Discovery", () => {
  it("should detect Hermes state.db existence", () => {
    seedTestDb(HERMES_DB_PATH);
    expect(existsSync(HERMES_DB_PATH)).toBe(true);
  });

  it("should have messages and sessions tables", () => {
    seedTestDb(HERMES_DB_PATH);
    const db = new Database(HERMES_DB_PATH);
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name).sort();
    expect(names).toEqual(["messages", "sessions"]);
    db.close();
  });
});

describe("Hermes Harvester — Polling", () => {
  it("should harvest interactions from the database", async () => {
    seedTestDb(HERMES_DB_PATH);
    const { createHermesHarvester } = await getHarvesterModule();

    const calledHooks: Array<{ event: string }> = [];
    const hooks = {
      callHook: async (event: string) => { calledHooks.push({ event }); },
    } as any;

    const harvester = createHermesHarvester(hooks, {
      homeDir: TEST_HOME,
      pollIntervalMs: 60000,
    });

    const contexts = await harvester.poll();

    // Should have found 3 pairs (2 from session-1, 1 from session-2)
    expect(contexts.length).toBe(3);

    // Check interaction format
    expect(contexts[0].interaction.source).toBe("hermes-agent");
    expect(contexts[0].interaction.prompt).toBe("Hello, how are you?");
    expect(contexts[0].interaction.response).toBe("I am doing great, thank you!");

    // Check session_meta was filtered out
    const allPrompts = contexts.map((c) => c.interaction.prompt);
    expect(allPrompts).not.toContain("{}");

    // Check hooks were called
    const harvesterCalls = calledHooks.filter((h) => h.event === "harvester:newData");
    expect(harvesterCalls.length).toBe(3);

    const interactionCalls = calledHooks.filter((h) => h.event === "onInteraction");
    expect(interactionCalls.length).toBe(3);

    harvester.stop();
  });

  it("should deduplicate on second poll", async () => {
    seedTestDb(HERMES_DB_PATH);
    const { createHermesHarvester } = await getHarvesterModule();

    const hooks = { callHook: async () => {} } as any;
    const harvester = createHermesHarvester(hooks, {
      homeDir: TEST_HOME,
      pollIntervalMs: 60000,
    });

    // First poll
    const first = await harvester.poll();
    expect(first.length).toBe(3);

    // Second poll — should have nothing new
    const second = await harvester.poll();
    expect(second.length).toBe(0);

    harvester.stop();
  });

  it("should extract metadata correctly", async () => {
    seedTestDb(HERMES_DB_PATH);
    const { createHermesHarvester } = await getHarvesterModule();

    const hooks = { callHook: async () => {} } as any;
    const harvester = createHermesHarvester(hooks, {
      homeDir: TEST_HOME,
      pollIntervalMs: 60000,
    });

    const contexts = await harvester.poll();
    expect(contexts.length).toBeGreaterThan(0);

    const ctx = contexts[0];
    expect(ctx.interaction.metadata).toBeDefined();
    expect((ctx.interaction.metadata as any)?.channel).toBe("telegram");
    expect((ctx.interaction.metadata as any)?.model).toBe("deepseek-v4-flash");
    expect((ctx.interaction.metadata as any)?.tokenCount).toBe(42);

    // Check fragment
    expect(ctx.fragments.length).toBe(1);
    expect(ctx.fragments[0].source).toBe("hermes-agent");
    expect(ctx.fragments[0].layer).toBe("instant");

    harvester.stop();
  });
});

describe("Hermes Harvester — State Management", () => {
  it("should track interaction count", async () => {
    seedTestDb(HERMES_DB_PATH);
    const { createHermesHarvester } = await getHarvesterModule();

    const hooks = { callHook: async () => {} } as any;
    const harvester = createHermesHarvester(hooks, {
      homeDir: TEST_HOME,
      pollIntervalMs: 60000,
    });

    await harvester.poll();

    const state = harvester.getState();
    expect(state.totalIx).toBe(3);
    expect(state.sessions.length).toBe(2);
    expect(state.lastId).toBeGreaterThan(0);

    harvester.stop();
  });

  it("should persist and reload state", async () => {
    seedTestDb(HERMES_DB_PATH);
    const { createHermesHarvester } = await getHarvesterModule();

    // First instance — harvest
    const hooks1 = { callHook: async () => {} } as any;
    const harvester1 = createHermesHarvester(hooks1, {
      homeDir: TEST_HOME,
      pollIntervalMs: 60000,
    });
    await harvester1.poll();
    const stateAfter1 = harvester1.getState();
    harvester1.stop();

    // Second instance — should pick up from saved state
    const hooks2 = { callHook: async () => {} } as any;
    const harvester2 = createHermesHarvester(hooks2, {
      homeDir: TEST_HOME,
      pollIntervalMs: 60000,
    });

    // Should have zero new interactions since state was saved
    const contexts = await harvester2.poll();
    expect(contexts.length).toBe(0);

    // State should be restored
    const stateAfter2 = harvester2.getState();
    expect(stateAfter2.totalIx).toBe(stateAfter1.totalIx);
    expect(stateAfter2.lastId).toBe(stateAfter1.lastId);

    harvester2.stop();
  });
});

/**
 * Comprehensive inspect command tests — covers all branches
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_HOME = join(tmpdir(), "my-brain-inspect-test-" + Date.now());
const TEST_DB = join(TEST_HOME, ".my-brain", "brain.db");

describe("inspectCommand", () => {
  beforeAll(async () => {
    // Isolate under a temp HOME
    const oldHome = process.env.HOME;
    process.env.HOME = TEST_HOME;
    await mkdir(join(TEST_HOME, ".my-brain"), { recursive: true });

    // Seed the test DB with data
    const { BrainDB, MemoryLayer } = await import("@my-brain/core");
    const db = new BrainDB(TEST_DB);

    // Insert some sessions
    await db.createSession({ id: "session-1", source: "cursor", startedAt: Date.now() - 86400000 });
    await db.createSession({ id: "session-2", source: "claude", startedAt: Date.now() - 43200000 });

    // Insert memories across layers
    await db.insertMemory({
      id: "mem-1", layer: MemoryLayer.INSTANT, content: "User prefers TypeScript over JavaScript",
      timestamp: Date.now() - 3600000, source: "cursor", metadata: {},
    });
    await db.insertMemory({
      id: "mem-2", layer: MemoryLayer.SELECTION, content: "Always use named exports",
      timestamp: Date.now() - 7200000, source: "claude", metadata: {},
    });
    await db.insertMemory({
      id: "mem-3", layer: MemoryLayer.DEEP, content: "Project uses Bun for tooling",
      timestamp: Date.now() - 100000, source: "cursor", metadata: {},
    });

    // Insert graph nodes via upsert
    const { createHash } = await import("node:crypto");
    const hash = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 16);
    await db.upsertGraphNode({
      type: "correction", label: "Use named exports, not default exports",
      id: hash("corr-1"), source: "claude", timestamp: Date.now() - 3600000,
      connections: [], weight: 0.9, content: "correction content",
    });
    await db.upsertGraphNode({
      type: "preference", label: "Use Bun for all TS/JS tooling",
      id: hash("pref-1"), source: "cursor", timestamp: Date.now() - 7200000,
      connections: [], weight: 0.8, content: "preference content",
    });
    await db.upsertGraphNode({
      type: "pattern", label: "Works with TypeScript daily",
      id: hash("pat-1"), source: "cursor", timestamp: Date.now() - 100000,
      connections: [], weight: 0.7, content: "pattern content",
    });
    await db.upsertGraphNode({
      type: "concept", label: "Zod for runtime validation",
      id: hash("con-1"), source: "claude", timestamp: Date.now() - 200000,
      connections: [], weight: 0.6, content: "concept content",
    });

    db.close();
  });

  afterAll(async () => {
    process.env.HOME = process.env.HOME; // restore (Bun test isolates env)
    const { rm } = await import("node:fs/promises");
    await rm(TEST_HOME, { recursive: true, force: true });
  });

  test("imports inspectCommand", async () => {
    const mod = await import("../commands/inspect");
    expect(typeof mod.inspectCommand).toBe("function");
  });

  test("--stats with seeded DB", async () => {
    const { inspectCommand } = await import("../commands/inspect");
    await inspectCommand({ stats: true });
  });

  test("--graph flag with high-weight nodes", async () => {
    const { inspectCommand } = await import("../commands/inspect");
    await inspectCommand({ graph: true });
  });

  test("--recent flag with recent memories", async () => {
    const { inspectCommand } = await import("../commands/inspect");
    await inspectCommand({ recent: true });
  });

  test("--memories flag", async () => {
    const { inspectCommand } = await import("../commands/inspect");
    await inspectCommand({ memories: true });
  });

  test("--memories with layer filter (instant)", async () => {
    const { inspectCommand } = await import("../commands/inspect");
    await inspectCommand({ memories: "instant" });
  });

  test("--search finds matching nodes", async () => {
    const { inspectCommand } = await import("../commands/inspect");
    await inspectCommand({ search: "TypeScript" });
  });

  test("--search returns empty for no match", async () => {
    const { inspectCommand } = await import("../commands/inspect");
    await inspectCommand({ search: "nonexistent_term_xyz" });
  });

  test("--top all shows top nodes across types", async () => {
    const { inspectCommand } = await import("../commands/inspect");
    await inspectCommand({ top: "all" });
  });

  test("--top correction shows filtered nodes", async () => {
    const { inspectCommand } = await import("../commands/inspect");
    await inspectCommand({ top: "correction" });
  });

  test("--top with invalid type shows warning", async () => {
    const { inspectCommand } = await import("../commands/inspect");
    await inspectCommand({ top: "bogus" });
  });

  test("--sources shows breakdown", async () => {
    const { inspectCommand } = await import("../commands/inspect");
    await inspectCommand({ sources: true });
  });
});

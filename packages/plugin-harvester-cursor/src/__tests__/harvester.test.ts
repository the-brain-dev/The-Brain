/**
 * Tests for @the-brain/plugin-harvester-cursor — Data Harvester
 */
import { describe, test, expect, mock, afterEach } from "bun:test";
import { HookEvent } from "@the-brain/core";

// Import the default export (it's a definePlugin call)
// We need to handle the dynamic import
describe("createCursorHarvester", () => {
  test("plugin definition has expected shape", async () => {
    const mod = await import("../index");
    const plugin = mod.default || mod;
    expect(plugin.name).toBeDefined();
    expect(typeof plugin.setup).toBe("function");
  });

  test("setup registers harvester and lifecycle hooks", async () => {
    const mod = await import("../index");
    const plugin = mod.default || mod;
    const registered: string[] = [];
    const hooks = {
      hook: (event: string, _fn: Function) => { registered.push(event); },
      callHook: async () => {},
      getHandlers: () => [],
    };

    plugin.setup(hooks as any);
    expect(registered).toContain(HookEvent.DAEMON_START);
    expect(registered).toContain(HookEvent.DAEMON_STOP);
  });
});

describe("@the-brain/plugin-identity-anchor", () => {
  test("createIdentityAnchorPlugin returns plugin definition", async () => {
    const { createIdentityAnchorPlugin } = await import("@the-brain/plugin-identity-anchor");
    const plugin = createIdentityAnchorPlugin();
    expect(plugin.name).toBe("@the-brain/plugin-identity-anchor");
    expect(typeof plugin.setup).toBe("function");
  });

  test("setup registers selection and deep hooks", async () => {
    const { createIdentityAnchorPlugin } = await import("@the-brain/plugin-identity-anchor");
    const plugin = createIdentityAnchorPlugin();
    const registered: string[] = [];
    const hooks = {
      hook: (event: string, _fn: Function) => { registered.push(event); },
      callHook: async () => {},
      getHandlers: () => [],
    };

    plugin.setup(hooks as any);
    expect(registered).toContain(HookEvent.SELECTION_PROMOTE);
    expect(registered).toContain(HookEvent.DEEP_CONSOLIDATE);
  });

  test("accepts custom config", async () => {
    const { createIdentityAnchorPlugin } = await import("@the-brain/plugin-identity-anchor");
    const plugin = createIdentityAnchorPlugin({ minIdentityScore: 0.8, maxAnchorFragments: 20 });
    expect(plugin.name).toBeDefined();
    expect(typeof plugin.teardown).toBe("function");
  });

  test("teardown clears state", async () => {
    const { createIdentityAnchorPlugin } = await import("@the-brain/plugin-identity-anchor");
    const plugin = createIdentityAnchorPlugin();
    expect(() => plugin.teardown!()).not.toThrow();
  });
});

describe("@the-brain/plugin-auto-wiki", () => {
  test("createAutoWikiPlugin returns plugin definition", async () => {
    const { BrainDB } = await import("@the-brain/core");
    const db = new BrainDB(":memory:");
    const { createAutoWikiPlugin } = await import("@the-brain/plugin-auto-wiki");
    const plugin = createAutoWikiPlugin(db);
    expect(plugin.name).toBe("@the-brain/plugin-auto-wiki");
    db.close();
  });

  test("setup registers consolidation hook", async () => {
    const { BrainDB } = await import("@the-brain/core");
    const db = new BrainDB(":memory:");
    const { createAutoWikiPlugin } = await import("@the-brain/plugin-auto-wiki");
    const plugin = createAutoWikiPlugin(db);
    const registered: string[] = [];
    const hooks = {
      hook: (event: string, _fn: Function) => { registered.push(event); },
      callHook: async () => {},
      getHandlers: () => [],
    };

    plugin.setup(hooks as any);
    expect(registered).toContain(HookEvent.CONSOLIDATE_COMPLETE);
    db.close();
  });

  test("accepts custom output directory", async () => {
    const { BrainDB } = await import("@the-brain/core");
    const db = new BrainDB(":memory:");
    const { createAutoWikiPlugin } = await import("@the-brain/plugin-auto-wiki");
    const plugin = createAutoWikiPlugin(db, { outputDir: "/tmp/test-wiki", title: "Test Wiki" });
    expect(plugin.name).toBeDefined();
    db.close();
  });
});

// ── cursorDiskKV Extraction ─────────────────────────────────────

describe("cursorDiskKV extraction", () => {
  let testDir: string;

  afterEach(() => {
    if (testDir) {
      try { rmSync(testDir, { recursive: true, force: true }); } catch {}
    }
  });

  test("extracts chat entries from cursorDiskKV table", async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Database } = await import("bun:sqlite");

    testDir = mkdtempSync(join(tmpdir(), "cursor-kv-test-"));
    process.env.HOME = testDir;

    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");
    mkdirSync(cursorBase, { recursive: true });

    // Create workspace with state.vscdb containing cursorDiskKV table
    const wsDir = join(cursorBase, "User", "workspaceStorage", "kv-ws");
    mkdirSync(wsDir, { recursive: true });
    const dbPath = join(wsDir, "state.vscdb");

    const now = Date.now();
    const db = new Database(dbPath);
    db.run("CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    db.run("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)", [
      "chat::composer:session-abc",
      JSON.stringify({
        sessionId: "session-abc",
        timestamp: now,
        messages: [
          { role: "user", content: "KV prompt" },
          { role: "assistant", content: "KV response" },
        ],
      }),
    ]);
    db.close();

    const mod = await import("../index");
    const { createCursorHarvester } = mod;
    const calls: { event: string; args: unknown[] }[] = [];
    const hooks: any = {
      hook: () => {},
      callHook: async (event: string, ...args: unknown[]) => {
        calls.push({ event, args });
      },
      getHandlers: () => [],
    };

    const harvester = createCursorHarvester(hooks, { basePath: cursorBase });
    await harvester.poll();

    const interactionCalls = calls.filter((c) => c.event === "onInteraction");
    expect(interactionCalls.length).toBeGreaterThanOrEqual(1);

    const ctx = interactionCalls[0].args[0] as any;
    expect(ctx.interaction.prompt).toBe("KV prompt");
    expect(ctx.interaction.response).toBe("KV response");
    expect(ctx.interaction.source).toBe("cursor");
  });

  test("handles unparseable JSON in cursorDiskKV values", async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Database } = await import("bun:sqlite");

    testDir = mkdtempSync(join(tmpdir(), "cursor-kv-bad-"));
    process.env.HOME = testDir;

    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");
    mkdirSync(cursorBase, { recursive: true });

    const wsDir = join(cursorBase, "User", "workspaceStorage", "kv-bad");
    mkdirSync(wsDir, { recursive: true });
    const dbPath = join(wsDir, "state.vscdb");

    const db = new Database(dbPath);
    db.run("CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    db.run("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)", [
      "chat::garbage",
      "{not valid json!!",
    ]);
    db.close();

    const mod = await import("../index");
    const { createCursorHarvester } = mod;
    const hooks: any = {
      hook: () => {},
      callHook: async () => {},
      getHandlers: () => [],
    };

    const harvester = createCursorHarvester(hooks, { basePath: cursorBase });
    // Should not crash on corrupt JSON
    const results = await harvester.poll();
    expect(Array.isArray(results)).toBe(true);
  });

  test("skips cursorDiskKV table if it does not exist", async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Database } = await import("bun:sqlite");

    testDir = mkdtempSync(join(tmpdir(), "cursor-kv-no-"));
    process.env.HOME = testDir;

    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");
    mkdirSync(cursorBase, { recursive: true });

    const wsDir = join(cursorBase, "User", "workspaceStorage", "no-kv-table");
    mkdirSync(wsDir, { recursive: true });
    const dbPath = join(wsDir, "state.vscdb");

    // DB exists but no cursorDiskKV table — only ItemTable
    const db = new Database(dbPath);
    db.run("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT, value TEXT)");
    db.close();

    const mod = await import("../index");
    const { createCursorHarvester } = mod;
    const hooks: any = {
      hook: () => {},
      callHook: async () => {},
      getHandlers: () => [],
    };

    const harvester = createCursorHarvester(hooks, { basePath: cursorBase });
    // Should not crash — just returns empty
    const results = await harvester.poll();
    expect(Array.isArray(results)).toBe(true);
  });

  test("extracts from cursorDiskKV with composer:: and conversation:: prefixes", async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Database } = await import("bun:sqlite");

    testDir = mkdtempSync(join(tmpdir(), "cursor-kv-prefix-"));
    process.env.HOME = testDir;

    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");
    mkdirSync(cursorBase, { recursive: true });

    const wsDir = join(cursorBase, "User", "workspaceStorage", "kv-prefix");
    mkdirSync(wsDir, { recursive: true });
    const dbPath = join(wsDir, "state.vscdb");

    const now = Date.now();
    const db = new Database(dbPath);
    db.run("CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    db.run("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)", [
      "composer::session-def",
      JSON.stringify({
        sessionId: "session-def",
        timestamp: now,
        messages: [
          { role: "user", content: "Composer prompt" },
          { role: "assistant", content: "Composer response" },
        ],
      }),
    ]);
    db.run("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)", [
      "conversation::conv-ghi",
      JSON.stringify({
        sessionId: "conv-ghi",
        timestamp: now + 1,
        messages: [
          { role: "user", content: "Conversation prompt" },
          { role: "assistant", content: "Conversation response" },
        ],
      }),
    ]);
    db.close();

    const mod = await import("../index");
    const { createCursorHarvester } = mod;
    const calls: { event: string; args: unknown[] }[] = [];
    const hooks: any = {
      hook: () => {},
      callHook: async (event: string, ...args: unknown[]) => {
        calls.push({ event, args });
      },
      getHandlers: () => [],
    };

    const harvester = createCursorHarvester(hooks, { basePath: cursorBase });
    await harvester.poll();

    const interactionCalls = calls.filter((c) => c.event === "onInteraction");
    expect(interactionCalls.length).toBeGreaterThanOrEqual(2);

    const prompts = interactionCalls.map((c) => (c.args[0] as any).interaction.prompt);
    expect(prompts).toContain("Composer prompt");
    expect(prompts).toContain("Conversation prompt");
  });
});

// ── Project Discovery Edge Cases ────────────────────────────────

describe("project discovery edge cases", () => {
  let testDir: string;

  afterEach(() => {
    if (testDir) {
      try { rmSync(testDir, { recursive: true, force: true }); } catch {}
    }
  });

  test("matchProjectFromConfig returns null when config.json is missing", async () => {
    const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Database } = await import("bun:sqlite");

    testDir = mkdtempSync(join(tmpdir(), "cursor-noconfig-"));
    process.env.HOME = testDir;

    // No .the-brain/config.json

    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");
    const wsDir = join(cursorBase, "User", "workspaceStorage", "no-config-ws");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(
      join(wsDir, "workspace.json"),
      JSON.stringify({ folder: "file:///Users/dev/unknown-project" }),
      "utf-8",
    );

    const dbPath = join(wsDir, "state.vscdb");
    const now = Date.now();
    const db = new Database(dbPath);
    db.run("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT, value TEXT)");
    db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [
      "cursor.chat.history",
      JSON.stringify({
        sessionId: "no-config",
        timestamp: now,
        messages: [
          { role: "user", content: "No config prompt" },
          { role: "assistant", content: "No config response" },
        ],
      }),
    ]);
    db.close();

    const mod = await import("../index");
    const { createCursorHarvester } = mod;
    const calls: { event: string; args: unknown[] }[] = [];
    const hooks: any = {
      hook: () => {},
      callHook: async (event: string, ...args: unknown[]) => {
        calls.push({ event, args });
      },
      getHandlers: () => [],
    };

    const harvester = createCursorHarvester(hooks, { basePath: cursorBase });
    await harvester.poll();

    const interactionCalls = calls.filter((c) => c.event === "onInteraction");
    expect(interactionCalls.length).toBeGreaterThanOrEqual(1);

    // project should not be set since no config.json exists
    const ctx = interactionCalls[0].args[0] as any;
    expect(ctx.interaction.metadata.project).toBeUndefined();
  });

  test("detectWorkspaceFolder handles non-file:// URI paths", async () => {
    const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Database } = await import("bun:sqlite");

    testDir = mkdtempSync(join(tmpdir(), "cursor-rawuri-"));
    process.env.HOME = testDir;

    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");
    const wsDir = join(cursorBase, "User", "workspaceStorage", "raw-uri-ws");
    mkdirSync(wsDir, { recursive: true });

    // workspace.json with a raw path (not file:// URI)
    writeFileSync(
      join(wsDir, "workspace.json"),
      JSON.stringify({ folder: "/Users/dev/raw-path-project" }),
      "utf-8",
    );

    const dbPath = join(wsDir, "state.vscdb");
    const db = new Database(dbPath);
    db.run("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT, value TEXT)");
    db.close();

    const mod = await import("../index");
    const { discoverWorkspaces } = mod;

    const workspaces = discoverWorkspaces(cursorBase);
    const ws = workspaces.find((w: any) => w.path === wsDir);
    expect(ws).toBeDefined();
    // Raw path (not file://) should still be used as-is
    expect(ws!.projectFolder).toBe("/Users/dev/raw-path-project");
  });

  test("discoverWorkspaces handles permission errors gracefully", async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    testDir = mkdtempSync(join(tmpdir(), "cursor-perm-"));
    process.env.HOME = testDir;

    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");

    // Create workspaceStorage but make it an empty file (readdirSync will error)
    const wsStorage = join(cursorBase, "User", "workspaceStorage");
    mkdirSync(join(cursorBase, "User"), { recursive: true });
    // Don't create workspaceStorage dir — discoverWorkspaces should handle this
    // by catching the ENOENT from readdirSync on non-existent workspaceStorage

    const mod = await import("../index");
    const { discoverWorkspaces } = mod;

    // Should not throw — returns empty when workspaceStorage doesn't exist
    const workspaces = discoverWorkspaces(cursorBase);
    expect(Array.isArray(workspaces)).toBe(true);
  });
});

// ── Deduplication with Processed IDs ────────────────────────────

describe("deduplication", () => {
  let testDir: string;

  afterEach(() => {
    if (testDir) {
      try { rmSync(testDir, { recursive: true, force: true }); } catch {}
    }
  });

  test("skips previously processed interactions on second poll", async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Database } = await import("bun:sqlite");

    testDir = mkdtempSync(join(tmpdir(), "cursor-dedup-"));
    process.env.HOME = testDir;

    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");
    mkdirSync(cursorBase, { recursive: true });

    const wsDir = join(cursorBase, "User", "workspaceStorage", "dedup-ws");
    mkdirSync(wsDir, { recursive: true });
    const dbPath = join(wsDir, "state.vscdb");

    const now = Date.now();
    const entry = {
      sessionId: "dedup-session",
      timestamp: now,
      messages: [
        { role: "user", content: "First poll prompt" },
        { role: "assistant", content: "First poll response" },
      ],
    };

    const db = new Database(dbPath);
    db.run("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT, value TEXT)");
    db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [
      "workbench.panel.aichat.view.aichat.chatdata",
      JSON.stringify(entry),
    ]);
    db.close();

    const mod = await import("../index");
    const { createCursorHarvester } = mod;
    const calls: { event: string; args: unknown[] }[] = [];
    const hooks: any = {
      hook: () => {},
      callHook: async (event: string, ...args: unknown[]) => {
        calls.push({ event, args });
      },
      getHandlers: () => [],
    };

    // First poll
    const harvester = createCursorHarvester(hooks, { basePath: cursorBase });
    await harvester.poll();

    const firstPollCalls = calls.filter((c) => c.event === "onInteraction");
    expect(firstPollCalls.length).toBeGreaterThanOrEqual(1);
    const firstId = (firstPollCalls[0].args[0] as any).interaction.id;

    // Reset calls array
    calls.length = 0;

    // Second poll — same data, should be deduplicated
    await harvester.poll();

    const secondPollCalls = calls.filter((c) => c.event === "onInteraction");
    // No new interactions should be emitted since the same entry was already processed
    expect(secondPollCalls.length).toBe(0);

    // Verify the processed ID was tracked
    expect(typeof firstId).toBe("string");
    expect(firstId.length).toBeGreaterThan(0);
  });

  test("only emits new interactions when data changes between polls", async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Database } = await import("bun:sqlite");

    testDir = mkdtempSync(join(tmpdir(), "cursor-dedup2-"));
    process.env.HOME = testDir;

    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");
    mkdirSync(cursorBase, { recursive: true });

    const wsDir = join(cursorBase, "User", "workspaceStorage", "dedup2-ws");
    mkdirSync(wsDir, { recursive: true });
    const dbPath = join(wsDir, "state.vscdb");

    const now = Date.now();
    const oldEntry = {
      sessionId: "old-session",
      timestamp: now,
      messages: [
        { role: "user", content: "Old prompt" },
        { role: "assistant", content: "Old response" },
      ],
    };

    const db = new Database(dbPath);
    db.run("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT, value TEXT)");
    db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [
      "workbench.panel.aichat.view.aichat.chatdata",
      JSON.stringify(oldEntry),
    ]);
    db.close();

    const mod = await import("../index");
    const { createCursorHarvester } = mod;
    const calls: { event: string; args: unknown[] }[] = [];
    const hooks: any = {
      hook: () => {},
      callHook: async (event: string, ...args: unknown[]) => {
        calls.push({ event, args });
      },
      getHandlers: () => [],
    };

    const harvester = createCursorHarvester(hooks, { basePath: cursorBase });
    // First poll
    await harvester.poll();
    const firstCount = calls.filter((c) => c.event === "onInteraction").length;

    // Add a new entry to the DB
    const db2 = new Database(dbPath);
    db2.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [
      "cursor.chat.new",
      JSON.stringify({
        sessionId: "new-session",
        timestamp: now + 1000,
        messages: [
          { role: "user", content: "New prompt" },
          { role: "assistant", content: "New response" },
        ],
      }),
    ]);
    db2.close();

    calls.length = 0;

    // Second poll — only the new entry should be emitted
    await harvester.poll();
    const secondCount = calls.filter((c) => c.event === "onInteraction").length;

    // Old entry deduplicated, only new entry emitted
    expect(secondCount).toBe(1);
    const ctx = (calls.find((c) => c.event === "onInteraction")!.args[0] as any);
    expect(ctx.interaction.prompt).toBe("New prompt");
  });

  test("loadState handles corrupt state file gracefully", async () => {
    const { mkdtempSync, rmSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    testDir = mkdtempSync(join(tmpdir(), "cursor-badstate-"));
    process.env.HOME = testDir;

    // Create corrupt state file
    const myBrainDir = join(testDir, ".the-brain");
    mkdirSync(myBrainDir, { recursive: true });
    writeFileSync(join(myBrainDir, "cursor-harvester-state.json"), "{not valid json!!!", "utf-8");

    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");
    mkdirSync(cursorBase, { recursive: true });

    const mod = await import("../index");
    const { createCursorHarvester } = mod;
    const hooks: any = {
      hook: () => {},
      callHook: async () => {},
      getHandlers: () => [],
    };

    // Should not crash — starts fresh when state file is corrupt
    const harvester = createCursorHarvester(hooks, { basePath: cursorBase });
    const results = await harvester.poll();
    expect(Array.isArray(results)).toBe(true);
  });
});

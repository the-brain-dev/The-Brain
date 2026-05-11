/**
 * Tests for @the-brain-dev/plugin-harvester-cursor — coverage boost.
 *
 * Tests discoverWorkspaces, getCursorBasePath, plugin shape,
 * and workspace discovery with mock Cursor directory structures.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

// ── Helpers ──────────────────────────────────────────────────────

function setupTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cursor-test-"));
  process.env.HOME = dir;
  return dir;
}

// ── Plugin Definition ───────────────────────────────────────────

describe("Plugin Definition", () => {
  it("has expected shape", async () => {
    const mod = await import("../index");
    const plugin = mod.default;
    expect(plugin.name).toBe("plugin-harvester-cursor");
    expect(plugin.version).toBeDefined();
    expect(typeof plugin.setup).toBe("function");
    expect(typeof plugin.teardown).toBe("function");
  });

  it("registers lifecycle hooks on setup", async () => {
    const mod = await import("../index");
    const plugin = mod.default;
    const registered: string[] = [];
    const hooks = {
      hook: (event: string) => { registered.push(event); },
      callHook: async () => {},
      getHandlers: () => [],
    };

    plugin.setup(hooks);
    expect(registered).toContain("daemon:start");
    expect(registered).toContain("daemon:stop");
    expect(registered).toContain("harvester:poll");
  });

  it("stores harvester reference on hooks", async () => {
    const mod = await import("../index");
    const plugin = mod.default;
    const hooks: Record<string, unknown> = {
      hook: () => {},
      callHook: async () => {},
      getHandlers: () => [],
    };

    plugin.setup(hooks);
    expect(hooks["plugin-harvester-cursor"]).toBeDefined();
  });
});

// ── getCursorBasePath ────────────────────────────────────────────

describe("getCursorBasePath", () => {
  it("returns platform-specific path", async () => {
    const mod = await import("../index");
    const { getCursorBasePath } = mod;
    const path = getCursorBasePath();
    const os = platform();

    if (os === "darwin") {
      expect(path).toContain("Library/Application Support/Cursor");
    } else if (os === "linux") {
      expect(path).toContain(".config/Cursor");
    } else if (os === "win32") {
      expect(path).toContain("Cursor");
    }
    // Should always contain "Cursor"
    expect(path).toContain("Cursor");
  });
});

// ── discoverWorkspaces ───────────────────────────────────────────

describe("discoverWorkspaces", () => {
  let testDir: string;

  afterEach(() => {
    if (testDir) {
      try { rmSync(testDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("returns empty array for non-existent base path", async () => {
    const mod = await import("../index");
    const { discoverWorkspaces } = mod;
    const workspaces = discoverWorkspaces("/nonexistent/path/to/cursor");
    expect(workspaces).toEqual([]);
  });

  it("discovers workspace storage with state.vscdb", async () => {
    testDir = setupTestDir();
    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");

    // Create workspace storage with a state.vscdb
    const wsDir = join(cursorBase, "User", "workspaceStorage", "abc123");
    mkdirSync(wsDir, { recursive: true });

    // Create empty SQLite database
    const dbPath = join(wsDir, "state.vscdb");
    const db = new Database(dbPath);
    db.run("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT, value TEXT)");
    db.close();

    const mod = await import("../index");
    const { discoverWorkspaces } = mod;
    const workspaces = discoverWorkspaces(cursorBase);

    expect(workspaces.length).toBeGreaterThanOrEqual(1);
    const ws = workspaces.find((w: any) => w.dbPath === dbPath);
    expect(ws).toBeDefined();
    expect(ws!.dbPath).toBe(dbPath);
  });

  it("sets dbPath null when state.vscdb doesn't exist", async () => {
    testDir = setupTestDir();
    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");

    // Create workspace directory WITHOUT state.vscdb
    const wsDir = join(cursorBase, "User", "workspaceStorage", "no-db-dir");
    mkdirSync(wsDir, { recursive: true });

    const mod = await import("../index");
    const { discoverWorkspaces } = mod;
    const workspaces = discoverWorkspaces(cursorBase);

    expect(workspaces.length).toBeGreaterThanOrEqual(1);
    const ws = workspaces.find((w: any) => w.path === wsDir);
    expect(ws).toBeDefined();
    expect(ws!.dbPath).toBeNull();
  });

  it("detects project from workspace.json", async () => {
    testDir = setupTestDir();
    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");

    // Create workspace with workspace.json
    const wsDir = join(cursorBase, "User", "workspaceStorage", "proj-ws");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(
      join(wsDir, "workspace.json"),
      JSON.stringify({ folder: "file:///Users/dev/my-project" }),
      "utf-8",
    );

    // Create state.vscdb
    const dbPath = join(wsDir, "state.vscdb");
    const db = new Database(dbPath);
    db.run("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT, value TEXT)");
    db.close();

    const mod = await import("../index");
    const { discoverWorkspaces } = mod;
    const workspaces = discoverWorkspaces(cursorBase);

    const ws = workspaces.find((w: any) => w.path === wsDir);
    expect(ws).toBeDefined();
    // projectFolder should be detected
    expect(ws!.projectFolder).toBeDefined();
    expect(ws!.projectFolder).toContain("my-project");
  });

  it("discovers global storage database", async () => {
    testDir = setupTestDir();
    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");

    // Create global storage
    const globalDir = join(cursorBase, "User", "globalStorage");
    mkdirSync(globalDir, { recursive: true });
    const dbPath = join(globalDir, "state.vscdb");
    const db = new Database(dbPath);
    db.run("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT, value TEXT)");
    db.close();

    const mod = await import("../index");
    const { discoverWorkspaces } = mod;
    const workspaces = discoverWorkspaces(cursorBase);

    const globalWs = workspaces.find((w: any) => w.dbPath === dbPath);
    expect(globalWs).toBeDefined();
    expect(globalWs!.path).toBe(globalDir);
  });

  it("discovers log files in logs directory", async () => {
    testDir = setupTestDir();
    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");

    // Create logs directory
    const logsDir = join(cursorBase, "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, "chat-2026.jsonl"), "{}", "utf-8");
    writeFileSync(join(logsDir, "debug.log"), "log content", "utf-8");

    const mod = await import("../index");
    const { discoverWorkspaces } = mod;
    const workspaces = discoverWorkspaces(cursorBase);

    const logWorkspaces = workspaces.filter((w: any) => w.logPath !== null);
    expect(logWorkspaces.length).toBeGreaterThanOrEqual(2);
    expect(logWorkspaces.some((w: any) => w.logPath!.endsWith(".jsonl"))).toBe(true);
    expect(logWorkspaces.some((w: any) => w.logPath!.endsWith(".log"))).toBe(true);
  });

  it("skips non-directory entries in workspaceStorage", async () => {
    testDir = setupTestDir();
    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");

    const wsDir = join(cursorBase, "User", "workspaceStorage");
    mkdirSync(wsDir, { recursive: true });
    // Create a file (not directory) — should be skipped
    writeFileSync(join(wsDir, "not-a-dir"), "file", "utf-8");

    const mod = await import("../index");
    const { discoverWorkspaces } = mod;
    const workspaces = discoverWorkspaces(cursorBase);

    // Only the "not-a-dir" file exists, no real workspace dirs
    expect(workspaces.filter((w: any) => w.dbPath !== null).length).toBe(0);
  });
});

// ── State DB Extraction ──────────────────────────────────────────

describe("State DB Extraction", () => {
  let testDir: string;

  afterEach(() => {
    if (testDir) {
      try { rmSync(testDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("handles missing ItemTable gracefully", async () => {
    testDir = setupTestDir();
    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");

    // Create workspace with state.vscdb that has no ItemTable
    const wsDir = join(cursorBase, "User", "workspaceStorage", "no-table");
    mkdirSync(wsDir, { recursive: true });
    const dbPath = join(wsDir, "state.vscdb");
    const db = new Database(dbPath);
    db.run("CREATE TABLE other_table (id INTEGER)");
    db.close();

    const mod = await import("../index");
    const { createCursorHarvester } = mod;
    const hooks: any = {
      hook: () => {},
      callHook: async () => {},
      getHandlers: () => [],
    };

    const harvester = createCursorHarvester(hooks, { basePath: cursorBase });
    const results = await harvester.poll();
    expect(Array.isArray(results)).toBe(true);
  });

  it("handles empty SQLite database without crash", async () => {
    testDir = setupTestDir();
    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");

    // Create workspace with empty state.vscdb
    const wsDir = join(cursorBase, "User", "workspaceStorage", "empty-db");
    mkdirSync(wsDir, { recursive: true });
    const dbPath = join(wsDir, "state.vscdb");
    const db = new Database(dbPath);
    db.run("CREATE TABLE ItemTable (key TEXT, value TEXT)");
    db.close();

    const mod = await import("../index");
    const { createCursorHarvester } = mod;
    const hooks: any = {
      hook: () => {},
      callHook: async () => {},
      getHandlers: () => [],
    };

    const harvester = createCursorHarvester(hooks, { basePath: cursorBase });
    const results = await harvester.poll();
    expect(Array.isArray(results)).toBe(true);
  });

  // Full integration test for actual chat data extraction is in the
  // Harvester Integration describe block below — uses basePath override.
});

// ── Workspace Detection ──────────────────────────────────────────

describe("Workspace Detection", () => {
  let testDir: string;

  afterEach(() => {
    if (testDir) {
      try { rmSync(testDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("parses workspace.json with file:// URI", async () => {
    testDir = setupTestDir();
    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");

    const wsDir = join(cursorBase, "User", "workspaceStorage", "uri-ws");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(
      join(wsDir, "workspace.json"),
      JSON.stringify({ folder: "file:///home/dev/project-alpha" }),
      "utf-8",
    );

    // Create valid state.vscdb
    const dbPath = join(wsDir, "state.vscdb");
    const db = new Database(dbPath);
    db.run("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT, value TEXT)");
    db.close();

    const mod = await import("../index");
    const { discoverWorkspaces } = mod;
    const workspaces = discoverWorkspaces(cursorBase);
    const ws = workspaces.find((w: any) => w.path === wsDir);
    expect(ws).toBeDefined();
    expect(ws!.projectFolder).toContain("project-alpha");
  });

  it("handles missing workspace.json gracefully", async () => {
    testDir = setupTestDir();
    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");

    // Workspace WITHOUT workspace.json
    const wsDir = join(cursorBase, "User", "workspaceStorage", "no-wsjson");
    mkdirSync(wsDir, { recursive: true });
    const dbPath = join(wsDir, "state.vscdb");
    const db = new Database(dbPath);
    db.run("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT, value TEXT)");
    db.close();

    const mod = await import("../index");
    const { discoverWorkspaces } = mod;
    const workspaces = discoverWorkspaces(cursorBase);
    const ws = workspaces.find((w: any) => w.path === wsDir);
    expect(ws).toBeDefined();
    expect(ws!.projectFolder).toBeUndefined();
    expect(ws!.projectName).toBeUndefined();
  });

  it("handles malformed workspace.json", async () => {
    testDir = setupTestDir();
    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");

    const wsDir = join(cursorBase, "User", "workspaceStorage", "bad-wsjson");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "workspace.json"), "{invalid json!!!", "utf-8");

    // Create valid state.vscdb
    const dbPath = join(wsDir, "state.vscdb");
    const db = new Database(dbPath);
    db.run("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT, value TEXT)");
    db.close();

    const mod = await import("../index");
    const { discoverWorkspaces } = mod;

    // Should not throw
    const workspaces = discoverWorkspaces(cursorBase);
    expect(workspaces.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Harvester Integration ─────────────────────────────────────────

describe("Harvester Integration", () => {
  let testDir: string;

  afterEach(() => {
    if (testDir) {
      try { rmSync(testDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("handles missing Cursor directory gracefully", async () => {
    testDir = setupTestDir();
    const nonexistentPath = join(testDir, "nonexistent");

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

    const harvester = createCursorHarvester(hooks, {
      basePath: nonexistentPath,
    });

    // Poll should emit error and return empty array for missing dir
    const results = await harvester.poll();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
    const errorCalls = calls.filter((c) => c.event === "plugin:error");
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts chat entries with basePath override", async () => {
    testDir = setupTestDir();
    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");

    // Create workspace with state.vscdb containing chat data
    const wsDir = join(cursorBase, "User", "workspaceStorage", "with-chat");
    mkdirSync(wsDir, { recursive: true });
    const dbPath = join(wsDir, "state.vscdb");
    const db = new Database(dbPath);
    db.run("CREATE TABLE ItemTable (key TEXT, value TEXT)");

    const chatEntry = {
      id: "chat-1",
      sessionId: "session-abc",
      timestamp: Date.now(),
      messages: [
        { role: "user", content: "Hello, help me with TypeScript" },
        { role: "assistant", content: "Sure! What's the issue?" },
      ],
    };
    db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [
      "workbench.panel.aichat.view.aichat.chatdata",
      JSON.stringify(chatEntry),
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
  });

  it("start and stop don't crash", async () => {
    testDir = setupTestDir();

    const mod = await import("../index");
    const { createCursorHarvester } = mod;
    const hooks: any = {
      hook: () => {},
      callHook: async () => {},
      getHandlers: () => [],
    };

    const harvester = createCursorHarvester(hooks, {
      basePath: join(testDir, "nonexistent"),
      pollIntervalMs: 100,
    });

    // Start and immediately stop — no crash
    await harvester.start();
    await new Promise((r) => setTimeout(r, 50));
    await harvester.stop();
    expect(true).toBe(true);
  });
});

// ── Agent Transcripts Extraction ─────────────────────────────

describe("Agent Transcripts (Cursor v3+)", () => {
  let testDir: string;

  afterEach(() => {
    if (testDir) {
      try { rmSync(testDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("extracts interactions from agent-transcripts JSONL", async () => {
    testDir = setupTestDir();
    const homeDir = testDir;

    // Create ~/.cursor/projects/<slug>/agent-transcripts/
    const projectDir = join(homeDir, ".cursor", "projects", "test-slug");
    const transcriptsDir = join(projectDir, "agent-transcripts");
    mkdirSync(transcriptsDir, { recursive: true });

    const now = Date.now();
    const sessionFile = join(transcriptsDir, "session.jsonl");
    // JSONL format: one JSON object per line
    writeFileSync(sessionFile, 
      JSON.stringify({
        sessionId: "v3-session",
        timestamp: now,
        messages: [
          { role: "user", content: "Agent transcript prompt" },
          { role: "assistant", content: "Agent transcript response" },
        ],
      }) + "\n",
      "utf-8"
    );

    // Create a Cursor base path so the harvester doesn't bail
    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");
    mkdirSync(cursorBase, { recursive: true });
    // Also create workspaceStorage to avoid the empty workspaces bail
    const wsDir = join(cursorBase, "User", "workspaceStorage", "v3-ws");
    mkdirSync(wsDir, { recursive: true });

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

    const harvester = createCursorHarvester(hooks, {
      basePath: cursorBase,
      homeDir,  // KEY: inject homeDir for test isolation
    });
    await harvester.poll();

    const interactionCalls = calls.filter((c) => c.event === "onInteraction");
    expect(interactionCalls.length).toBeGreaterThanOrEqual(1);

    const ctx = interactionCalls[0].args[0] as any;
    expect(ctx.interaction.prompt).toBe("Agent transcript prompt");
    expect(ctx.interaction.response).toBe("Agent transcript response");
    expect(ctx.interaction.metadata.project).toBe("test-slug");
  });
});

// ── AI Tracking Extraction ───────────────────────────────────

describe("AI Tracking (Cursor v3+)", () => {
  let testDir: string;

  afterEach(() => {
    if (testDir) {
      try { rmSync(testDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("extracts from ai-code-tracking.db", async () => {
    testDir = setupTestDir();
    const homeDir = testDir;

    // Create ~/.cursor/ai-tracking/ai-code-tracking.db
    const trackingDir = join(homeDir, ".cursor", "ai-tracking");
    mkdirSync(trackingDir, { recursive: true });
    const dbPath = join(trackingDir, "ai-code-tracking.db");

    const now = Date.now();
    const db = new Database(dbPath);
    // conversation_summaries table
    db.run(`CREATE TABLE IF NOT EXISTS conversation_summaries (
      conversationId TEXT PRIMARY KEY,
      title TEXT,
      tldr TEXT,
      overview TEXT,
      model TEXT,
      mode TEXT,
      updatedAt INTEGER
    )`);
    db.run(`INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?)`, [
      "conv-1", "Test conversation", "Quick summary", "Full overview of the chat",
      "claude-sonnet-4", "agent", now,
    ]);
    db.close();

    // Create a Cursor base path + workspace
    const cursorBase = join(testDir, "Library", "Application Support", "Cursor");
    mkdirSync(cursorBase, { recursive: true });
    const wsDir = join(cursorBase, "User", "workspaceStorage", "track-ws");
    mkdirSync(wsDir, { recursive: true });

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

    const harvester = createCursorHarvester(hooks, {
      basePath: cursorBase,
      homeDir,
    });
    await harvester.poll();

    const interactionCalls = calls.filter((c) => c.event === "onInteraction");
    // AI tracking entries should produce interactions
    expect(interactionCalls.length).toBeGreaterThanOrEqual(1);

    const ctx = interactionCalls[0].args[0] as any;
    expect(ctx.interaction.prompt).toBe("Test conversation");
    expect(ctx.interaction.metadata.conversationId).toBe("conv-1");
  });
});

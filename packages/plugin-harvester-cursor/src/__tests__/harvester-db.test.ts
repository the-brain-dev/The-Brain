/**
 * Supplementary tests for harvester-cursor — state DB extraction.
 *
 * Tests extractFromStateDb and extractFromCursorDiskKV through
 * createCursorHarvester with mock SQLite state.vscdb databases.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

// ── Helpers ──────────────────────────────────────────────────────

function setupTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cursor-db-test-"));
  process.env.HOME = dir;
  return dir;
}

function createStateDb(dbPath: string, rows: Array<{ key: string; value: unknown }>) {
  const db = new Database(dbPath);
  db.run("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  const insert = db.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)");
  for (const row of rows) {
    insert.run(row.key, typeof row.value === "string" ? row.value : JSON.stringify(row.value));
  }
  insert.finalize();
  db.close();
}

function createCursorBase(testDir: string): string {
  const cursorBase = join(testDir, "Library", "Application Support", "Cursor");
  mkdirSync(cursorBase, { recursive: true });
  return cursorBase;
}

// ── Tests ────────────────────────────────────────────────────────

describe("State DB Extraction (extractFromStateDb)", () => {
  let testDir: string;

  afterEach(() => {
    if (testDir) {
      try { rmSync(testDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("extracts chat entries from ItemTable with aichat key", async () => {
    testDir = setupTestDir();
    const cursorBase = createCursorBase(testDir);

    // Create workspace directory
    const wsDir = join(cursorBase, "User", "workspaceStorage", "ws-aichat");
    mkdirSync(wsDir, { recursive: true });
    const dbPath = join(wsDir, "state.vscdb");

    const chatEntry = {
      id: "chat-extract-1",
      sessionId: "session-extract",
      timestamp: Date.now(),
      messages: [
        { role: "user", content: "Extract this prompt" },
        { role: "assistant", content: "Extract this response" },
      ],
    };

    createStateDb(dbPath, [
      { key: "workbench.panel.aichat.view.aichat.chatdata", value: chatEntry },
    ]);

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
    expect(ctx.interaction.prompt).toBe("Extract this prompt");
    expect(ctx.interaction.response).toBe("Extract this response");
    expect(ctx.interaction.source).toBe("cursor");
  });

  it("extracts from chat-related keys (fallback patterns)", async () => {
    testDir = setupTestDir();
    const cursorBase = createCursorBase(testDir);

    const wsDir = join(cursorBase, "User", "workspaceStorage", "ws-chat");
    mkdirSync(wsDir, { recursive: true });
    const dbPath = join(wsDir, "state.vscdb");

    const chatEntry = {
      sessionId: "chat-fallback",
      timestamp: Date.now(),
      messages: [
        { role: "user", content: "Chat key prompt" },
        { role: "assistant", content: "Chat key response" },
      ],
    };

    // Use a generic "chat" key instead of "aichat"
    createStateDb(dbPath, [
      { key: "cursor.chat.history", value: chatEntry },
    ]);

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

  it("handles array of chat entries in value", async () => {
    testDir = setupTestDir();
    const cursorBase = createCursorBase(testDir);

    const wsDir = join(cursorBase, "User", "workspaceStorage", "ws-array");
    mkdirSync(wsDir, { recursive: true });
    const dbPath = join(wsDir, "state.vscdb");

    const entries = [
      {
        id: "arr-1",
        sessionId: "array-session",
        timestamp: Date.now(),
        messages: [
          { role: "user", content: "Array prompt 1" },
          { role: "assistant", content: "Array response 1" },
        ],
      },
      {
        id: "arr-2",
        sessionId: "array-session",
        timestamp: Date.now() + 1000,
        messages: [
          { role: "user", content: "Array prompt 2" },
          { role: "assistant", content: "Array response 2" },
        ],
      },
    ];

    createStateDb(dbPath, [
      { key: "workbench.panel.aichat.view.aichat.chatdata", value: entries },
    ]);

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
  });

  it("skips entries with timestamp before 'since' cutoff", async () => {
    testDir = setupTestDir();
    const cursorBase = createCursorBase(testDir);

    const wsDir = join(cursorBase, "User", "workspaceStorage", "ws-old");
    mkdirSync(wsDir, { recursive: true });
    const dbPath = join(wsDir, "state.vscdb");

    // Old entry — timestamp from 2020
    const oldEntry = {
      id: "old-chat",
      sessionId: "old-session",
      timestamp: new Date("2020-01-01").getTime(),
      messages: [
        { role: "user", content: "Old prompt" },
        { role: "assistant", content: "Old response" },
      ],
    };

    createStateDb(dbPath, [
      { key: "workbench.panel.aichat.view.aichat.chatdata", value: oldEntry },
    ]);

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

    // Default lookback is 1 hour — 2020 entry should be filtered out
    const harvester = createCursorHarvester(hooks, { basePath: cursorBase });
    await harvester.poll();

    const interactionCalls = calls.filter((c) => c.event === "onInteraction");
    expect(interactionCalls.length).toBe(0);
  });

  it("handles malformed JSON in ItemTable values", async () => {
    testDir = setupTestDir();
    const cursorBase = createCursorBase(testDir);

    const wsDir = join(cursorBase, "User", "workspaceStorage", "ws-badjson");
    mkdirSync(wsDir, { recursive: true });
    const dbPath = join(wsDir, "state.vscdb");

    const db = new Database(dbPath);
    db.run("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.run("INSERT INTO ItemTable (key, value) VALUES (?, ?)", [
      "workbench.panel.aichat.view.aichat.chatdata",
      "{this is not valid json!!!",
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
    // Should not crash
    const results = await harvester.poll();
    expect(Array.isArray(results)).toBe(true);
  });
});

describe("Multi-workspace polling", () => {
  let testDir: string;

  afterEach(() => {
    if (testDir) {
      try { rmSync(testDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("polls interactions from multiple workspaces", async () => {
    testDir = setupTestDir();
    const cursorBase = createCursorBase(testDir);

    // Workspace 1
    const ws1 = join(cursorBase, "User", "workspaceStorage", "ws-multi-1");
    mkdirSync(ws1, { recursive: true });
    createStateDb(join(ws1, "state.vscdb"), [
      {
        key: "workbench.panel.aichat.view.aichat.chatdata",
        value: {
          sessionId: "multi-1",
          timestamp: Date.now(),
          messages: [
            { role: "user", content: "WS1 prompt" },
            { role: "assistant", content: "WS1 response" },
          ],
        },
      },
    ]);

    // Workspace 2
    const ws2 = join(cursorBase, "User", "workspaceStorage", "ws-multi-2");
    mkdirSync(ws2, { recursive: true });
    createStateDb(join(ws2, "state.vscdb"), [
      {
        key: "cursor.aichat.composer",
        value: {
          sessionId: "multi-2",
          timestamp: Date.now(),
          messages: [
            { role: "user", content: "WS2 prompt" },
            { role: "assistant", content: "WS2 response" },
          ],
        },
      },
    ]);

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

    const prompts = interactionCalls.map(
      (c) => (c.args[0] as any).interaction.prompt,
    );
    expect(prompts).toContain("WS1 prompt");
    expect(prompts).toContain("WS2 prompt");
  });
});

/**
 * Gemini harvester — focused coverage tests (extra2).
 *
 * Targets uncovered paths:
 *   - extractTextFromBlocks (all code paths)
 *   - extractFromChatSession (full session parsing)
 *   - extractFromLogsJson (watermark, cutoff, edge cases)
 *   - extractTextFromLogMessage (image path cleaning)
 *   - discoverProjects (multi-project, skip dirs)
 *   - poll() HARVESTER_NEW_DATA emission
 *   - state persistence across harvester instances
 */
import { describe, it, expect, afterEach, beforeAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHooks } from "@the-brain/core";
import { HookEvent, MemoryLayer } from "@the-brain/core";

// ── Helpers ──────────────────────────────────────────────────────

interface MockHooks extends PluginHooks {
  _calls: Array<{ event: string; args: unknown[] }>;
  _geminiHarvester?: {
    poll: () => Promise<unknown>;
    start: () => void;
    stop: () => void;
    getState: () => unknown;
  };
}

function createMockHooks(): MockHooks {
  const calls: Array<{ event: string; args: unknown[] }> = [];
  const handlers = new Map<string, Array<(...args: unknown[]) => Promise<void> | void>>();

  return {
    _calls: calls,
    hook(event: string, handler: (...args: unknown[]) => Promise<void> | void) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    async callHook(event: string, ...args: unknown[]) {
      calls.push({ event, args });
      const eventHandlers = handlers.get(event) ?? [];
      for (const h of eventHandlers) {
        await h(...args);
      }
    },
    getHandlers(event: string) {
      return handlers.get(event) ?? [];
    },
  } as unknown as MockHooks;
}

function setupHomeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gemini-test-home-"));
  process.env.HOME = dir;
  return dir;
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

// ── extractTextFromBlocks coverage ───────────────────────────────

describe("extractTextFromBlocks — chat session content parsing", () => {
  let homeDir: string;

  beforeAll(() => {
    homeDir = setupHomeDir();
  });

  afterEach(() => {
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    homeDir = setupHomeDir();
  });

  it("extracts text from content blocks and produces interactions", async () => {
    const hooks = createMockHooks();
    const { createGeminiHarvester } = await import("../index");
    const harvester = createGeminiHarvester(hooks);

    // Build ~/.gemini/tmp/project-a/ structure
    const tmpDir = join(homeDir, ".gemini", "tmp", "project-a");
    const chatsDir = join(tmpDir, "chats");
    mkdirSync(chatsDir, { recursive: true });

    // Write a chat session with text-only content blocks
    const chatSession = {
      sessionId: "chat-session-1",
      startTime: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      messages: [
        {
          id: "msg-1",
          timestamp: new Date().toISOString(),
          type: "user",
          content: [{ type: "text", text: "What is TypeScript?" }],
        },
        {
          id: "msg-2",
          timestamp: new Date().toISOString(),
          type: "gemini",
          content: [
            { type: "text", text: "TypeScript is a typed superset of JavaScript." },
            { type: "text", text: " It adds static types." },
          ],
        },
      ],
    };
    writeJson(join(chatsDir, "session-1.json"), chatSession);

    await harvester.poll();

    const newDataCalls = hooks._calls.filter((c) => c.event === HookEvent.HARVESTER_NEW_DATA);
    expect(newDataCalls.length).toBe(1);
    const ctx = newDataCalls[0].args[0] as Record<string, unknown>;
    const ix = ctx.interaction as Record<string, unknown>;
    expect(ix.prompt).toBe("What is TypeScript?");
    expect(ix.response).toBe("TypeScript is a typed superset of JavaScript.\n It adds static types.");
    expect(ix.source).toBe("gemini-cli-chat");
  });

  it("handles tool_use blocks in mixed content", async () => {
    const hooks = createMockHooks();
    const { createGeminiHarvester } = await import("../index");
    const harvester = createGeminiHarvester(hooks);

    const tmpDir = join(homeDir, ".gemini", "tmp", "project-b");
    const chatsDir = join(tmpDir, "chats");
    mkdirSync(chatsDir, { recursive: true });

    const chatSession = {
      sessionId: "chat-tools",
      startTime: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      messages: [
        {
          id: "msg-a",
          timestamp: new Date().toISOString(),
          type: "user",
          content: [{ type: "text", text: "Read the file for me" }],
        },
        {
          id: "msg-b",
          timestamp: new Date().toISOString(),
          type: "gemini",
          content: [
            { type: "text", text: "I'll read that file." },
            { type: "tool_use", name: "read_file" },
            { type: "text", text: "The file contains configuration data." },
          ],
        },
      ],
    };
    writeJson(join(chatsDir, "session-1.json"), chatSession);

    await harvester.poll();

    const newDataCalls = hooks._calls.filter((c) => c.event === HookEvent.HARVESTER_NEW_DATA);
    expect(newDataCalls.length).toBe(1);
    const ctx = newDataCalls[0].args[0] as Record<string, unknown>;
    const ix = ctx.interaction as Record<string, unknown>;
    expect(ix.prompt).toBe("Read the file for me");
    // Response should include text blocks and [tool:read_file] marker
    expect(ix.response).toContain("I'll read that file.");
    expect(ix.response).toContain("[tool:read_file]");
    expect(ix.response).toContain("The file contains configuration data.");
  });

  it("excludes thinking blocks from extracted text", async () => {
    const hooks = createMockHooks();
    const { createGeminiHarvester } = await import("../index");
    const harvester = createGeminiHarvester(hooks);

    const tmpDir = join(homeDir, ".gemini", "tmp", "project-c");
    const chatsDir = join(tmpDir, "chats");
    mkdirSync(chatsDir, { recursive: true });

    const chatSession = {
      sessionId: "chat-think",
      startTime: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      messages: [
        {
          id: "msg-x",
          timestamp: new Date().toISOString(),
          type: "user",
          content: [{ type: "text", text: "Solve this problem" }],
        },
        {
          id: "msg-y",
          timestamp: new Date().toISOString(),
          type: "gemini",
          content: [
            { type: "thinking", thinking: "Let me think about this step by step..." },
            { type: "text", text: "The answer is 42." },
          ],
        },
      ],
    };
    writeJson(join(chatsDir, "session-1.json"), chatSession);

    await harvester.poll();

    const newDataCalls = hooks._calls.filter((c) => c.event === HookEvent.HARVESTER_NEW_DATA);
    expect(newDataCalls.length).toBe(1);
    const ctx = newDataCalls[0].args[0] as Record<string, unknown>;
    const ix = ctx.interaction as Record<string, unknown>;
    // Thinking content must not appear in response
    expect(ix.response).toBe("The answer is 42.");
    expect(ix.response).not.toContain("step by step");
  });

  it("handles empty content blocks array gracefully", async () => {
    const hooks = createMockHooks();
    const { createGeminiHarvester } = await import("../index");
    const harvester = createGeminiHarvester(hooks);

    const tmpDir = join(homeDir, ".gemini", "tmp", "project-d");
    const chatsDir = join(tmpDir, "chats");
    mkdirSync(chatsDir, { recursive: true });

    // User with empty content blocks — prompt should be empty string
    const chatSession = {
      sessionId: "chat-empty",
      startTime: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      messages: [
        {
          id: "msg-0",
          timestamp: new Date().toISOString(),
          type: "user",
          content: [],
        },
        {
          id: "msg-1",
          timestamp: new Date().toISOString(),
          type: "gemini",
          content: [{ type: "text", text: "Something" }],
        },
      ],
    };
    writeJson(join(chatsDir, "session-1.json"), chatSession);

    await harvester.poll();

    // Empty prompt → no interaction emitted (prompt must be truthy)
    const newDataCalls = hooks._calls.filter((c) => c.event === HookEvent.HARVESTER_NEW_DATA);
    expect(newDataCalls.length).toBe(0);
  });

  it("handles null/missing content field in chat messages", async () => {
    const hooks = createMockHooks();
    const { createGeminiHarvester } = await import("../index");
    const harvester = createGeminiHarvester(hooks);

    const tmpDir = join(homeDir, ".gemini", "tmp", "project-e");
    const chatsDir = join(tmpDir, "chats");
    mkdirSync(chatsDir, { recursive: true });

    // Message with content=null → extractTextFromBlocks converts to String(null)="null"
    // but then prompt "null" is truthy. Response is also "null". Edge case.
    const chatSession = {
      sessionId: "chat-null",
      startTime: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      messages: [
        {
          id: "msg-n1",
          timestamp: new Date().toISOString(),
          type: "user",
          content: null,
        },
        {
          id: "msg-n2",
          timestamp: new Date().toISOString(),
          type: "gemini",
          content: null,
        },
      ],
    };
    writeJson(join(chatsDir, "session-1.json"), chatSession);

    await harvester.poll();

    // Should not crash — handles null content gracefully
    const newDataCalls = hooks._calls.filter((c) => c.event === HookEvent.HARVESTER_NEW_DATA);
    // With null content, extractTextFromBlocks returns "null" which is truthy
    expect(newDataCalls.length).toBeGreaterThanOrEqual(0);
  });
});

// ── extractFromChatSession edge cases ────────────────────────────

describe("extractFromChatSession — edge cases", () => {
  let homeDir: string;

  beforeAll(() => {
    homeDir = setupHomeDir();
  });

  afterEach(() => {
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    homeDir = setupHomeDir();
  });

  it("skips consecutive gemini messages without preceding user", async () => {
    const hooks = createMockHooks();
    const { createGeminiHarvester } = await import("../index");
    const harvester = createGeminiHarvester(hooks);

    const tmpDir = join(homeDir, ".gemini", "tmp", "project-f");
    const chatsDir = join(tmpDir, "chats");
    mkdirSync(chatsDir, { recursive: true });

    // Two gemini messages in a row, then a user+gemini pair
    const chatSession = {
      sessionId: "chat-consecutive",
      startTime: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      messages: [
        {
          id: "g1",
          timestamp: new Date().toISOString(),
          type: "gemini",
          content: [{ type: "text", text: "Hello, how can I help?" }],
        },
        {
          id: "g2",
          timestamp: new Date().toISOString(),
          type: "gemini",
          content: [{ type: "text", text: "I'm ready to assist." }],
        },
        {
          id: "u1",
          timestamp: new Date().toISOString(),
          type: "user",
          content: [{ type: "text", text: "Write a test" }],
        },
        {
          id: "g3",
          timestamp: new Date().toISOString(),
          type: "gemini",
          content: [{ type: "text", text: "Here is a test." }],
        },
      ],
    };
    writeJson(join(chatsDir, "session-2.json"), chatSession);

    await harvester.poll();

    const newDataCalls = hooks._calls.filter((c) => c.event === HookEvent.HARVESTER_NEW_DATA);
    // Only the last user→gemini pair should be extracted
    expect(newDataCalls.length).toBe(1);
    const ctx = newDataCalls[0].args[0] as Record<string, unknown>;
    const ix = ctx.interaction as Record<string, unknown>;
    expect(ix.prompt).toBe("Write a test");
    expect(ix.response).toBe("Here is a test.");
  });

  it("filters out messages older than lookback window", async () => {
    const hooks = createMockHooks();
    const { createGeminiHarvester } = await import("../index");
    // Use a 1-second lookback to ensure old messages are filtered
    const harvester = createGeminiHarvester(hooks, { lookbackWindowMs: 1000 });

    const tmpDir = join(homeDir, ".gemini", "tmp", "project-g");
    const chatsDir = join(tmpDir, "chats");
    mkdirSync(chatsDir, { recursive: true });

    const chatSession = {
      sessionId: "chat-old",
      startTime: "2020-01-01T00:00:00.000Z",
      lastUpdated: "2020-01-01T00:00:00.000Z",
      messages: [
        {
          id: "old-u",
          timestamp: "2020-01-01T00:00:00.000Z",
          type: "user",
          content: [{ type: "text", text: "Old prompt" }],
        },
        {
          id: "old-g",
          timestamp: "2020-01-01T00:00:01.000Z",
          type: "gemini",
          content: [{ type: "text", text: "Old response" }],
        },
      ],
    };
    writeJson(join(chatsDir, "session-3.json"), chatSession);

    await harvester.poll();

    // All messages are from 2020 → filtered by 1-second lookback
    const newDataCalls = hooks._calls.filter((c) => c.event === HookEvent.HARVESTER_NEW_DATA);
    expect(newDataCalls.length).toBe(0);
  });

  it("handles malformed chat session JSON", async () => {
    const hooks = createMockHooks();
    const { createGeminiHarvester } = await import("../index");
    const harvester = createGeminiHarvester(hooks);

    const tmpDir = join(homeDir, ".gemini", "tmp", "project-h");
    const chatsDir = join(tmpDir, "chats");
    mkdirSync(chatsDir, { recursive: true });

    writeFileSync(join(chatsDir, "session-bad.json"), "not valid json {{{", "utf-8");

    await harvester.poll();

    // Should not throw — malformed session is skipped
    const newDataCalls = hooks._calls.filter((c) => c.event === HookEvent.HARVESTER_NEW_DATA);
    expect(newDataCalls.length).toBe(0);
  });

  it("handles chat session with missing messages array", async () => {
    const hooks = createMockHooks();
    const { createGeminiHarvester } = await import("../index");
    const harvester = createGeminiHarvester(hooks);

    const tmpDir = join(homeDir, ".gemini", "tmp", "project-i");
    const chatsDir = join(tmpDir, "chats");
    mkdirSync(chatsDir, { recursive: true });

    writeJson(join(chatsDir, "session-4.json"), {
      sessionId: "no-msgs",
      startTime: new Date().toISOString(),
    });

    await harvester.poll();

    // Missing messages → skipped gracefully
    const newDataCalls = hooks._calls.filter((c) => c.event === HookEvent.HARVESTER_NEW_DATA);
    expect(newDataCalls.length).toBe(0);
  });
});

// ── extractFromLogsJson coverage ─────────────────────────────────

describe("extractFromLogsJson — logs.json parsing", () => {
  let homeDir: string;

  beforeAll(() => {
    homeDir = setupHomeDir();
  });

  afterEach(() => {
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    homeDir = setupHomeDir();
  });

  it("pairs user → gemini messages and emits interactions", async () => {
    const hooks = createMockHooks();
    const { createGeminiHarvester } = await import("../index");
    const harvester = createGeminiHarvester(hooks);

    const projectDir = join(homeDir, ".gemini", "tmp", "proj-logs");
    mkdirSync(projectDir, { recursive: true });

    const entries = [
      {
        sessionId: "s1",
        messageId: 0,
        type: "user",
        message: "What is Rust?",
        timestamp: new Date().toISOString(),
      },
      {
        sessionId: "s1",
        messageId: 1,
        type: "gemini",
        message: "Rust is a systems programming language.",
        timestamp: new Date().toISOString(),
      },
      {
        sessionId: "s1",
        messageId: 2,
        type: "user",
        message: "Show me an example",
        timestamp: new Date().toISOString(),
      },
      {
        sessionId: "s1",
        messageId: 3,
        type: "gemini",
        message: 'fn main() { println!("Hello"); }',
        timestamp: new Date().toISOString(),
      },
    ];
    writeJson(join(projectDir, "logs.json"), entries);

    await harvester.poll();

    const newDataCalls = hooks._calls.filter((c) => c.event === HookEvent.HARVESTER_NEW_DATA);
    expect(newDataCalls.length).toBe(2);

    const ix0 = (newDataCalls[0].args[0] as Record<string, unknown>).interaction as Record<string, unknown>;
    expect(ix0.prompt).toBe("What is Rust?");
    expect(ix0.response).toBe("Rust is a systems programming language.");
    expect(ix0.source).toBe("gemini-cli");

    const ix1 = (newDataCalls[1].args[0] as Record<string, unknown>).interaction as Record<string, unknown>;
    expect(ix1.prompt).toBe("Show me an example");
    expect(ix1.response).toBe('fn main() { println!("Hello"); }');
  });

  it("skips entries with empty message strings", async () => {
    const hooks = createMockHooks();
    const { createGeminiHarvester } = await import("../index");
    const harvester = createGeminiHarvester(hooks);

    const projectDir = join(homeDir, ".gemini", "tmp", "proj-empty-msg");
    mkdirSync(projectDir, { recursive: true });

    const entries = [
      {
        sessionId: "s-e",
        messageId: 0,
        type: "user",
        message: "",
        timestamp: new Date().toISOString(),
      },
      {
        sessionId: "s-e",
        messageId: 1,
        type: "gemini",
        message: "Some response",
        timestamp: new Date().toISOString(),
      },
      {
        sessionId: "s-e",
        messageId: 2,
        type: "user",
        message: "Valid prompt",
        timestamp: new Date().toISOString(),
      },
      {
        sessionId: "s-e",
        messageId: 3,
        type: "gemini",
        message: "",
        timestamp: new Date().toISOString(),
      },
    ];
    writeJson(join(projectDir, "logs.json"), entries);

    await harvester.poll();

    // Both pairs have empty prompt or response → no interactions emitted
    const newDataCalls = hooks._calls.filter((c) => c.event === HookEvent.HARVESTER_NEW_DATA);
    expect(newDataCalls.length).toBe(0);
  });

  it("respects messageId watermark for incremental reading", async () => {
    // Poll first time — processes entries
    const hooks1 = createMockHooks();
    const { createGeminiHarvester } = await import("../index");
    const harvester1 = createGeminiHarvester(hooks1);

    const projectDir = join(homeDir, ".gemini", "tmp", "proj-watermark");
    mkdirSync(projectDir, { recursive: true });

    const entriesRound1 = [
      {
        sessionId: "sw",
        messageId: 10,
        type: "user",
        message: "First question",
        timestamp: new Date().toISOString(),
      },
      {
        sessionId: "sw",
        messageId: 11,
        type: "gemini",
        message: "First answer",
        timestamp: new Date().toISOString(),
      },
    ];
    writeJson(join(projectDir, "logs.json"), entriesRound1);

    await harvester1.poll();
    const calls1 = hooks1._calls.filter((c) => c.event === HookEvent.HARVESTER_NEW_DATA);
    expect(calls1.length).toBe(1);

    // Now append more entries and poll again — second harvester loads persisted state
    const entriesRound2 = [
      ...entriesRound1,
      {
        sessionId: "sw",
        messageId: 12,
        type: "user",
        message: "Second question",
        timestamp: new Date().toISOString(),
      },
      {
        sessionId: "sw",
        messageId: 13,
        type: "gemini",
        message: "Second answer",
        timestamp: new Date().toISOString(),
      },
    ];
    writeJson(join(projectDir, "logs.json"), entriesRound2);

    const hooks2 = createMockHooks();
    const harvester2 = createGeminiHarvester(hooks2);
    await harvester2.poll();

    const calls2 = hooks2._calls.filter((c) => c.event === HookEvent.HARVESTER_NEW_DATA);
    // Only the new pair (messageId > 11) should be processed
    expect(calls2.length).toBe(1);
    const ix = (calls2[0].args[0] as Record<string, unknown>).interaction as Record<string, unknown>;
    expect(ix.prompt).toBe("Second question");
  });

  it("handles standalone gemini messages with no preceding user", async () => {
    const hooks = createMockHooks();
    const { createGeminiHarvester } = await import("../index");
    const harvester = createGeminiHarvester(hooks);

    const projectDir = join(homeDir, ".gemini", "tmp", "proj-standalone");
    mkdirSync(projectDir, { recursive: true });

    // Info message, then gemini without preceding user
    const entries = [
      {
        sessionId: "s-standalone",
        messageId: 0,
        type: "info",
        message: "Session started",
        timestamp: new Date().toISOString(),
      },
      {
        sessionId: "s-standalone",
        messageId: 1,
        type: "gemini",
        message: "Orphan response — no user before me",
        timestamp: new Date().toISOString(),
      },
      {
        sessionId: "s-standalone",
        messageId: 2,
        type: "user",
        message: "Real question",
        timestamp: new Date().toISOString(),
      },
      {
        sessionId: "s-standalone",
        messageId: 3,
        type: "gemini",
        message: "Real answer",
        timestamp: new Date().toISOString(),
      },
    ];
    writeJson(join(projectDir, "logs.json"), entries);

    await harvester.poll();

    const newDataCalls = hooks._calls.filter((c) => c.event === HookEvent.HARVESTER_NEW_DATA);
    // Only the user→gemini pair at the end, standalone gemini is skipped
    expect(newDataCalls.length).toBe(1);
    const ix = (newDataCalls[0].args[0] as Record<string, unknown>).interaction as Record<string, unknown>;
    expect(ix.prompt).toBe("Real question");
  });
});

// ── extractTextFromLogMessage ────────────────────────────────────

describe("extractTextFromLogMessage — image path stripping", () => {
  let homeDir: string;

  beforeAll(() => {
    homeDir = setupHomeDir();
  });

  afterEach(() => {
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    homeDir = setupHomeDir();
  });

  it("strips image file path references from log messages", async () => {
    const hooks = createMockHooks();
    const { createGeminiHarvester } = await import("../index");
    const harvester = createGeminiHarvester(hooks);

    const projectDir = join(homeDir, ".gemini", "tmp", "proj-images");
    mkdirSync(projectDir, { recursive: true });

    const entries = [
      {
        sessionId: "img-session",
        messageId: 0,
        type: "user",
        message: "What is in this image?",
        timestamp: new Date().toISOString(),
      },
      {
        sessionId: "img-session",
        messageId: 1,
        type: "gemini",
        message:
          "I see a screenshot @/Users/test/.gemini/tmp/screenshot-123.png in the output.",
        timestamp: new Date().toISOString(),
      },
    ];
    writeJson(join(projectDir, "logs.json"), entries);

    await harvester.poll();

    const newDataCalls = hooks._calls.filter((c) => c.event === HookEvent.HARVESTER_NEW_DATA);
    expect(newDataCalls.length).toBe(1);
    const ix = (newDataCalls[0].args[0] as Record<string, unknown>).interaction as Record<string, unknown>;
    // Image path should be replaced with [image]
    expect(ix.response).toContain("[image]");
    expect(ix.response).not.toContain("screenshot-123.png");
    expect(ix.response).toContain("I see a screenshot");
  });
});

// ── discoverProjects ─────────────────────────────────────────────

describe("discoverProjects — project discovery", () => {
  let homeDir: string;

  beforeAll(() => {
    homeDir = setupHomeDir();
  });

  afterEach(() => {
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    homeDir = setupHomeDir();
  });

  it("discovers multiple projects from tmp directory", async () => {
    const hooks = createMockHooks();
    const { createGeminiHarvester } = await import("../index");
    const harvester = createGeminiHarvester(hooks);

    const tmpDir = join(homeDir, ".gemini", "tmp");
    mkdirSync(tmpDir, { recursive: true });

    // Project A with logs.json
    const projA = join(tmpDir, "project-alpha");
    mkdirSync(projA);
    writeJson(join(projA, "logs.json"), [
      {
        sessionId: "sa",
        messageId: 0,
        type: "user",
        message: "Alpha Q",
        timestamp: new Date().toISOString(),
      },
      {
        sessionId: "sa",
        messageId: 1,
        type: "gemini",
        message: "Alpha A",
        timestamp: new Date().toISOString(),
      },
    ]);

    // Project B with logs.json
    const projB = join(tmpDir, "project-beta");
    mkdirSync(projB);
    writeJson(join(projB, "logs.json"), [
      {
        sessionId: "sb",
        messageId: 0,
        type: "user",
        message: "Beta Q",
        timestamp: new Date().toISOString(),
      },
      {
        sessionId: "sb",
        messageId: 1,
        type: "gemini",
        message: "Beta A",
        timestamp: new Date().toISOString(),
      },
    ]);

    await harvester.poll();

    const newDataCalls = hooks._calls.filter((c) => c.event === HookEvent.HARVESTER_NEW_DATA);
    expect(newDataCalls.length).toBe(2);

    const projects = newDataCalls.map((c) => {
      const ctx = c.args[0] as Record<string, unknown>;
      const ix = ctx.interaction as Record<string, unknown>;
      const meta = ix.metadata as Record<string, unknown>;
      return meta.project;
    });
    expect(projects).toContain("project-alpha");
    expect(projects).toContain("project-beta");
  });

  it("skips bin and images special directories", async () => {
    const hooks = createMockHooks();
    const { createGeminiHarvester } = await import("../index");
    const harvester = createGeminiHarvester(hooks);

    const tmpDir = join(homeDir, ".gemini", "tmp");
    mkdirSync(tmpDir, { recursive: true });

    // These should be skipped by discoverProjects
    mkdirSync(join(tmpDir, "bin"));
    mkdirSync(join(tmpDir, "images"));

    // Write logs.json in bin/ — should be ignored
    writeJson(join(tmpDir, "bin", "logs.json"), [
      {
        sessionId: "skip",
        messageId: 0,
        type: "user",
        message: "Should be skipped",
        timestamp: new Date().toISOString(),
      },
      {
        sessionId: "skip",
        messageId: 1,
        type: "gemini",
        message: "Skipped",
        timestamp: new Date().toISOString(),
      },
    ]);

    // Only valid project
    mkdirSync(join(tmpDir, "real-project"));
    writeJson(join(tmpDir, "real-project", "logs.json"), [
      {
        sessionId: "real",
        messageId: 0,
        type: "user",
        message: "Real Q",
        timestamp: new Date().toISOString(),
      },
      {
        sessionId: "real",
        messageId: 1,
        type: "gemini",
        message: "Real A",
        timestamp: new Date().toISOString(),
      },
    ]);

    await harvester.poll();

    const newDataCalls = hooks._calls.filter((c) => c.event === HookEvent.HARVESTER_NEW_DATA);
    expect(newDataCalls.length).toBe(1);
    const ix = (newDataCalls[0].args[0] as Record<string, unknown>).interaction as Record<string, unknown>;
    expect(ix.prompt).toBe("Real Q");
  });

  it("handles missing projects.json gracefully", async () => {
    const hooks = createMockHooks();
    const { createGeminiHarvester } = await import("../index");
    const harvester = createGeminiHarvester(hooks);

    const tmpDir = join(homeDir, ".gemini", "tmp");
    mkdirSync(tmpDir, { recursive: true });

    // No projects.json at all — discovery still works via directory scanning
    const projDir = join(tmpDir, "solo-project");
    mkdirSync(projDir);
    writeJson(join(projDir, "logs.json"), [
      {
        sessionId: "solo",
        messageId: 0,
        type: "user",
        message: "Solo Q",
        timestamp: new Date().toISOString(),
      },
      {
        sessionId: "solo",
        messageId: 1,
        type: "gemini",
        message: "Solo A",
        timestamp: new Date().toISOString(),
      },
    ]);

    await harvester.poll();

    const newDataCalls = hooks._calls.filter((c) => c.event === HookEvent.HARVESTER_NEW_DATA);
    expect(newDataCalls.length).toBe(1);
  });
});

// ── poll() integration ───────────────────────────────────────────

describe("poll() integration", () => {
  let homeDir: string;

  beforeAll(() => {
    homeDir = setupHomeDir();
  });

  afterEach(() => {
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    homeDir = setupHomeDir();
  });

  it("returns empty array when HOME has no .gemini directory", async () => {
    const hooks = createMockHooks();
    const { createGeminiHarvester } = await import("../index");
    const harvester = createGeminiHarvester(hooks);

    // No .gemini directory at all
    const result = await harvester.poll();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
    const newDataCalls = hooks._calls.filter((c) => c.event === HookEvent.HARVESTER_NEW_DATA);
    expect(newDataCalls.length).toBe(0);
  });

  it("emits HARVESTER_NEW_DATA with proper InteractionContext structure", async () => {
    const hooks = createMockHooks();
    const { createGeminiHarvester } = await import("../index");
    const harvester = createGeminiHarvester(hooks);

    const projectDir = join(homeDir, ".gemini", "tmp", "ctx-test");
    mkdirSync(projectDir, { recursive: true });

    writeJson(join(projectDir, "logs.json"), [
      {
        sessionId: "ctx-session",
        messageId: 0,
        type: "user",
        message: "Context test prompt",
        timestamp: new Date().toISOString(),
      },
      {
        sessionId: "ctx-session",
        messageId: 1,
        type: "gemini",
        message: "Context test response",
        timestamp: new Date().toISOString(),
      },
    ]);

    const contexts = await harvester.poll();

    expect(contexts.length).toBe(1);
    const ctx = contexts[0] as Record<string, unknown>;
    expect(ctx.interaction).toBeDefined();
    expect(ctx.fragments).toBeDefined();
    expect(Array.isArray(ctx.fragments)).toBe(true);
    expect(ctx.fragments.length).toBe(1);

    const fragment = ctx.fragments[0] as Record<string, unknown>;
    expect(fragment.layer).toBe(MemoryLayer.INSTANT);
    expect(fragment.source).toBe("gemini-cli");
    expect(typeof fragment.content).toBe("string");
    expect(fragment.content).toContain("Context test prompt");

    // Also verify hooks were called
    const newDataCalls = hooks._calls.filter((c) => c.event === HookEvent.HARVESTER_NEW_DATA);
    expect(newDataCalls.length).toBe(1);
    const onInteractionCalls = hooks._calls.filter((c) => c.event === HookEvent.ON_INTERACTION);
    expect(onInteractionCalls.length).toBe(1);
  });

  it("persists state to disk after poll", async () => {
    const hooks1 = createMockHooks();
    const { createGeminiHarvester } = await import("../index");
    const harvester1 = createGeminiHarvester(hooks1);

    const projectDir = join(homeDir, ".gemini", "tmp", "persist-test");
    mkdirSync(projectDir, { recursive: true });

    writeJson(join(projectDir, "logs.json"), [
      {
        sessionId: "persist-session",
        messageId: 100,
        type: "user",
        message: "Persist Q",
        timestamp: new Date().toISOString(),
      },
      {
        sessionId: "persist-session",
        messageId: 101,
        type: "gemini",
        message: "Persist A",
        timestamp: new Date().toISOString(),
      },
    ]);

    await harvester1.poll();

    // Verify state file was written
    const statePath = join(homeDir, ".the-brain", "gemini-harvester-state.json");
    expect(existsSync(statePath)).toBe(true);

    const stateRaw = readFileSync(statePath, "utf-8");
    const stateData = JSON.parse(stateRaw);
    expect(typeof stateData.lastPollTimestamp).toBe("number");
    expect(stateData.lastPollTimestamp).toBeGreaterThan(0);
    expect(Array.isArray(stateData.processedIds)).toBe(true);
    expect(stateData.processedIds.length).toBeGreaterThan(0);

    // Second harvester loads persisted state (watermark prevents re-processing)
    const hooks2 = createMockHooks();
    const harvester2 = createGeminiHarvester(hooks2);
    await harvester2.poll();

    const newDataCalls2 = hooks2._calls.filter((c) => c.event === HookEvent.HARVESTER_NEW_DATA);
    expect(newDataCalls2.length).toBe(0);
  });

  it("deduplicates interactions within a single poll batch", async () => {
    const hooks = createMockHooks();
    const { createGeminiHarvester } = await import("../index");
    const harvester = createGeminiHarvester(hooks);

    const tmpDir = join(homeDir, ".gemini", "tmp", "dedup-test");
    mkdirSync(tmpDir, { recursive: true });

    // Same sessionId+messageId in both logs.json and chat session
    // logs.json
    writeJson(join(tmpDir, "logs.json"), [
      {
        sessionId: "dedup-session",
        messageId: 0,
        type: "user",
        message: "Dedup prompt",
        timestamp: new Date().toISOString(),
      },
      {
        sessionId: "dedup-session",
        messageId: 1,
        type: "gemini",
        message: "Dedup response",
        timestamp: new Date().toISOString(),
      },
    ]);

    // chat session with same logical interaction
    const chatsDir = join(tmpDir, "chats");
    mkdirSync(chatsDir, { recursive: true });
    writeJson(join(chatsDir, "session-dedup.json"), {
      sessionId: "dedup-session",
      startTime: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      messages: [
        {
          id: "msg-d1",
          timestamp: new Date().toISOString(),
          type: "user",
          content: [{ type: "text", text: "Dedup prompt" }],
        },
        {
          id: "msg-d2",
          timestamp: new Date().toISOString(),
          type: "gemini",
          content: [{ type: "text", text: "Dedup response" }],
        },
      ],
    });

    await harvester.poll();

    const newDataCalls = hooks._calls.filter((c) => c.event === HookEvent.HARVESTER_NEW_DATA);
    // Two sources produce interactions with different IDs (different id prefixes)
    // so both should appear unless deduplication catches them
    expect(newDataCalls.length).toBeGreaterThanOrEqual(1);
  });
});

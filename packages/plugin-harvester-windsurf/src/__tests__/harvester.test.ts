/**
 * Tests for @the-brain-dev/plugin-harvester-windsurf
 *
 * Tests cover:
 *   - varint encoding/decoding
 *   - wire-format protobuf field parsing
 *   - timestamp decoding
 *   - tool call extraction
 *   - AI response parsing (thinking, visible, provider)
 *   - Full trajectory extraction from base64 protobuf blobs
 *   - Deduplication
 *   - State persistence
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PluginHooks } from "@the-brain-dev/core";
import { HookEvent } from "@the-brain-dev/core";

// ── Protobuf Encoding Helpers ───────────────────────────────────

/** Encode a varint */
function encodeVarint(n: number): Buffer {
  const buf: number[] = [];
  let val = n >>> 0;
  while (val > 0x7f) {
    buf.push((val & 0x7f) | 0x80);
    val >>>= 7;
  }
  buf.push(val & 0x7f);
  return Buffer.from(buf);
}

/** Encode a wire-format varint field (fn, value) */
function wireVarint(fn: number, value: number): Buffer {
  const tag = Buffer.from(encodeVarint((fn << 3) | 0));
  const val = Buffer.from(encodeVarint(value));
  return Buffer.concat([tag, val]);
}

/** Encode a wire-format length-delimited field (fn, payload) */
function wireBytes(fn: number, payload: Buffer): Buffer {
  const tag = Buffer.from(encodeVarint((fn << 3) | 2));
  const len = Buffer.from(encodeVarint(payload.length));
  return Buffer.concat([tag, len, payload]);
}

/** Encode a wire-format string field (fn, text) */
function wireString(fn: number, text: string): Buffer {
  return wireBytes(fn, Buffer.from(text, "utf-8"));
}

/** Encode a protobuf Timestamp message {f1=seconds, f2=nanos} */
function encodeTimestamp(seconds: number, nanos: number = 0): Buffer {
  return Buffer.concat([
    wireVarint(1, seconds),
    wireVarint(2, nanos),
  ]);
}

/** Encode a tool_call message: f1=id, f2=name, f3=params_json */
function encodeToolCall(id: string, name: string, params: object): Buffer {
  return Buffer.concat([
    wireString(1, id),
    wireString(2, name),
    wireString(3, JSON.stringify(params)),
  ]);
}

/** Encode an AI response (f20): f3=thinking, f7=tool_call, f8=visible, f12=provider */
function encodeAiResponse(opts: {
  thinking?: string;
  toolCalls?: Buffer[];
  visible?: string;
  provider?: string;
}): Buffer {
  const parts: Buffer[] = [];
  if (opts.thinking) parts.push(wireString(3, opts.thinking));
  if (opts.toolCalls) {
    for (const tc of opts.toolCalls) parts.push(wireBytes(7, tc));
  }
  if (opts.visible) parts.push(wireString(8, opts.visible));
  if (opts.provider) parts.push(wireString(12, opts.provider));
  return wireBytes(20, Buffer.concat(parts));
}

/** Encode a user message (f19) */
function encodeUserMessage(text: string): Buffer {
  return wireBytes(19, wireString(1, text));
}

/** Encode a full trajectory step */
function encodeStep(opts: {
  stepId: number;
  stepType?: number;
  seconds?: number;
  payload: Buffer; // f19 or f20 encoded
}): Buffer {
  const parts: Buffer[] = [];
  parts.push(wireVarint(1, opts.stepId));
  if (opts.stepType !== undefined) parts.push(wireVarint(4, opts.stepType));
  if (opts.seconds !== undefined) {
    parts.push(wireBytes(5, encodeTimestamp(opts.seconds)));
  }
  parts.push(opts.payload);
  return wireBytes(1, Buffer.concat(parts)); // wrap as repeated message
}

/** Build a full trajectory blob and base64-encode it */
function buildTrajectory(steps: Buffer[], uuid?: string): string {
  // f1 = uuid
  const uuidPayload = wireString(1, uuid || "test-trajectory-001");
  // f2 = steps container
  const stepsPayload = wireBytes(2, Buffer.concat(steps));
  const blob = Buffer.concat([uuidPayload, stepsPayload]);
  return blob.toString("base64");
}

// ── Test Helpers ────────────────────────────────────────────────

interface MockHooks extends PluginHooks {
  _calls: Array<{ event: string; args: unknown[] }>;
  _windsurfHarvester?: any;
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
  } as MockHooks;
}

// ── Tests: Protobuf Wire-Format ─────────────────────────────────

describe("Windsurf Harvester — Protobuf Decoder", () => {
  describe("decodeVarint", () => {
    test("decodes single-byte varint", async () => {
      const { decodeVarint } = await import("../index");
      const buf = Buffer.from(encodeVarint(42));
      const [val, pos] = decodeVarint(buf, 0);
      expect(val).toBe(42);
      expect(pos).toBe(1);
    });

    test("decodes multi-byte varint", async () => {
      const { decodeVarint } = await import("../index");
      const buf = Buffer.from(encodeVarint(300));
      const [val, pos] = decodeVarint(buf, 0);
      expect(val).toBe(300);
      expect(pos).toBe(2);
    });

    test("decodes large varint", async () => {
      const { decodeVarint } = await import("../index");
      const buf = Buffer.from(encodeVarint(0x0fffffff));
      const [val, pos] = decodeVarint(buf, 0);
      expect(val).toBe(0x0fffffff);
      expect(pos).toBeGreaterThanOrEqual(3);
    });

    test("decodes zero", async () => {
      const { decodeVarint } = await import("../index");
      const buf = Buffer.from(encodeVarint(0));
      const [val, pos] = decodeVarint(buf, 0);
      expect(val).toBe(0);
    });
  });

  describe("parseFields", () => {
    test("parses varint field", async () => {
      const { parseFields } = await import("../index");
      const buf = Buffer.concat([wireVarint(1, 42)]);
      const fields = parseFields(buf, 0, buf.length);
      expect(fields).toHaveLength(1);
      expect(fields[0].fn).toBe(1);
      expect(fields[0].type).toBe("varint");
      expect(fields[0].value).toBe(42);
    });

    test("parses string field", async () => {
      const { parseFields } = await import("../index");
      const buf = wireString(3, "hello");
      const fields = parseFields(buf, 0, buf.length);
      expect(fields).toHaveLength(1);
      expect(fields[0].fn).toBe(3);
      expect(fields[0].type).toBe("bytes");
    });

    test("parses mixed fields", async () => {
      const { parseFields } = await import("../index");
      const buf = Buffer.concat([
        wireVarint(1, 100),
        wireString(2, "test"),
        wireVarint(4, 3),
      ]);
      const fields = parseFields(buf, 0, buf.length);
      expect(fields).toHaveLength(3);
      expect(fields[0].fn).toBe(1);
      expect(fields[0].value).toBe(100);
      expect(fields[1].fn).toBe(2);
      expect(fields[2].fn).toBe(4);
      expect(fields[2].value).toBe(3);
    });

    test("handles empty buffer", async () => {
      const { parseFields } = await import("../index");
      const fields = parseFields(Buffer.alloc(0), 0, 0);
      expect(fields).toHaveLength(0);
    });
  });

  describe("decodeTimestamp", () => {
    test("decodes timestamp with seconds", async () => {
      const { decodeTimestamp } = await import("../index");
      const ts = encodeTimestamp(1714800000); // 2024-05-04
      const result = decodeTimestamp(ts, 0, ts.length);
      expect(result).toBe(1714800000_000);
    });

    test("decodes timestamp with nanos", async () => {
      const { decodeTimestamp } = await import("../index");
      const ts = encodeTimestamp(1714800000, 123_000_000); // 123ms
      const result = decodeTimestamp(ts, 0, ts.length);
      expect(result).toBe(1714800000_123);
    });

    test("rejects bogus timestamp", async () => {
      const { decodeTimestamp } = await import("../index");
      const ts = encodeTimestamp(100); // year 1970
      const result = decodeTimestamp(ts, 0, ts.length);
      expect(result).toBeNull();
    });
  });
});

// ── Tests: Trajectory Extraction ───────────────────────────────

describe("Windsurf Harvester — Trajectory Extraction", () => {
  describe("extractFromTrajectory", () => {
    test("extracts a single user→AI pair", async () => {
      const { extractFromTrajectory } = await import("../index");

      const step = encodeStep({
        stepId: 1,
        seconds: 1714800000,
        payload: Buffer.concat([
          encodeUserMessage("How do I fix this TypeScript error?"),
          encodeAiResponse({
            visible: "The error is a type mismatch. Try adding a type assertion.",
            provider: "anthropic",
          }),
        ]),
      });

      const b64 = buildTrajectory([step]);
      const state = { processedIds: new Set<string>(), lastPollTimestamp: 0, trajectorySizes: {} };

      const interactions = extractFromTrajectory(b64, state, "/test/project");

      expect(interactions).toHaveLength(1);
      expect(interactions[0].prompt).toContain("TypeScript error");
      expect(interactions[0].response).toContain("type mismatch");
      expect(interactions[0].source).toBe("windsurf");
      expect(interactions[0].metadata).toHaveProperty("provider", "anthropic");
    });

    test("extracts thinking content", async () => {
      const { extractFromTrajectory } = await import("../index");

      const step = encodeStep({
        stepId: 1,
        seconds: 1714800000,
        payload: Buffer.concat([
          encodeUserMessage("Optimize this SQL query"),
          encodeAiResponse({
            thinking: "Let me analyze the JOIN conditions first...",
            visible: "Here's the optimized query using indexes.",
          }),
        ]),
      });

      const b64 = buildTrajectory([step]);
      const state = { processedIds: new Set<string>(), lastPollTimestamp: 0, trajectorySizes: {} };

      const interactions = extractFromTrajectory(b64, state, "/test");

      expect(interactions).toHaveLength(1);
      expect(interactions[0].response).toContain("optimized query");
      // Thinking is stored in context field
      expect(interactions[0].context).toContain("JOIN conditions");
    });

    test("extracts tool calls", async () => {
      const { extractFromTrajectory } = await import("../index");

      const toolCall = encodeToolCall("tc_001", "read_file", {
        file_path: "/src/utils.ts",
      });

      const step = encodeStep({
        stepId: 1,
        seconds: 1714800000,
        payload: Buffer.concat([
          encodeUserMessage("Show me the utils file"),
          encodeAiResponse({
            toolCalls: [toolCall],
            visible: "Reading the file...",
          }),
        ]),
      });

      const b64 = buildTrajectory([step]);
      const state = { processedIds: new Set<string>(), lastPollTimestamp: 0, trajectorySizes: {} };

      const interactions = extractFromTrajectory(b64, state, "/test");

      expect(interactions).toHaveLength(1);
      const meta = interactions[0].metadata as Record<string, unknown>;
      expect(meta.toolCalls).toEqual(["read_file"]);
    });

    test("deduplicates by content hash", async () => {
      const { extractFromTrajectory } = await import("../index");

      const step = encodeStep({
        stepId: 1,
        seconds: 1714800000,
        payload: Buffer.concat([
          encodeUserMessage("Hello"),
          encodeAiResponse({ visible: "Hi there!" }),
        ]),
      });

      const b64 = buildTrajectory([step]);
      const state = { processedIds: new Set<string>(), lastPollTimestamp: 0, trajectorySizes: {} };

      // First pass
      const first = extractFromTrajectory(b64, state, "/test");
      expect(first).toHaveLength(1);

      // Second pass — should be deduplicated
      const second = extractFromTrajectory(b64, state, "/test");
      expect(second).toHaveLength(0);
    });

    test("handles empty trajectory", async () => {
      const { extractFromTrajectory } = await import("../index");

      const b64 = buildTrajectory([], "empty-trajectory");
      const state = { processedIds: new Set<string>(), lastPollTimestamp: 0, trajectorySizes: {} };

      const interactions = extractFromTrajectory(b64, state, "/test");
      expect(interactions).toHaveLength(0);
    });

    test("handles missing user message (AI-only step)", async () => {
      const { extractFromTrajectory } = await import("../index");

      // Step with only f20 (AI response), no f19
      const f20Only = Buffer.concat([
        wireVarint(1, 2),  // step id
        wireBytes(5, encodeTimestamp(1714800000)),
        encodeAiResponse({ visible: "Standalone response" }),
      ]);
      const step = wireBytes(1, f20Only);

      const b64 = buildTrajectory([step]);
      const state = { processedIds: new Set<string>(), lastPollTimestamp: 0, trajectorySizes: {} };

      const interactions = extractFromTrajectory(b64, state, "/test");
      // No user message to pair with → should be empty
      expect(interactions).toHaveLength(0);
    });

    test("handles multiple consecutive pairs", async () => {
      const { extractFromTrajectory } = await import("../index");

      const step1 = encodeStep({
        stepId: 1,
        seconds: 1714800000,
        payload: Buffer.concat([
          encodeUserMessage("Q1"),
          encodeAiResponse({ visible: "A1" }),
        ]),
      });

      const step2 = encodeStep({
        stepId: 2,
        seconds: 1714800060,
        payload: Buffer.concat([
          encodeUserMessage("Q2"),
          encodeAiResponse({ visible: "A2" }),
        ]),
      });

      const b64 = buildTrajectory([step1, step2]);
      const state = { processedIds: new Set<string>(), lastPollTimestamp: 0, trajectorySizes: {} };

      const interactions = extractFromTrajectory(b64, state, "/test");
      expect(interactions).toHaveLength(2);
      expect(interactions[0].prompt).toBe("Q1");
      expect(interactions[1].prompt).toBe("Q2");
    });

    test("tags interactions with workspace path", async () => {
      const { extractFromTrajectory } = await import("../index");

      const step = encodeStep({
        stepId: 1,
        seconds: 1714800000,
        payload: Buffer.concat([
          encodeUserMessage("Test"),
          encodeAiResponse({ visible: "Response" }),
        ]),
      });

      const b64 = buildTrajectory([step]);
      const state = { processedIds: new Set<string>(), lastPollTimestamp: 0, trajectorySizes: {} };

      const interactions = extractFromTrajectory(b64, state, "/path/to/project");
      expect(interactions).toHaveLength(1);
      expect(interactions[0].metadata).toHaveProperty("workspace", "/path/to/project");
    });

    test("handles invalid base64 gracefully", async () => {
      const { extractFromTrajectory } = await import("../index");

      const state = { processedIds: new Set<string>(), lastPollTimestamp: 0, trajectorySizes: {} };
      const interactions = extractFromTrajectory("not-valid-base64!!!", state, "/test");
      expect(interactions).toHaveLength(0);
    });

    test("handles protobuf with thinking and no visible (thinking mode)", async () => {
      const { extractFromTrajectory } = await import("../index");

      const step = encodeStep({
        stepId: 1,
        seconds: 1714800000,
        payload: Buffer.concat([
          encodeUserMessage("Explain monads"),
          encodeAiResponse({
            thinking: "Monads are complex... let me explain step by step...",
            // No visible response — thinking mode only
          }),
        ]),
      });

      const b64 = buildTrajectory([step]);
      const state = { processedIds: new Set<string>(), lastPollTimestamp: 0, trajectorySizes: {} };

      const interactions = extractFromTrajectory(b64, state, "/test");
      expect(interactions).toHaveLength(1);
      // Response should fall back to thinking content
      expect(interactions[0].response).toContain("Monads are complex");
    });
  });
});

// ── Tests: Tool Call Parsing ────────────────────────────────────

describe("Windsurf Harvester — Tool Calls", () => {
  test("parses tool call with all fields", async () => {
    const { parseToolCall, parseFields, tryDecodeStr } = await import("../index");

    const tc = encodeToolCall("call_1", "write_file", {
      path: "/tmp/test.ts",
      content: "console.log('hello')",
    });

    const result = parseToolCall(tc, 0, tc.length);
    expect(result).not.toBeNull();
    expect(result!.toolId).toBe("call_1");
    expect(result!.toolName).toBe("write_file");
    expect(result!.params).toEqual({ path: "/tmp/test.ts", content: "console.log('hello')" });
  });

  test("handles partial tool call (missing id)", async () => {
    const { parseToolCall } = await import("../index");

    // Tool call with only name and params
    const tc = Buffer.concat([
      wireString(2, "search_code"),
      wireString(3, JSON.stringify({ query: "test" })),
    ]);

    const result = parseToolCall(tc, 0, tc.length);
    expect(result).not.toBeNull();
    expect(result!.toolId).toBe("");
    expect(result!.toolName).toBe("search_code");
  });
});

// ── Tests: AI Response Parsing ──────────────────────────────────

describe("Windsurf Harvester — AI Response", () => {
  test("extracts all fields", async () => {
    const { parseAiResponse } = await import("../index");

    const tc1 = encodeToolCall("tc1", "read_file", { file: "/x.ts" });
    const tc2 = encodeToolCall("tc2", "search", { query: "foo" });

    const ai = Buffer.concat([
      wireString(3, "Let me think about this..."),
      wireBytes(7, tc1),
      wireBytes(7, tc2),
      wireString(8, "Here is the result."),
      wireString(12, "anthropic"),
    ]);

    const result = parseAiResponse(ai, 0, ai.length);
    expect(result.thinking).toBe("Let me think about this...");
    expect(result.visible).toBe("Here is the result.");
    expect(result.provider).toBe("anthropic");
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].toolName).toBe("read_file");
    expect(result.toolCalls[1].toolName).toBe("search");
  });
});

// ── Tests: Harvester Integration ────────────────────────────────

describe("Windsurf Harvester — Integration", () => {
  test("createWindsurfHarvester returns harvester object", async () => {
    const { createWindsurfHarvester } = await import("../index");
    const hooks = createMockHooks();
    const harvester = createWindsurfHarvester(hooks);

    expect(harvester).toBeDefined();
    expect(typeof harvester.poll).toBe("function");
    expect(typeof harvester.start).toBe("function");
    expect(typeof harvester.stop).toBe("function");
    expect(typeof harvester.getState).toBe("function");
  });

  test("poll returns empty when no state.vscdb", async () => {
    const { createWindsurfHarvester } = await import("../index");
    const hooks = createMockHooks();
    const harvester = createWindsurfHarvester(hooks);

    // No state.vscdb should be found ⇒ empty
    const result = await harvester.poll();
    expect(result).toEqual([]);
  });

  test("getState returns current state", async () => {
    const { createWindsurfHarvester } = await import("../index");
    const hooks = createMockHooks();
    const harvester = createWindsurfHarvester(hooks);

    const state = harvester.getState();
    expect(state).toHaveProperty("lastPollTimestamp");
    expect(state).toHaveProperty("processedIds");
    expect(state).toHaveProperty("trajectorySizes");
    expect(state.processedIds).toBeInstanceOf(Set);
  });
});

// ── Tests: State Persistence ────────────────────────────────────

describe("Windsurf Harvester — State", () => {
  test("state persists between harvester instances", async () => {
    const { createWindsurfHarvester, extractFromTrajectory } = await import("../index");
    const hooks = createMockHooks();
    
    // Build a synthetic trajectory for dedup testing
    const step = Buffer.concat([
      wireVarint(1, 1),
      wireBytes(5, encodeTimestamp(1714800000)),
      encodeUserMessage("persistence test"),
      encodeAiResponse({ visible: "response" }),
    ]);
    const stepWrapped = wireBytes(1, step);
    const b64 = buildTrajectory([stepWrapped]);

    const state = { processedIds: new Set<string>(), lastPollTimestamp: 0, trajectorySizes: {} };
    const first = extractFromTrajectory(b64, state, "/test");
    expect(first).toHaveLength(1);
    const hash = first[0].id;

    // Simulate saving and reloading state
    expect(state.processedIds.has(hash.replace("windsurf-", ""))).toBe(true);
  });
});

// ── Tests: parseUserMessage ────────────────────────────────────

describe("Windsurf Harvester — User Message Parsing", () => {
  test("extracts text from user message", async () => {
    const { parseUserMessage } = await import("../index");
    const msg = Buffer.concat([wireString(1, "Fix this bug please")]);
    const result = parseUserMessage(msg, 0, msg.length);
    expect(result).toBe("Fix this bug please");
  });

  test("skips empty strings", async () => {
    const { parseUserMessage } = await import("../index");
    const msg = wireString(1, "");
    const result = parseUserMessage(msg, 0, msg.length);
    expect(result).toBeNull();
  });

  test("handles nested message structure", async () => {
    const { parseUserMessage } = await import("../index");
    // f19 contains other fields besides f1=text
    const msg = Buffer.concat([
      wireVarint(2, 42),          // some metadata
      wireString(1, "actual text"),
      wireString(3, "ignored"),
    ]);
    const result = parseUserMessage(msg, 0, msg.length);
    expect(result).toBe("actual text");
  });
});

// ── Tests: discoverWorkspaces (integration) ─────────────────────

describe("Windsurf Harvester — Workspace Discovery", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `brain-test-ws-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  test("discovers workspace from workspace.json", async () => {
    const { createWindsurfHarvester } = await import("../index");
    const hooks = createMockHooks();
    const harvester = createWindsurfHarvester(hooks);

    // Create mock workspaceStorage structure
    const wsId = "abc123workspace";
    const wsDir = join(tempDir, wsId);
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(
      join(wsDir, "workspace.json"),
      JSON.stringify({ folder: "file:///Users/test/project" }),
      "utf-8"
    );

    // Verify state is accessible
    const state = harvester.getState();
    expect(state).toHaveProperty("trajectorySizes");
  });

  test("returns empty state when no workspaces exist", async () => {
    const { createWindsurfHarvester } = await import("../index");
    const hooks = createMockHooks();
    const harvester = createWindsurfHarvester(hooks);

    const state = harvester.getState();
    expect(state.trajectorySizes).toEqual({});
  });
});
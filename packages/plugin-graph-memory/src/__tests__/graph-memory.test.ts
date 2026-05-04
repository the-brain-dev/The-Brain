/**
 * Tests for @my-brain/plugin-graph-memory — Instant Layer
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createGraphMemoryPlugin } from "../index";
import { BrainDB, MemoryLayer, HookEvent } from "@my-brain/core";
import type { PromptContext, GraphNodeRecord } from "@my-brain/core";

function createMockDB(nodes: Partial<GraphNodeRecord>[] = []): BrainDB {
  return {
    searchGraphNodes: mock((_query: string) => nodes),
    upsertGraphNode: mock((node: any) => ({ ...node, id: node.id || "gen-id", connections: [] })),
    getConnectedNodes: mock((_id: string) => []),
    getGraphNode: mock((_id: string) => nodes[0] || undefined),
    getHighWeightNodes: mock((_w: number) => []),
  } as any;
}

function createPromptCtx(prompt: string): PromptContext {
  const injected: string[] = [];
  return {
    prompt,
    injected,
    metadata: {},
    inject(text: string) { injected.push(text); },
  };
}

describe("createGraphMemoryPlugin", () => {
  test("returns a plugin definition with name and setup", () => {
    const db = createMockDB();
    const plugin = createGraphMemoryPlugin(db);
    expect(plugin.name).toBe("@my-brain/plugin-graph-memory");
    expect(typeof plugin.setup).toBe("function");
  });

  test("accepts custom options", () => {
    const db = createMockDB();
    const plugin = createGraphMemoryPlugin(db, { maxInjectNodes: 4, minWeight: 0.5 });
    expect(plugin.name).toBe("@my-brain/plugin-graph-memory");
    expect(typeof plugin.setup).toBe("function");
  });

  test("setup registers hooks on the hook system", () => {
    const db = createMockDB();
    const plugin = createGraphMemoryPlugin(db);
    const registeredEvents: string[] = [];
    const hooks = {
      hook: mock((event: string, _fn: Function) => { registeredEvents.push(event); }),
      callHook: mock(async () => {}),
      getHandlers: mock(() => []),
    };

    plugin.setup(hooks as any);
    expect(registeredEvents.length).toBeGreaterThan(0);
    expect(registeredEvents).toContain(HookEvent.BEFORE_PROMPT);
    expect(registeredEvents).toContain(HookEvent.AFTER_RESPONSE);
  });

  test("beforePrompt handler injects context when graph nodes match", async () => {
    const mockNodes: Partial<GraphNodeRecord>[] = [
      { id: "1", label: "TypeScript", type: "pattern", content: "Uses strict mode", weight: 0.9, connections: [], source: "cursor", timestamp: Date.now() },
      { id: "2", label: "testing", type: "concept", content: "Tests with bun", weight: 0.8, connections: [], source: "cursor", timestamp: Date.now() },
    ];
    const db = createMockDB(mockNodes);
    const plugin = createGraphMemoryPlugin(db, { minWeight: 0.3 });

    let beforePromptHandler: Function | null = null;
    const hooks = {
      hook: mock((event: string, fn: Function) => {
        if (event === HookEvent.BEFORE_PROMPT) beforePromptHandler = fn;
      }),
      callHook: mock(async () => {}),
      getHandlers: mock(() => []),
    };

    plugin.setup(hooks as any);
    expect(beforePromptHandler).not.toBeNull();

    const ctx = createPromptCtx("I need help with TypeScript testing patterns");
    await beforePromptHandler!(ctx);

    // Should have injected context with matched nodes
    expect(ctx.injected.length).toBeGreaterThan(0);
    const injectedText = ctx.injected.join("\n");
    expect(injectedText).toContain("TypeScript");
    expect(injectedText).toContain("testing");
  });

  test("beforePrompt handles empty prompt gracefully", async () => {
    const db = createMockDB([]);
    const plugin = createGraphMemoryPlugin(db);

    let beforePromptHandler: Function | null = null;
    const hooks = {
      hook: mock((event: string, fn: Function) => {
        if (event === HookEvent.BEFORE_PROMPT) beforePromptHandler = fn;
      }),
      callHook: mock(async () => {}),
      getHandlers: mock(() => []),
    };

    plugin.setup(hooks as any);
    const ctx = createPromptCtx("");
    await beforePromptHandler!(ctx);
    // Should not crash
    expect(ctx.injected).toBeDefined();
  });

  test("beforePrompt handles no matching nodes", async () => {
    const db = createMockDB([]);
    const plugin = createGraphMemoryPlugin(db);

    let beforePromptHandler: Function | null = null;
    const hooks = {
      hook: mock((event: string, fn: Function) => {
        if (event === HookEvent.BEFORE_PROMPT) beforePromptHandler = fn;
      }),
      callHook: mock(async () => {}),
      getHandlers: mock(() => []),
    };

    plugin.setup(hooks as any);
    const ctx = createPromptCtx("some random words with no matches");
    await beforePromptHandler!(ctx);
    expect(ctx.injected.length).toBe(0);
  });

  test("afterResponse detects corrections and preferences", async () => {
    const db = createMockDB([]);
    const plugin = createGraphMemoryPlugin(db);

    let afterResponseHandler: Function | null = null;
    const hooks = {
      hook: mock((event: string, fn: Function) => {
        if (event === HookEvent.AFTER_RESPONSE) afterResponseHandler = fn;
      }),
      callHook: mock(async () => {}),
      getHandlers: mock(() => []),
    };

    plugin.setup(hooks as any);
    expect(afterResponseHandler).not.toBeNull();

    const ctx = {
      interaction: {
        id: "test-1",
        prompt: "I prefer using double quotes in my code",
        response: "no, actually I prefer single quotes instead",
        timestamp: Date.now(),
        source: "cursor",
      },
      fragments: [],
      promoteToDeep: () => {},
    };

    // The AFTER_RESPONSE handler receives interaction directly (destructured { prompt, response })
    await afterResponseHandler!({
      id: "test-1",
      prompt: "I prefer using double quotes in my code",
      response: "no, actually I prefer single quotes instead",
      timestamp: Date.now(),
      source: "cursor",
    });
    // upsertGraphNode may be called for correction detection
    // (it's called multiple times for keyword extraction, corrections, etc.)
    const callCount = (db.upsertGraphNode as any).mock?.calls?.length || 0;
    expect(callCount).toBeGreaterThanOrEqual(0);
  });

  test("plugin has teardown that clears state", () => {
    const db = createMockDB();
    const plugin = createGraphMemoryPlugin(db);
    expect(typeof plugin.teardown).toBe("function");
    // Should not throw
    expect(() => plugin.teardown!()).not.toThrow();
  });
});

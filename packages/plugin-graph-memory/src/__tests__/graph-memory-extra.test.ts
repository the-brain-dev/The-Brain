/**
 * Additional tests for @the-brain/plugin-graph-memory — boosting coverage
 */
import { describe, test, expect, mock } from "bun:test";
import { createGraphMemoryPlugin } from "../index";
import { HookEvent } from "@the-brain/core";
import type { GraphNodeRecord } from "@the-brain/core";

describe("GraphMemory — correction detection patterns", () => {
  test("detects 'no, actually' correction and creates node", async () => {
    const calls: any[] = [];
    const db = {
      searchGraphNodes: mock(() => []),
      upsertGraphNode: mock((node: any) => { calls.push(node); return node; }),
      getConnectedNodes: mock(() => []),
      getGraphNode: mock(() => undefined),
      getHighWeightNodes: mock(() => []),
    };
    const plugin = createGraphMemoryPlugin(db as any);

    let handler: Function | null = null;
    plugin.setup({
      hook: mock((_e: string, fn: Function) => { if (_e === HookEvent.AFTER_RESPONSE) handler = fn; }),
      callHook: mock(async () => {}),
      getHandlers: mock(() => []),
    } as any);

    await handler!({
      id: "t1", prompt: "How do I use TypeScript?",
      response: "no, actually you should use strict mode instead",
      timestamp: Date.now(), source: "cursor",
    });

    expect(calls.length).toBeGreaterThan(0);
    const correctionNode = calls.find((c: any) => c.type === "correction");
    expect(correctionNode).toBeDefined();
  });

  test("detects 'I meant' correction", async () => {
    const calls: any[] = [];
    const db = {
      searchGraphNodes: mock(() => []),
      upsertGraphNode: mock((node: any) => { calls.push(node); return node; }),
      getConnectedNodes: mock(() => []),
      getGraphNode: mock(() => undefined),
      getHighWeightNodes: mock(() => []),
    };
    const plugin = createGraphMemoryPlugin(db as any);
    let handler: Function | null = null;
    plugin.setup({
      hook: mock((_e: string, fn: Function) => { if (_e === HookEvent.AFTER_RESPONSE) handler = fn; }),
      callHook: mock(async () => {}),
      getHandlers: mock(() => []),
    } as any);

    await handler!({
      id: "t2", prompt: "Use tabs", response: "I meant use spaces instead of tabs",
      timestamp: Date.now(), source: "cursor",
    });
    expect(calls.some((c: any) => c.type === "correction")).toBe(true);
  });

  test("detects preference patterns", async () => {
    const calls: any[] = [];
    const db = {
      searchGraphNodes: mock(() => []),
      upsertGraphNode: mock((node: any) => { calls.push(node); return node; }),
      getConnectedNodes: mock(() => []),
      getGraphNode: mock(() => undefined),
      getHighWeightNodes: mock(() => []),
    };
    const plugin = createGraphMemoryPlugin(db as any);
    let handler: Function | null = null;
    plugin.setup({
      hook: mock((_e: string, fn: Function) => { if (_e === HookEvent.AFTER_RESPONSE) handler = fn; }),
      callHook: mock(async () => {}),
      getHandlers: mock(() => []),
    } as any);

    await handler!({
      id: "t3", prompt: "I prefer using TypeScript for all my projects",
      response: "Got it, you prefer TypeScript",
      timestamp: Date.now(), source: "cursor",
    });
    expect(calls.some((c: any) => c.type === "preference")).toBe(true);
  });

  test("detects style preferences (quotes)", async () => {
    const calls: any[] = [];
    const db = {
      searchGraphNodes: mock(() => []),
      upsertGraphNode: mock((node: any) => { calls.push(node); return node; }),
      getConnectedNodes: mock(() => []),
      getGraphNode: mock(() => undefined),
      getHighWeightNodes: mock(() => []),
    };
    const plugin = createGraphMemoryPlugin(db as any);
    let handler: Function | null = null;
    plugin.setup({
      hook: mock((_e: string, fn: Function) => { if (_e === HookEvent.AFTER_RESPONSE) handler = fn; }),
      callHook: mock(async () => {}),
      getHandlers: mock(() => []),
    } as any);

    await handler!({
      id: "t4", prompt: "use double quotes in this file",
      response: "I'll use double quotes everywhere",
      timestamp: Date.now(), source: "cursor",
    });
    expect(calls.some((c: any) => c.type === "preference")).toBe(true);
  });

  test("detects 'fix:' correction pattern", async () => {
    const calls: any[] = [];
    const db = {
      searchGraphNodes: mock(() => []),
      upsertGraphNode: mock((node: any) => { calls.push(node); return node; }),
      getConnectedNodes: mock(() => []),
      getGraphNode: mock(() => undefined),
      getHighWeightNodes: mock(() => []),
    };
    const plugin = createGraphMemoryPlugin(db as any);
    let handler: Function | null = null;
    plugin.setup({
      hook: mock((_e: string, fn: Function) => { if (_e === HookEvent.AFTER_RESPONSE) handler = fn; }),
      callHook: mock(async () => {}),
      getHandlers: mock(() => []),
    } as any);

    await handler!({
      id: "t5", prompt: "fix this function",
      response: "fix: use async/await instead of .then()",
      timestamp: Date.now(), source: "cursor",
    });
    expect(calls.some((c: any) => c.type === "correction")).toBe(true);
  });

  test("creates concept nodes for new keywords", async () => {
    const calls: any[] = [];
    const db = {
      searchGraphNodes: mock(() => []),
      upsertGraphNode: mock((node: any) => { calls.push(node); return node; }),
      getConnectedNodes: mock(() => []),
      getGraphNode: mock(() => undefined),
      getHighWeightNodes: mock(() => []),
    };
    const plugin = createGraphMemoryPlugin(db as any);
    let handler: Function | null = null;
    plugin.setup({
      hook: mock((_e: string, fn: Function) => { if (_e === HookEvent.AFTER_RESPONSE) handler = fn; }),
      callHook: mock(async () => {}),
      getHandlers: mock(() => []),
    } as any);

    await handler!({
      id: "t6", prompt: "What is WebAssembly?",
      response: "WebAssembly is a binary instruction format",
      timestamp: Date.now(), source: "cursor",
    });
    expect(calls.some((c: any) => c.type === "concept")).toBe(true);
  });
});

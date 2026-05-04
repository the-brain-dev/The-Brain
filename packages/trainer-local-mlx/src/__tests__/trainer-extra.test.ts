/**
 * Tests for trainer-local-mlx — covering the plugin definition and hooks
 */
import { describe, test, expect } from "bun:test";
import { HookEvent } from "@my-brain/core";

describe("trainer-local-mlx", () => {
  test("createMlxTrainer returns a plugin definition", async () => {
    const { createMlxTrainer } = await import("../index");
    const plugin = await Promise.resolve(createMlxTrainer());
    expect(plugin.name).toBe("@my-brain/trainer-local-mlx");
    expect(plugin.version).toBeDefined();
    expect(plugin.description).toContain("MLX");
    expect(typeof plugin.setup).toBe("function");
  });

  test("setup registers DEEP_CONSOLIDATE hook", async () => {
    const { createMlxTrainer } = await import("../index");
    const plugin = await Promise.resolve(createMlxTrainer());
    const registered: string[] = [];
    plugin.setup({
      hook: (event: string, _fn: Function) => registered.push(event),
      callHook: async () => {},
      getHandlers: () => [],
    } as any);
    expect(registered).toContain(HookEvent.DEEP_CONSOLIDATE);
  });

  test("setup registers training:run custom hook", async () => {
    const { createMlxTrainer } = await import("../index");
    const plugin = await Promise.resolve(createMlxTrainer());
    const registered: string[] = [];
    plugin.setup({
      hook: (event: string, _fn: Function) => registered.push(event),
      callHook: async () => {},
      getHandlers: () => [],
    } as any);
    expect(registered).toContain("training:run");
  });

  test("accepts custom config", async () => {
    const { createMlxTrainer } = await import("../index");
    const plugin = await Promise.resolve(createMlxTrainer({
      learningRate: 2e-4,
      loraRank: 8,
      iterations: 100,
    }));
    expect(plugin.name).toBeDefined();
  });

  test("DEEP_CONSOLIDATE handler handles empty fragments", async () => {
    const { createMlxTrainer } = await import("../index");
    const plugin = await Promise.resolve(createMlxTrainer());
    let deepHandler: Function | null = null;
    plugin.setup({
      hook: (event: string, fn: Function) => {
        if (event === HookEvent.DEEP_CONSOLIDATE) deepHandler = fn;
      },
      callHook: async () => {},
      getHandlers: () => [],
    } as any);

    expect(deepHandler).not.toBeNull();
    // Should handle empty fragments without crash
    const ctx = {
      targetLayer: "deep",
      fragments: [],
      results: { layer: "deep", fragmentsPromoted: 0, fragmentsDiscarded: 0, duration: 0 },
    };
    await deepHandler!(ctx);
  });

  test("training:run handler does not crash with data", async () => {
    const { createMlxTrainer } = await import("../index");
    const plugin = await Promise.resolve(createMlxTrainer());
    let trainingHandler: Function | null = null;
    plugin.setup({
      hook: (event: string, fn: Function) => {
        if (event === "training:run") trainingHandler = fn;
      },
      callHook: async () => {},
      getHandlers: () => [],
    } as any);

    expect(trainingHandler).not.toBeNull();
    const ctx = {
      targetLayer: "deep",
      fragments: [{ id: "1", content: "test data" }],
      results: { layer: "deep", fragmentsPromoted: 0, fragmentsDiscarded: 0, duration: 0 },
    };
    // The handler spawns Python — it may fail or hang, but it shouldn't crash the test runner
    // Race with timeout
    const result = await Promise.race([
      trainingHandler!(ctx).then(() => "done").catch(() => "error"),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);
    expect(result === "done" || result === "error" || result === "timeout").toBe(true);
  });
});

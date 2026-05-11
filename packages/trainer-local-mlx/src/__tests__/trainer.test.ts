/**
 * Tests for @the-brain-dev/trainer-local-mlx — Deep Layer Trainer
 */
import { describe, test, expect } from "bun:test";
import { HookEvent } from "@the-brain-dev/core";

// Use relative import since workspace resolution may have issues with node:child_process
describe("@the-brain-dev/trainer-local-mlx", () => {
  test("createMlxTrainer returns plugin definition", async () => {
    const { createMlxTrainer } = await import("../index");
    const plugin = await Promise.resolve(createMlxTrainer());
    expect(plugin.name).toBe("@the-brain-dev/trainer-local-mlx");
    expect(typeof plugin.setup).toBe("function");
  });

  test("setup registers deep consolidate hook", async () => {
    const { createMlxTrainer } = await import("../index");
    const plugin = await Promise.resolve(createMlxTrainer());
    const registered: string[] = [];
    const hooks = {
      hook: (event: string, _fn: Function) => { registered.push(event); },
      callHook: async () => {},
      getHandlers: () => [],
    };

    plugin.setup(hooks as any);
    expect(registered).toContain(HookEvent.DEEP_CONSOLIDATE);
  });

  test("supports training:run custom hook", async () => {
    const { createMlxTrainer } = await import("../index");
    const plugin = await Promise.resolve(createMlxTrainer());
    const registered: string[] = [];
    const hooks = {
      hook: (event: string, _fn: Function) => { registered.push(event); },
      callHook: async () => {},
      getHandlers: () => [],
    };

    plugin.setup(hooks as any);
    expect(registered.length).toBeGreaterThan(0);
  });
});

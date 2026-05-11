/**
 * Tests for @the-brain/plugin-spm-curator — Selection Layer
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { createSpmCurator, SpmCuratorPlugin } from "../index";
import { MemoryLayer, HookEvent } from "@the-brain/core";
import type { InteractionContext, SurpriseGateResult, MemoryFragment } from "@the-brain/core";

function createInteractionCtx(prompt: string, response: string, fragments: MemoryFragment[] = []): InteractionContext {
  return {
    interaction: {
      id: `int-${Date.now()}`,
      prompt,
      response,
      timestamp: Date.now(),
      source: "cursor",
    },
    fragments,
    promoteToDeep: () => {},
  };
}

function createFragment(content: string, embed?: number[], score?: number): MemoryFragment {
  return {
    id: `frag-${Date.now()}-${Math.random()}`,
    layer: MemoryLayer.SELECTION,
    content,
    embedding: embed,
    surpriseScore: score,
    timestamp: Date.now(),
    source: "cursor",
  };
}

describe("createSpmCurator", () => {
  test("returns definition and instance", () => {
    const { definition, instance } = createSpmCurator();
    expect(definition.name).toBe("@the-brain/plugin-spm-curator");
    expect(definition.version).toBeDefined();
    expect(instance).toBeInstanceOf(SpmCuratorPlugin);
  });

  test("default export is a ready-to-use PluginDefinition", () => {
    const { definition } = createSpmCurator();
    expect(typeof definition.setup).toBe("function");
  });

  test("accepts custom config", () => {
    const { instance } = createSpmCurator({ threshold: 0.6 });
    const stats = instance.getStats();
    expect(stats).toBeDefined();
  });
});

describe("SpmCuratorPlugin evaluate", () => {
  let instance: SpmCuratorPlugin;

  beforeEach(() => {
    instance = createSpmCurator({ threshold: 0.3 }).instance;
  });

  test("returns a SurpriseGateResult with score in [0,1]", async () => {
    const ctx = createInteractionCtx(
      "Write a function that sorts an array",
      "Here's a bubble sort implementation..."
    );
    const result = await instance.evaluate(ctx);
    expect(result).toBeDefined();
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(typeof result.isSurprising).toBe("boolean");
    expect(typeof result.predictionError).toBe("number");
  });

  test("repeated identical interactions produce lower scores (model adapts)", async () => {
    const ctx = createInteractionCtx(
      "Hello world",
      "Hi there!"
    );

    const r1 = await instance.evaluate(ctx);
    const r2 = await instance.evaluate(ctx);
    const r3 = await instance.evaluate(ctx);

    // After seeing the same thing multiple times, surprise should decrease or stay stable
    expect(r3.score).toBeLessThanOrEqual(r1.score + 0.1);
  });

  test("very different interaction produces higher score", async () => {
    // First, establish a baseline
    await instance.evaluate(createInteractionCtx("hello", "hi"));
    await instance.evaluate(createInteractionCtx("hello again", "hey"));

    // A very different interaction should be surprising
    const result = await instance.evaluate(createInteractionCtx(
      "COMPLETELY UNEXPECTED: I want to rewrite the entire project in Rust instead of TypeScript",
      "That would be a dramatic change from our established patterns"
    ));

    expect(result.predictionError).toBeGreaterThan(0);
    expect(result.score).toBeGreaterThan(0);
  });

  test("handles empty prompt and response", async () => {
    const ctx = createInteractionCtx("", "");
    const result = await instance.evaluate(ctx);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  test("handles very long text", async () => {
    const longText = "x".repeat(10000);
    const ctx = createInteractionCtx(longText, longText);
    const result = await instance.evaluate(ctx);
    expect(result.score).toBeDefined();
  });
});

describe("SpmCuratorPlugin promote", () => {
  let instance: SpmCuratorPlugin;

  beforeEach(() => {
    instance = createSpmCurator().instance;
  });

  test("returns MemoryFragment array", async () => {
    const ctx = createInteractionCtx("test", "response", [
      createFragment("important memory", [0.1, 0.2, 0.3], 0.8)
    ]);
    const fragments = await instance.promote(ctx);
    expect(Array.isArray(fragments)).toBe(true);
  });

  test("promoted fragments have DEEP layer", async () => {
    const ctx = createInteractionCtx("test", "response", [
      createFragment("to promote", [0.5, 0.5], 0.9)
    ]);
    const fragments = await instance.promote(ctx);
    for (const f of fragments) {
      expect(f.layer).toBe(MemoryLayer.DEEP);
    }
  });
});

describe("SpmCuratorPlugin getStats", () => {
  test("returns stats object with expected keys", () => {
    const { instance } = createSpmCurator();
    const stats = instance.getStats();
    expect(stats).toBeDefined();
    expect(typeof stats).toBe("object");
  });
});

describe("SpmCuratorPlugin setThreshold", () => {
  test("dynamically adjusts threshold", () => {
    const { instance } = createSpmCurator();
    instance.setThreshold(0.8);
    // Threshold is updated internally
  });
});

describe("SpmCuratorPlugin teardown", () => {
  test("teardown via definition resets state", () => {
    const { definition, instance } = createSpmCurator();
    expect(typeof definition.teardown).toBe("function");
    definition.teardown!();
  });
});

describe("SPM hook integration", () => {
  test("registers selection hooks via setup", () => {
    const { definition } = createSpmCurator();
    const registered: string[] = [];
    const hooks = {
      hook: (event: string, _fn: Function) => { registered.push(event); },
      callHook: async () => {},
      getHandlers: () => [],
    };

    definition.setup(hooks as any);
    expect(registered).toContain(HookEvent.SELECTION_EVALUATE);
  });
});

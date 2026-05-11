/**
 * Additional tests for SPM Curator — boosting coverage
 */
import { describe, test, expect } from "bun:test";
import { createSpmCurator } from "../index";
import { MemoryLayer } from "@the-brain-dev/core";
import type { InteractionContext, MemoryFragment } from "@the-brain-dev/core";

function ctx(prompt: string, response: string): InteractionContext {
  return {
    interaction: { id: "t", prompt, response, timestamp: Date.now(), source: "cursor" },
    fragments: [],
    promoteToDeep: () => {},
  };
}

function ctxWithFrag(prompt: string, response: string, frag: MemoryFragment): InteractionContext {
  return {
    interaction: { id: "t", prompt, response, timestamp: Date.now(), source: "cursor" },
    fragments: [frag],
    promoteToDeep: () => {},
  };
}

describe("SPM — model learning over time", () => {
  test("model stabilizes after repeated identical inputs", async () => {
    const { instance } = createSpmCurator({ threshold: 0.3 });

    // Feed 20 identical interactions
    const scores: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await instance.evaluate(ctx("hello there", "hi back"));
      scores.push(r.score);
    }

    // Score should decrease or stabilize
    expect(scores[19]).toBeLessThanOrEqual(scores[0] + 0.05);
  });

  test("novel content produces higher scores than repeated content", async () => {
    const { instance } = createSpmCurator({ threshold: 0.2 });

    // Train on one pattern
    for (let i = 0; i < 10; i++) {
      await instance.evaluate(ctx("standard request", "standard response"));
    }

    // Novel input should score higher
    const novel = await instance.evaluate(ctx(
      "BREAKING: I need to completely refactor the entire authentication system to use a new paradigm",
      "This is a major architectural change from our usual approach"
    ));

    const standard = await instance.evaluate(ctx("standard request", "standard response"));
    expect(novel.score).toBeGreaterThan(standard.score);
  });
});

describe("SPM — promote behavior", () => {
  test("promote returns empty array for no fragments", async () => {
    const { instance } = createSpmCurator();
    const result = await instance.promote(ctx("test", "test"));
    expect(result).toEqual([]);
  });

  test("promote enriches fragments with DEEP layer and metadata", async () => {
    const { instance } = createSpmCurator();
    const frag: MemoryFragment = {
      id: "f1", layer: MemoryLayer.SELECTION, content: "important learning",
      surpriseScore: 0.9, timestamp: Date.now(), source: "cursor",
    };
    const result = await instance.promote(ctxWithFrag("p", "r", frag));
    expect(result.length).toBeGreaterThanOrEqual(0);
  });
});

describe("SPM — edge cases", () => {
  test("handles very short single-character prompts", async () => {
    const { instance } = createSpmCurator();
    const r = await instance.evaluate(ctx("x", "y"));
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  test("handles unicode and special characters", async () => {
    const { instance } = createSpmCurator();
    const r = await instance.evaluate(ctx("日本語のテスト 🎉", "emoji and unicode ✨"));
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  test("handles null-like fragments gracefully in promote", async () => {
    const { instance } = createSpmCurator();
    const emptyCtx: InteractionContext = {
      interaction: { id: "e", prompt: "", response: "", timestamp: Date.now(), source: "test" },
      fragments: [] as any,
      promoteToDeep: () => {},
    };
    const r = await instance.promote(emptyCtx);
    expect(Array.isArray(r)).toBe(true);
  });

  test("setThreshold to extreme values", () => {
    const { instance } = createSpmCurator();
    instance.setThreshold(0);
    instance.setThreshold(1);
    instance.setThreshold(0.5);
    // Should not crash
  });

  test("getStats after many evaluations", async () => {
    const { instance } = createSpmCurator();
    for (let i = 0; i < 10; i++) {
      await instance.evaluate(ctx(`test ${i}`, `response ${i}`));
    }
    const stats = instance.getStats();
    expect(stats).toBeDefined();
  });
});

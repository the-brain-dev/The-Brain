/**
 * Tests for the Faux Test Harness.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { TestHarness } from "../test-harness";
import { MemoryLayer } from "../types";

describe("TestHarness", () => {
  let harness: TestHarness | null = null;

  afterEach(async () => {
    if (harness) {
      await harness.stop();
      harness = null;
    }
  });

  it("starts and stops cleanly", async () => {
    harness = new TestHarness();
    await harness.start();
    expect(harness.db).toBeDefined();
    expect(harness.hooks).toBeDefined();
    await harness.stop();
  });

  it("injects interactions and creates instant memories", async () => {
    harness = new TestHarness();
    await harness.start();

    const fragments = await harness.injectInteraction({
      prompt: "How do I use const in TypeScript?",
      response: "Use `const` for immutable bindings.",
    });

    expect(fragments).toHaveLength(1);
    expect(fragments[0].layer).toBe(MemoryLayer.INSTANT);

    const state = await harness.getState();
    expect(state.memoryCount).toBe(1);
    expect(state.byLayer.instant).toBe(1);
  });

  it("injects multiple interactions", async () => {
    harness = new TestHarness();
    await harness.start();

    await harness.injectInteractions([
      { prompt: "Q1", response: "A1" },
      { prompt: "Q2", response: "A2" },
      { prompt: "Q3", response: "A3" },
    ]);

    const state = await harness.getState();
    expect(state.memoryCount).toBe(3);
  });

  it("sets memories directly", async () => {
    harness = new TestHarness();
    await harness.start();

    await harness.setMemories([
      { content: "Memory 1", layer: MemoryLayer.INSTANT },
      { content: "Memory 2", layer: MemoryLayer.SELECTION },
      { content: "Memory 3", layer: MemoryLayer.DEEP },
    ]);

    const state = await harness.getState();
    expect(state.memoryCount).toBe(3);
    expect(state.byLayer.instant).toBe(1);
    expect(state.byLayer.selection).toBe(1);
    expect(state.byLayer.deep).toBe(1);
  });

  it("runs SPM evaluation", async () => {
    harness = new TestHarness({ spmThreshold: 0.3 });
    await harness.start();

    // Create 5 instant memories with varying content length
    await harness.setMemories([
      { content: "Short", layer: MemoryLayer.INSTANT },
      { content: "A bit longer content here", layer: MemoryLayer.INSTANT },
      { content: "x".repeat(2000), layer: MemoryLayer.INSTANT }, // Will score high
      { content: "Medium length memory for testing SPM scoring", layer: MemoryLayer.INSTANT },
      { content: "x".repeat(5000), layer: MemoryLayer.INSTANT }, // Will score high
    ]);

    const result = await harness.evaluateSPM();
    expect(result.total).toBe(5);
    expect(result.promoted).toBeGreaterThan(0); // Some should be promoted
  });

  it("runs full consolidation pipeline", async () => {
    harness = new TestHarness({ spmThreshold: 0.2 }); // Lower threshold for test
    await harness.start();

    // Add diverse memories
    await harness.setMemories([
      { content: "Short", layer: MemoryLayer.INSTANT },
      { content: "x".repeat(3000), layer: MemoryLayer.INSTANT }, // High complexity → promoted
      { content: "Another short one", layer: MemoryLayer.INSTANT },
    ]);

    const result = await harness.consolidate();

    expect(result.layer).toBe(MemoryLayer.DEEP);
    expect(result.fragmentsPromoted).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeGreaterThan(0);

    const state = await harness.getState();
    expect(state.lastConsolidation).toBeDefined();
  });

  it("handles wiki generation when enabled", async () => {
    harness = new TestHarness({
      spmThreshold: 0.1,
      wikiEnabled: true,
    });
    await harness.start();

    await harness.setMemories([
      { content: "x".repeat(3000), layer: MemoryLayer.INSTANT },
    ]);

    const result = await harness.consolidate();
    // Should not crash even if wiki path doesn't have full router setup
    expect(result.errors).toBeUndefined();
  });

  it("cleanly isolates test state", async () => {
    const harness1 = new TestHarness();
    await harness1.start();
    await harness1.injectInteraction({ prompt: "H1", response: "R1" });
    const state1 = await harness1.getState();
    expect(state1.memoryCount).toBe(1);
    await harness1.stop();

    const harness2 = new TestHarness();
    await harness2.start();
    const state2 = await harness2.getState();
    expect(state2.memoryCount).toBe(0); // Clean slate
    await harness2.stop();

    harness = harness2; // For cleanup
  });
});

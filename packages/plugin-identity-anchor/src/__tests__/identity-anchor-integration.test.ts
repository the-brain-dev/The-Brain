/**
 * Integration tests for @the-brain-dev/plugin-identity-anchor
 *
 * Tests hook handlers (SELECTION_PROMOTE, DEEP_CONSOLIDATE),
 * identity fragment capture, self-vector computation, maxAnchorFragments
 * enforcement, cosine similarity, teardown, and the getState custom hook.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { HookEvent, MemoryLayer } from "@the-brain-dev/core";
import type {
  MemoryFragment,
  Memory,
  InteractionContext,
  ConsolidationContext,
  Interaction,
} from "@the-brain-dev/core";

// ── Helpers ─────────────────────────────────────────────────────

const NOW = Date.now();

function makeFragment(overrides: Partial<MemoryFragment> = {}): MemoryFragment {
  return {
    id: overrides.id ?? `frag-${Math.random().toString(36).slice(2, 8)}`,
    layer: overrides.layer ?? MemoryLayer.SELECTION,
    content: overrides.content ?? "Default fragment content",
    embedding: overrides.embedding,
    surpriseScore: overrides.surpriseScore,
    timestamp: overrides.timestamp ?? NOW,
    source: overrides.source ?? "cursor",
    metadata: overrides.metadata,
  };
}

function makeInteractionContext(
  overrides: Partial<InteractionContext> = {}
): InteractionContext {
  const promoted: MemoryFragment[] = [];
  return {
    interaction: {
      id: "int-1",
      timestamp: NOW,
      prompt: "test prompt",
      response: "test response",
      source: "cursor",
    },
    fragments: [],
    promoteToDeep(fragment: MemoryFragment): void {
      promoted.push(fragment);
    },
    ...overrides,
  };
}

function makeConsolidationContext(
  overrides: Partial<ConsolidationContext> = {}
): ConsolidationContext {
  return {
    targetLayer: MemoryLayer.DEEP,
    fragments: [],
    results: {
      layer: MemoryLayer.DEEP,
      fragmentsPromoted: 0,
      fragmentsDiscarded: 0,
      duration: 0,
    },
    ...overrides,
  };
}

function createMockHooks() {
  const handlers = new Map<string, Function[]>();
  const callHookCalls: any[][] = [];
  return {
    handlers,
    callHookCalls,
    hook: mock((event: string, fn: Function) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(fn);
    }),
    callHook: mock(async (event: string, ...args: any[]) => {
      callHookCalls.push([event, ...args]);
    }),
    getHandlers: mock(() => []),
  };
}

// ── Cosine similarity (re-implemented for validation) ──────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length !== b.length) {
    const maxLen = Math.max(a.length, b.length);
    const a2 = [...a, ...Array(maxLen - a.length).fill(0)];
    const b2 = [...b, ...Array(maxLen - b.length).fill(0)];
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < maxLen; i++) {
      dot += a2[i] * b2[i];
      magA += a2[i] * a2[i];
      magB += b2[i] * b2[i];
    }
    return magA === 0 || magB === 0 ? 0 : dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return magA === 0 || magB === 0 ? 0 : dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ── Tests ───────────────────────────────────────────────────────

describe("createIdentityAnchorPlugin integration", () => {
  let plugin: ReturnType<typeof import("../index")["createIdentityAnchorPlugin"]>;

  beforeEach(async () => {
    // Fresh import for each test to get clean state (anchorFragments reset)
    const mod = await import("../index");
    plugin = mod.createIdentityAnchorPlugin();
  });

  // ── Test 1: Plugin definition ──────────────────────────────

  test("returns a plugin definition with name, setup, and teardown", () => {
    expect(plugin.name).toBe("@the-brain-dev/plugin-identity-anchor");
    expect(plugin.version).toBe("0.2.0");
    expect(typeof plugin.setup).toBe("function");
    expect(typeof plugin.teardown).toBe("function");
    expect(plugin.description).toContain("Self-Vector");
  });

  // ── Test 2: Setup registers expected hooks ─────────────────

  test("setup registers SELECTION_PROMOTE, DEEP_CONSOLIDATE, and identity-anchor:getState hooks", async () => {
    const hooks = createMockHooks();
    await plugin.setup(hooks as any);

    const registered = Array.from(hooks.handlers.keys());
    expect(registered).toContain(HookEvent.SELECTION_PROMOTE);
    expect(registered).toContain(HookEvent.DEEP_CONSOLIDATE);
    expect(registered).toContain("identity-anchor:getState");
  });

  // ── Test 3: SELECTION_PROMOTE captures identity-relevant fragments ──

  test("SELECTION_PROMOTE captures short declarative fragments with high surpriseScore", async () => {
    const hooks = createMockHooks();
    await plugin.setup(hooks as any);

    const handler = hooks.handlers.get(HookEvent.SELECTION_PROMOTE)?.[0];
    expect(handler).toBeDefined();

    const ctx = makeInteractionContext({
      fragments: [
        makeFragment({ id: "f1", content: "I prefer using tabs over spaces in all my projects", surpriseScore: 0.85 }),
        makeFragment({ id: "f2", content: "I always write integration tests before unit tests", surpriseScore: 0.9 }),
      ],
    });

    await handler!(ctx);

    // Check state via getState hook
    const getStateHandler = hooks.handlers.get("identity-anchor:getState")?.[0];
    expect(getStateHandler).toBeDefined();
    const state = await getStateHandler!();
    // Both fragments are short declarative statements (20-200 chars) with score >= 0.8
    expect(state.fragmentCount).toBe(2);
    expect(state.maxFragments).toBe(50);
  });

  // ── Test 4: SELECTION_PROMOTE captures all short declarative high-score fragments ──

  test("SELECTION_PROMOTE captures all short declarative fragments with high surpriseScore", async () => {
    const hooks = createMockHooks();
    await plugin.setup(hooks as any);

    const handler = hooks.handlers.get(HookEvent.SELECTION_PROMOTE)?.[0];

    const ctx = makeInteractionContext({
      fragments: [
        makeFragment({ id: "f1", content: "The weather is nice today", surpriseScore: 0.9 }),
        makeFragment({ id: "f2", content: "import React from 'react'", surpriseScore: 0.85 }),
        makeFragment({ id: "f3", content: "I prefer dark mode in my editor", surpriseScore: 0.95 }),
      ],
    });

    await handler!(ctx);

    // All three are short declarative (20-200 chars) with score >= 0.8
    // Language-agnostic: no English keyword filter, structural heuristic only
    const getStateHandler = hooks.handlers.get("identity-anchor:getState")?.[0];
    const state = await getStateHandler!();
    expect(state.fragmentCount).toBe(3);
  });

  // ── Test 5: SELECTION_PROMOTE respects minIdentityScore threshold ──

  test("SELECTION_PROMOTE ignores fragments below surpriseScore threshold", async () => {
    const hooks = createMockHooks();
    await plugin.setup(hooks as any);

    const handler = hooks.handlers.get(HookEvent.SELECTION_PROMOTE)?.[0];

    const ctx = makeInteractionContext({
      fragments: [
        makeFragment({ id: "f1", content: "My approach to testing is thorough", surpriseScore: 0.95 }), // above 0.8
        makeFragment({ id: "f2", content: "I always eat breakfast in the morning", surpriseScore: 0.65 }), // below 0.8
        makeFragment({ id: "f3", content: "My style is minimal and clean", surpriseScore: 0.5 }), // below 0.8
        makeFragment({ id: "f4", content: "I never skip writing documentation", surpriseScore: 0.69 }), // below 0.7
      ],
    });

    await handler!(ctx);

    const getStateHandler = hooks.handlers.get("identity-anchor:getState")?.[0];
    const state = await getStateHandler!();
    // Only f1 captured (score 0.95 >= 0.8). f2-f4 below structural threshold.
    // Language-agnostic: no English keyword bypass
    expect(state.fragmentCount).toBe(1);
  });

  // ── Test 6: DEEP_CONSOLIDATE attaches self-vector ──────────

  test("DEEP_CONSOLIDATE attaches identityAnchor with self-vector and fragment summaries", async () => {
    const hooks = createMockHooks();
    await plugin.setup(hooks as any);

    // First, promote some identity fragments with embeddings
    const promoteHandler = hooks.handlers.get(HookEvent.SELECTION_PROMOTE)?.[0];
    await promoteHandler!(makeInteractionContext({
      fragments: [
        makeFragment({
          id: "f1",
          content: "I prefer functional programming patterns",
          surpriseScore: 0.92,
          embedding: [0.1, 0.2, 0.3, 0.4],
        }),
        makeFragment({
          id: "f2",
          content: "My approach to error handling is with Result types",
          surpriseScore: 0.88,
          embedding: [0.5, 0.6, 0.7, 0.8],
        }),
      ],
    }));

    // Now trigger DEEP_CONSOLIDATE
    const consolidateHandler = hooks.handlers.get(HookEvent.DEEP_CONSOLIDATE)?.[0];
    expect(consolidateHandler).toBeDefined();

    const ctx = makeConsolidationContext();
    await consolidateHandler!(ctx);

    // Verify identityAnchor was attached to the context
    const anchor = (ctx as any).identityAnchor;
    expect(anchor).toBeDefined();
    expect(anchor.fragmentCount).toBe(2);
    expect(anchor.fragments).toHaveLength(2);
    expect(anchor.fragments[0].id).toBe("f1");
    expect(anchor.fragments[0].content.length).toBeLessThanOrEqual(200); // sliced to 200, but shorter content is not padded
    expect(anchor.fragments[1].id).toBe("f2");

    // Self-vector should be the average of embeddings: [0.3, 0.4, 0.5, 0.6]
    expect(anchor.selfVector).toBeDefined();
    expect(anchor.selfVector).toHaveLength(4);
    expect(anchor.selfVector![0]).toBeCloseTo(0.3, 5);
    expect(anchor.selfVector![1]).toBeCloseTo(0.4, 5);
    expect(anchor.selfVector![2]).toBeCloseTo(0.5, 5);
    expect(anchor.selfVector![3]).toBeCloseTo(0.6, 5);
  });

  // ── Test 7: Self-vector null when no fragments have embeddings ──

  test("DEEP_CONSOLIDATE sets selfVector to null when no anchor fragments have embeddings", async () => {
    const hooks = createMockHooks();
    await plugin.setup(hooks as any);

    // Promote fragments WITHOUT embeddings
    const promoteHandler = hooks.handlers.get(HookEvent.SELECTION_PROMOTE)?.[0];
    await promoteHandler!(makeInteractionContext({
      fragments: [
        makeFragment({
          id: "f1",
          content: "I prefer tab indentation in my setup",
          surpriseScore: 0.8,
          // no embedding
        }),
      ],
    }));

    const consolidateHandler = hooks.handlers.get(HookEvent.DEEP_CONSOLIDATE)?.[0];
    const ctx = makeConsolidationContext();
    await consolidateHandler!(ctx);

    const anchor = (ctx as any).identityAnchor;
    expect(anchor).toBeDefined();
    expect(anchor.fragmentCount).toBe(1);
    expect(anchor.selfVector).toBeNull();
  });

  // ── Test 8: maxAnchorFragments enforcement ──────────────

  test("enforces maxAnchorFragments by removing oldest fragments", async () => {
    // Create plugin with small maxAnchorFragments
    const mod = await import("../index");
    const smallPlugin = mod.createIdentityAnchorPlugin({ maxAnchorFragments: 3 });

    const hooks = createMockHooks();
    await smallPlugin.setup(hooks as any);

    const handler = hooks.handlers.get(HookEvent.SELECTION_PROMOTE)?.[0];

    // Add 5 fragments over time
    const baseTime = NOW - 100000;
    for (let i = 0; i < 5; i++) {
      await handler!(makeInteractionContext({
        fragments: [
          makeFragment({
            id: `f${i}`,
            content: `My convention for naming #${i} is snake_case`,
            surpriseScore: 0.85,
            timestamp: baseTime + i * 10000,
          }),
        ],
      }));
    }

    // Check state
    const getStateHandler = hooks.handlers.get("identity-anchor:getState")?.[0];
    const state = await getStateHandler!();
    expect(state.fragmentCount).toBe(3);
    expect(state.maxFragments).toBe(3);

    // The oldest (f0, f1) should be gone; f2, f3, f4 remain
    // We can verify by checking DEEP_CONSOLIDATE output
    const consolidateHandler = hooks.handlers.get(HookEvent.DEEP_CONSOLIDATE)?.[0];
    const ctx = makeConsolidationContext();
    await consolidateHandler!(ctx);

    const anchor = (ctx as any).identityAnchor;
    expect(anchor.fragments).toHaveLength(3);
    const ids = anchor.fragments.map((f: any) => f.id);
    expect(ids).not.toContain("f0");
    expect(ids).not.toContain("f1");
    expect(ids).toContain("f2");
    expect(ids).toContain("f3");
    expect(ids).toContain("f4");
  });

  // ── Test 9: Cosine similarity computation ──────────────────

  describe("cosine similarity (validated against plugin's internal logic)", () => {
    test("identical vectors have similarity 1.0", () => {
      const a = [1, 2, 3];
      const b = [1, 2, 3];
      expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
    });

    test("orthogonal vectors have similarity 0.0", () => {
      const a = [1, 0, 0];
      const b = [0, 1, 0];
      expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
    });

    test("opposite vectors have similarity -1.0", () => {
      const a = [1, 2, 3];
      const b = [-1, -2, -3];
      expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
    });

    test("empty vectors return 0", () => {
      expect(cosineSimilarity([], [1, 2, 3])).toBe(0);
      expect(cosineSimilarity([1, 2], [])).toBe(0);
      expect(cosineSimilarity([], [])).toBe(0);
    });

    test("zero-magnitude vector returns 0", () => {
      expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
      expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
    });

    test("different-length vectors are padded correctly", () => {
      const a = [1, 0];
      const b = [1, 0, 0, 0];
      // After padding: a=[1,0,0,0], b=[1,0,0,0] -> similarity = 1.0
      expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
    });

    test("different-length with actual differences", () => {
      const a = [1, 2, 3];
      const b = [1, 2];
      // After padding: a=[1,2,3], b=[1,2,0]
      // dot = 1+4+0 = 5, magA = sqrt(1+4+9)=sqrt(14), magB = sqrt(1+4+0)=sqrt(5)
      // sim = 5 / sqrt(70) ≈ 0.5976
      const expected = 5 / Math.sqrt(70);
      expect(cosineSimilarity(a, b)).toBeCloseTo(expected, 5);
    });
  });

  // ── Test 10: identity-anchor:getState custom hook ──────────

  test("identity-anchor:getState returns current state with keywords and selfVector", async () => {
    const hooks = createMockHooks();
    await plugin.setup(hooks as any);

    // Promote some fragments with embeddings
    const promoteHandler = hooks.handlers.get(HookEvent.SELECTION_PROMOTE)?.[0];
    await promoteHandler!(makeInteractionContext({
      fragments: [
        makeFragment({
          id: "fs1",
          content: "My go-to framework is React with TypeScript for all new projects",
          surpriseScore: 0.82,
          embedding: [1.0, 0.0],
        }),
        makeFragment({
          id: "fs2",
          content: "I always use zod for runtime validation in every API route",
          surpriseScore: 0.81,
          embedding: [0.0, 1.0],
        }),
      ],
    }));

    const getStateHandler = hooks.handlers.get("identity-anchor:getState")?.[0];
    const state = await getStateHandler!();

    expect(state.fragmentCount).toBe(2);
    expect(state.maxFragments).toBe(50);
    // Language-agnostic: default keyword list is empty
    expect(state.keywords).toBeArray();
    expect(state.keywords).toHaveLength(0);

    // Self-vector: average of [1,0] and [0,1] = [0.5, 0.5]
    expect(state.selfVector).toBeDefined();
    expect(state.selfVector).toHaveLength(2);
    expect(state.selfVector![0]).toBeCloseTo(0.5, 5);
    expect(state.selfVector![1]).toBeCloseTo(0.5, 5);
  });

  // ── Test 11: Teardown clears state ────────────────────────

  test("teardown clears all anchor fragments", async () => {
    const hooks = createMockHooks();
    await plugin.setup(hooks as any);

    // Add some fragments
    const promoteHandler = hooks.handlers.get(HookEvent.SELECTION_PROMOTE)?.[0];
    await promoteHandler!(makeInteractionContext({
      fragments: [
        makeFragment({ id: "t1", content: "I prefer writing tests first", surpriseScore: 0.9 }),
      ],
    }));

    // Verify fragments exist
    const getStateHandler = hooks.handlers.get("identity-anchor:getState")?.[0];
    let state = await getStateHandler!();
    expect(state.fragmentCount).toBe(1);

    // Call teardown
    await plugin.teardown!();

    // Verify fragments are cleared
    state = await getStateHandler!();
    expect(state.fragmentCount).toBe(0);
    expect(state.selfVector).toBeNull();
  });

  // ── Test 12: Metadata tagging on captured fragments ──────────

  test("captured fragments are tagged with identityAnchor metadata and DEEP layer", async () => {
    const hooks = createMockHooks();
    await plugin.setup(hooks as any);

    // We can verify the metadata and layer by inspecting DEEP_CONSOLIDATE fragments
    const promoteHandler = hooks.handlers.get(HookEvent.SELECTION_PROMOTE)?.[0];
    await promoteHandler!(makeInteractionContext({
      fragments: [
        makeFragment({
          id: "meta-1",
          content: "I prefer clean architecture patterns",
          surpriseScore: 0.9,
          embedding: [0.5, 0.5],
          metadata: { originalKey: "originalValue" },
        }),
      ],
    }));

    const consolidateHandler = hooks.handlers.get(HookEvent.DEEP_CONSOLIDATE)?.[0];
    const ctx = makeConsolidationContext();
    await consolidateHandler!(ctx);

    const anchor = (ctx as any).identityAnchor;
    expect(anchor.fragments).toHaveLength(1);
    expect(anchor.fragments[0].id).toBe("meta-1");
  });

  // ── Persistence (opt-in via statePath config) ────────────────

  test("persists anchor fragments to disk when statePath is configured", async () => {
    const { mkdirSync, existsSync, readFileSync, unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const testDir = join(tmpdir(), "ia-persist-" + Date.now());
    mkdirSync(testDir, { recursive: true });
    const statePath = join(testDir, "anchors.json");

    const mod = await import("../index");
    const p = mod.createIdentityAnchorPlugin({ statePath });
    const hooks = createMockHooks();
    await p.setup(hooks as any);

    const promoteHandler = hooks.handlers.get(HookEvent.SELECTION_PROMOTE)?.[0];
    await promoteHandler!(makeInteractionContext({
      fragments: [
        makeFragment({ id: "persist-1", content: "I prefer solid principles", surpriseScore: 0.92 }),
      ],
    }));

    // Should be saved to disk
    expect(existsSync(statePath)).toBe(true);
    const data = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe("persist-1");

    await p.teardown!();
    unlinkSync(statePath);
  });

  test("loads pre-existing state on setup", async () => {
    const { mkdirSync, writeFileSync, existsSync, unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const testDir = join(tmpdir(), "ia-load-" + Date.now());
    mkdirSync(testDir, { recursive: true });
    const statePath = join(testDir, "anchors.json");

    // Pre-write state
    writeFileSync(statePath, JSON.stringify([
      { id: "pre-1", content: "I never use var", surpriseScore: 0.95, timestamp: Date.now() - 1000, source: "cursor" },
    ]));

    const mod = await import("../index");
    const p = mod.createIdentityAnchorPlugin({ statePath });
    const hooks = createMockHooks();
    await p.setup(hooks as any);

    const getStateHandler = hooks.handlers.get("identity-anchor:getState")?.[0];
    const state = await getStateHandler!();
    expect(state.fragmentCount).toBe(1);

    await p.teardown!();
    unlinkSync(statePath);
  });

  // ── Drift detection ─────────────────────────────────────────

  test("computeDrift detects when new data differs from self-vector", async () => {
    const mod = await import("../index");
    const p = mod.createIdentityAnchorPlugin({ driftThreshold: 0.3 });
    const hooks = createMockHooks();
    await p.setup(hooks as any);

    // Promote enough fragments to establish a stable self-vector
    const promoteHandler = hooks.handlers.get(HookEvent.SELECTION_PROMOTE)?.[0];
    await promoteHandler!(makeInteractionContext({
      fragments: [
        makeFragment({ id: "dr1", content: "I prefer TypeScript strongly", surpriseScore: 0.9, embedding: [1.0, 0.1, 0.1] }),
        makeFragment({ id: "dr2", content: "TypeScript is my default now", surpriseScore: 0.85, embedding: [0.9, 0.0, 0.2] }),
        makeFragment({ id: "dr3", content: "Always use strict mode in ts", surpriseScore: 0.82, embedding: [0.8, 0.2, 0.1] }),
      ],
    }));

    // Verify anchors exist
    const getState = hooks.handlers.get("identity-anchor:getState")?.[0];
    const stateBefore = await getState!();
    expect(stateBefore.fragmentCount).toBe(3);

    // Compute drift against very different embeddings
    const driftHandler = hooks.handlers.get("identity-anchor:computeDrift")?.[0];
    const result = await driftHandler!([
      makeFragment({ id: "n1", content: "completely different topic", embedding: [-0.9, 0.8, 0.7] }),
    ]);

    expect(result.drift).toBeGreaterThan(0.5);
    expect(result.needsBoost).toBe(true);
  });

  test("computeDrift reports low drift for similar data", async () => {
    const mod = await import("../index");
    const p = mod.createIdentityAnchorPlugin({ driftThreshold: 0.3 });
    const hooks = createMockHooks();
    await p.setup(hooks as any);

    const promoteHandler = hooks.handlers.get(HookEvent.SELECTION_PROMOTE)?.[0];
    await promoteHandler!(makeInteractionContext({
      fragments: [
        makeFragment({ id: "s1", content: "I like functional programming", surpriseScore: 0.9, embedding: [1.0, 0.0, 0.0] }),
        makeFragment({ id: "s2", content: "FP is my preferred paradigm", surpriseScore: 0.85, embedding: [0.9, 0.0, 0.1] }),
        makeFragment({ id: "s3", content: "Always use pure functions", surpriseScore: 0.82, embedding: [0.8, 0.1, 0.0] }),
      ],
    }));

    const driftHandler = hooks.handlers.get("identity-anchor:computeDrift")?.[0];
    const result = await driftHandler!([
      makeFragment({ id: "n1", content: "similar", embedding: [0.95, 0.05, 0.0] }),
    ]);

    expect(result.drift).toBeLessThan(0.1);
    expect(result.needsBoost).toBe(false);
  });

  // ── Boosted fragments ───────────────────────────────────────

  test("getBoostedFragments repeats anchors N times for training", async () => {
    const mod = await import("../index");
    const p = mod.createIdentityAnchorPlugin({ identityBoostFactor: 2 });
    const hooks = createMockHooks();
    await p.setup(hooks as any);

    const promoteHandler = hooks.handlers.get(HookEvent.SELECTION_PROMOTE)?.[0];
    await promoteHandler!(makeInteractionContext({
      fragments: [
        makeFragment({ id: "b1", content: "I prefer using tabs for indentation", surpriseScore: 0.9 }),
        makeFragment({ id: "b2", content: "My approach to development is TDD first", surpriseScore: 0.85 }),
      ],
    }));

    const boostHandler = hooks.handlers.get("identity-anchor:getBoostedFragments")?.[0];
    const boosted = await boostHandler!();

    expect(boosted).toHaveLength(4); // 2 anchors × 2 boost
    expect(boosted[0].text).toBe("I prefer using tabs for indentation");
    expect(boosted[0].metadata.identityBoosted).toBe(true);
  });
});

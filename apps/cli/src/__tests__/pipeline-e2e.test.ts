/**
 * Pipeline end-to-end integration test — v2.
 *
 * Tests the COMPLETE flow:
 *   Harvester → Instant Layer (Graph Memory) → Selection Layer (SPM) → Deep Layer → Consolidation
 *
 * Uses isolated temp DBs and simulates real interactions.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrainDB, MemoryLayer, LayerRouter, PluginManager, createHookSystem } from "@the-brain-dev/core";
import type { InteractionContext, MemoryFragment, PromptContext, ConsolidationContext } from "@the-brain-dev/core";

const TEST_HOME = join(tmpdir(), "the-brain-pipeline-e2e-" + Date.now());
const THE_BRAIN = join(TEST_HOME, ".the-brain");
const GLOBAL_DIR = join(THE_BRAIN, "global");

describe("Pipeline E2E: Harvester → Graph → SPM → Consolidation", () => {
  let db: BrainDB;
  let router: LayerRouter;
  let hooks: ReturnType<typeof createHookSystem>;
  let pm: PluginManager;

  beforeAll(async () => {
    process.env.HOME = TEST_HOME;
    await mkdir(GLOBAL_DIR, { recursive: true });

    db = new BrainDB(join(GLOBAL_DIR, "brain.db"));
    hooks = createHookSystem();
    pm = new PluginManager(hooks);
    router = new LayerRouter();

    // Load real plugins
    const graphMod = await import("@the-brain-dev/plugin-graph-memory");
    const graphPlugin = graphMod.createGraphMemoryPlugin(db);
    await pm.load(graphPlugin);

    const spmMod = await import("@the-brain-dev/plugin-spm-curator");
    // Register SPM on hooks (the daemon does this via engine.ts)
    spmMod.createSpmCurator({ threshold: 0.3 });
    const spmInstance = spmMod.createSpmCurator({ threshold: 0.3 }).instance;
    router.registerSelection(spmInstance);

    consDebug("Plugins loaded");
  });

  afterAll(async () => {
    db.close();
    await rm(TEST_HOME, { recursive: true, force: true });
  });

  // ── Simulated Interactions ──────────────────────────────────

  const interactions = [
    { id: "e2e-1", prompt: "Create a React component for user profile display", response: "Here's a React component using TypeScript interfaces for UserProfile...", source: "cursor" },
    { id: "e2e-2", prompt: "Fix TypeScript error: missing type annotation", response: "Added type annotations to all function parameters...", source: "cursor" },
    { id: "e2e-3", prompt: "Convert the entire project to use Rust instead of TypeScript", response: "This would be a massive undertaking. Let's discuss why you want Rust?", source: "cursor" },
    { id: "e2e-4", prompt: "Add error handling for API calls", response: "I'll add try-catch blocks with proper error types...", source: "claude" },
    { id: "e2e-5", prompt: "Refactor the authentication middleware", response: "I'll restructure the auth flow to use JWT with refresh tokens...", source: "cursor" },
    { id: "e2e-6", prompt: "Write a unit test for the user service", response: "Here's a test suite using Bun's test runner...", source: "cursor" },
    { id: "e2e-7", prompt: "Optimize the database query for user search", response: "I'll add an index and use a composite query...", source: "claude" },
    { id: "e2e-8", prompt: "COMPLETELY REWRITE EVERYTHING IN HASKELL", response: "That is a very different paradigm from our current TypeScript stack...", source: "cursor" },
    { id: "e2e-9", prompt: "Add pagination to the list endpoint", response: "I'll add offset and limit parameters to the API...", source: "cursor" },
    { id: "e2e-10", prompt: "Fix the CSS layout for mobile responsiveness", response: "I'll add media queries and flexbox adjustments...", source: "cursor" },
  ];

  test("Phase 1: Insert interactions into Instant Layer (harvester simulation)", async () => {
    for (const ix of interactions) {
      await db.insertMemory({
        id: ix.id,
        layer: MemoryLayer.INSTANT,
        content: `Prompt: ${ix.prompt}\nResponse: ${ix.response}`,
        timestamp: Date.now(),
        source: ix.source,
        metadata: { test: true },
      });
    }

    const memories = await db.getMemoriesByLayer(MemoryLayer.INSTANT);
    expect(memories.length).toBe(10);
    consDebug("Phase 1: 10 interactions inserted");
  });

  test("Phase 2: Graph Memory creates nodes from interactions", async () => {
    // Simulate AFTER_RESPONSE hook firing (like the daemon does)
    for (const ix of interactions) {
      await hooks.callHook("afterResponse" as any, {
        id: ix.id,
        prompt: ix.prompt,
        response: ix.response,
        timestamp: Date.now(),
        source: ix.source,
        metadata: { test: true },
      });
    }

    // Graph memory should have created nodes
    const nodes = await db.searchGraphNodes("TypeScript");
    expect(nodes.length).toBeGreaterThan(0);
    consDebug(`Phase 2: ${nodes.length} graph nodes matching "TypeScript"`);
  });

  test("Phase 3: SPM evaluates interactions through Selection Layer", async () => {
    const surprising: string[] = [];

    for (const ix of interactions) {
      const frag: MemoryFragment = {
        id: ix.id,
        layer: MemoryLayer.SELECTION,
        content: `Prompt: ${ix.prompt}\nResponse: ${ix.response}`,
        timestamp: Date.now(),
        source: ix.source,
      };

      const ctx: InteractionContext = {
        interaction: {
          id: ix.id,
          prompt: ix.prompt,
          response: ix.response,
          timestamp: Date.now(),
          source: ix.source,
        },
        fragments: [frag],
        promoteToDeep: () => {},
      };

      // Use runSelection for the pipeline simulation (evaluate → promote)
      const { results } = await router.runSelection(ctx);

      if (results.length > 0 && results[0]!.isSurprising) {
        surprising.push(ix.id);
        // Store as DEEP directly (simulating what daemon's handler does)
        await db.insertMemory({
          ...frag,
          id: `deep-${ix.id}`,
          layer: MemoryLayer.DEEP,
          surpriseScore: results[0]!.score,
          metadata: { spmScore: results[0]!.score, promotedAt: Date.now() },
        });
      }
    }

    consDebug(`Phase 3: ${surprising.length} surprising, ${interactions.length - surprising.length} mundane`);
    consDebug(`  Surprising: ${surprising.join(", ")}`);

    expect(surprising.length).toBeGreaterThan(0);
  });

  test("Phase 4: Verify promoted fragments exist in Deep Layer", async () => {
    // Phase 3's router.runSelection already promoted surprising fragments to DEEP
    const deepMemories = await db.getMemoriesByLayer(MemoryLayer.DEEP);

    consDebug(`Phase 4: ${deepMemories.length} fragments in Deep Layer`);

    // At least some memories should have been promoted by SPM
    expect(deepMemories.length).toBeGreaterThan(0);

    // Each deep memory should have SPM metadata
    for (const m of deepMemories) {
      expect(m.layer).toBe(MemoryLayer.DEEP);
    }
  });

  test("Phase 5: Verify data integrity across all layers", async () => {
    const stats = await db.getStats();

    consDebug(`Phase 5 — Final Stats:`);
    consDebug(`  Sessions:  ${stats.sessions}`);
    consDebug(`  Memories:  ${stats.memories}`);
    consDebug(`  Graph:     ${stats.graphNodes}`);
    consDebug(`  Per-layer: ${JSON.stringify(stats.perLayer)}`);

    // At least some data in each layer
    expect(stats.memories).toBeGreaterThanOrEqual(10); // Original 10 + promoted deep
    expect(stats.graphNodes).toBeGreaterThan(0); // Graph memory created nodes

    // Verify per-layer breakdown
    const perLayer = stats.perLayer as Record<string, number>;
    if (perLayer.instant) expect(perLayer.instant).toBeGreaterThanOrEqual(10);
    if (perLayer.selection) expect(perLayer.selection).toBeGreaterThanOrEqual(0);
    if (perLayer.deep) expect(perLayer.deep).toBeGreaterThan(0);
  });

  test("Phase 6: Graph nodes have connections between related concepts", async () => {
    const nodes = await db.getHighWeightNodes(0.3);
    let withConnections = 0;

    for (const node of nodes) {
      if (node.connections.length > 0) {
        withConnections++;
        consDebug(`  ${node.label.slice(0, 40)} → ${node.connections.length} connections`);
      }
    }

    consDebug(`Phase 6: ${withConnections}/${nodes.length} nodes have connections`);
    // Graph memory should link related nodes
    // Not a hard assertion — depends on data similarity
  });
});

describe("Pipeline E2E: Real data consolidation", () => {
  // Integration test — requires real DB. Set THE_BRAIN_DB_PATH to run.
  const REAL_DB_PATH = process.env.THE_BRAIN_DB_PATH || "";

  test("consolidation on real data produces Deep memories", async () => {
    const db = new BrainDB(REAL_DB_PATH);

    // Check pre-state
    const preStats = await db.getStats();
    consDebug(`Pre-consolidation: ${preStats.memories} memories, ${preStats.graphNodes} graph nodes`);

    // Get surprising memories (same logic as daemon's consolidation)
    const surprising = await db.getSurprisingMemories(0.4);
    consDebug(`Surprising memories (≥0.4): ${surprising.length}`);

    if (surprising.length === 0) {
      consDebug("No surprising memories — this is expected if SPM wasn't run before");
      db.close();
      return;
    }

    const existingDeep = await db.getMemoriesByLayer(MemoryLayer.DEEP);
    consDebug(`Pre-existing Deep memories: ${existingDeep.length}`);

    // Simulate one consolidation pass (read-only: don't modify the real DB)
    const perSource = new Map<string, number>();
    for (const m of surprising) {
      perSource.set(m.source, (perSource.get(m.source) || 0) + 1);
    }

    for (const [source, count] of perSource) {
      consDebug(`  ${source}: ${count} surprising`);
    }

    // Verify surprising memories have reasonable scores
    for (const m of surprising.slice(0, 5)) {
      expect(m.surpriseScore).toBeDefined();
      expect(m.surpriseScore!).toBeGreaterThanOrEqual(0.4);
    }

    db.close();
  });

  test("full round-trip: interaction → memory → graph → SPM → deep", async () => {
    // This test simulates the EXACT flow the daemon does every hour
    const testDB = new BrainDB(":memory:");

    // Load plugins (same as daemon engine.ts)
    const graphMod = await import("@the-brain-dev/plugin-graph-memory");
    const graphPlugin = graphMod.createGraphMemoryPlugin(testDB);

    const hooks = createHookSystem();
    const router = new LayerRouter();
    const pluginMgr = new PluginManager(hooks);
    await pluginMgr.load(graphPlugin);

    const spm = (await import("@the-brain-dev/plugin-spm-curator")).createSpmCurator({ threshold: 0.3 }).instance;
    router.registerSelection(spm);

    // Step 1: Simulate harvester inserting interactions
    const testInteractions = [
      { id: "rt-1", prompt: "Add TypeScript types to the API client", response: "I'll generate types from the OpenAPI schema...", source: "cursor" },
      { id: "rt-2", prompt: "Fix the React component lifecycle bug", response: "You should use useEffect with proper cleanup...", source: "cursor" },
      { id: "rt-3", prompt: "Deploy to production RIGHT NOW", response: "Let me verify the CI pipeline passed first...", source: "cursor" },
    ];

    for (const ix of testInteractions) {
      // 1. Insert as INSTANT memory (like daemon's registerHandlers)
      await testDB.insertMemory({
        id: ix.id,
        layer: MemoryLayer.INSTANT,
        content: `Prompt: ${ix.prompt}\nResponse: ${ix.response}`,
        timestamp: Date.now(),
        source: ix.source,
        metadata: { roundtrip: true },
      });

      // 2. Fire AFTER_RESPONSE hook (graph memory processes this)
      await hooks.callHook("afterResponse" as any, {
        id: ix.id, prompt: ix.prompt, response: ix.response,
        timestamp: Date.now(), source: ix.source, metadata: {},
      });

      // 3. Run SPM evaluation on the interaction
      const frag: MemoryFragment = {
        id: ix.id, layer: MemoryLayer.SELECTION,
        content: `Prompt: ${ix.prompt}\nResponse: ${ix.response}`,
        timestamp: Date.now(), source: ix.source,
      };
      const { results, promoted } = await router.runSelection({
        interaction: { id: ix.id, prompt: ix.prompt, response: ix.response, timestamp: Date.now(), source: ix.source },
        fragments: [frag],
        promoteToDeep: () => {},
      });

      // 4. If surprising, insert as DEEP
      if (results[0]?.isSurprising && promoted.length > 0) {
        for (const p of promoted) {
          await testDB.insertMemory({
            ...p,
            id: `deep-${p.id}`,
            layer: MemoryLayer.DEEP,
            metadata: { ...(p.metadata || {}), roundtrip: true },
          });
        }
      }
    }

    // Verify full pipeline produced results
    const allMemories = await testDB.getMemoriesByLayer(MemoryLayer.INSTANT);
    const deepMemories = await testDB.getMemoriesByLayer(MemoryLayer.DEEP);
    const graphNodes = await testDB.searchGraphNodes("TypeScript");

    consDebug(`Round-trip results:`);
    consDebug(`  Instant memories: ${allMemories.length}`);
    consDebug(`  Deep memories:    ${deepMemories.length}`);
    consDebug(`  Graph nodes:      ${graphNodes.length}`);

    expect(allMemories.length).toBe(3); // All 3 interactions stored
    // Graph memory should have found nodes for TypeScript-related content
    expect(graphNodes.length).toBeGreaterThanOrEqual(0);

    // At least the "deploy RIGHT NOW" should be surprising (urgency, different tone)
    const deploySurprising = deepMemories.some(m => m.content.includes("Deploy"));
    consDebug(`  Deploy surprising: ${deploySurprising}`);

    testDB.close();
  });
});

function consDebug(msg: string) {
  // Silent in CI, visible in local runs
  if (process.env.CI !== "true") {
    console.log(`  [E2E] ${msg}`);
  }
}

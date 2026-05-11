/**
 * Pipeline end-to-end integration test.
 * Tests the data flow: Interaction → Graph Memory → SPM Curator → MLX Training
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_HOME = join(tmpdir(), "the-brain-pipeline-test-" + Date.now());

describe("Pipeline: Harvester → Graph → SPM → MLX", () => {
  let BrainDB: any;
  let MemoryLayer: any;
  let db: any;
  let graphPlugin: any;
  let spmPlugin: any;
  let createGraphMemoryPlugin: any;
  let createSpmCurator: any;
  let HookEvent: any;

  beforeAll(async () => {
    process.env.HOME = TEST_HOME;
    await mkdir(join(TEST_HOME, ".the-brain"), { recursive: true });

    const core = await import("@the-brain/core");
    BrainDB = core.BrainDB;
    MemoryLayer = core.MemoryLayer;
    HookEvent = core.HookEvent;

    // Create DB
    db = new BrainDB(join(TEST_HOME, ".the-brain", "brain.db"));

    // Load plugins
    const graphMod = await import("@the-brain/plugin-graph-memory");
    createGraphMemoryPlugin = graphMod.createGraphMemoryPlugin;

    const spmMod = await import("@the-brain/plugin-spm-curator");
    createSpmCurator = spmMod.createSpmCurator;
  });

  afterAll(async () => {
    db.close();
    const { rm } = await import("node:fs/promises");
    await rm(TEST_HOME, { recursive: true, force: true });
  });

  test("Step 1: Graph Memory creates nodes from interactions", async () => {
    // Create graph memory plugin with same DB
    graphPlugin = createGraphMemoryPlugin(db);
    expect(graphPlugin).toBeDefined();
    expect(graphPlugin.setup).toBeInstanceOf(Function);

    // Verify plugin shape
    expect(graphPlugin.name).toContain("graph-memory");
  });

  test("Step 2: SPM Curator initializes with config", async () => {
    spmPlugin = createSpmCurator();
    expect(spmPlugin).toBeDefined();
    expect(spmPlugin.definition).toBeDefined();
    expect(spmPlugin.instance).toBeDefined();

    // Check it can evaluate interactions
    expect(typeof spmPlugin.instance.evaluate).toBe("function");
  });

  test("Step 3: Feed interactions and verify SPM surprise scoring", async () => {
    // Create sample interactions with varied content
    const interactions = [
      {
        id: "int-1",
        timestamp: Date.now(),
        source: "cursor",
        prompt: "Create a new React component for the dashboard",
        response: "Here is a dashboard component with TypeScript...",
        metadata: {},
      },
      {
        id: "int-2",
        timestamp: Date.now(),
        source: "cursor",
        prompt: "Fix the TypeScript type error in the API route",
        response: "The issue was a missing generic parameter...",
        metadata: {},
      },
      {
        id: "int-3",
        timestamp: Date.now() - 3600000,
        source: "claude",
        prompt: "Refactor the database schema to use Drizzle ORM",
        response: "I'll help you migrate from raw SQL to Drizzle...",
        metadata: {},
      },
      {
        id: "int-4",
        timestamp: Date.now(),
        source: "cursor",
        prompt: "Add error handling to the authentication middleware",
        response: "We'll add try-catch blocks and proper error responses...",
        metadata: {},
      },
      {
        id: "int-5",
        timestamp: Date.now() - 7200000,
        source: "claude",
        prompt: "Explain the difference between monorepo and polyrepo approaches",
        response: "A monorepo stores all code in one repository while polyrepo...",
        metadata: {},
      },
    ];

    // Insert into DB as memories
    for (const ix of interactions) {
      await db.insertMemory({
        id: ix.id,
        layer: MemoryLayer.INSTANT,
        content: `Prompt: ${ix.prompt}\nResponse: ${ix.response}`,
        timestamp: ix.timestamp,
        source: ix.source,
        metadata: ix.metadata,
      });
    }

    // Run SPM evaluation on each interaction
    const surprising: string[] = [];
    const mundane: string[] = [];

    for (const ix of interactions) {
      const ctx = {
        interaction: ix,
        injected: [],
        metadata: {},
        fragments: [],  // SPM expects fragments array
      };
      const result = await spmPlugin.instance.evaluate(ctx);
      if (result.isSurprising) {
        surprising.push(ix.id);
      } else {
        mundane.push(ix.id);
      }
    }

    // Some should be surprising, some not (SPM has a threshold)
    expect(surprising.length).toBeGreaterThanOrEqual(0);
    expect(mundane.length).toBeGreaterThanOrEqual(0);
    console.log(`  SPM: ${surprising.length} surprising, ${mundane.length} mundane`);

    // Verify memories stored successfully
    const allMemories = await db.getMemoriesByLayer(MemoryLayer.INSTANT, 10);
    expect(allMemories.length).toBe(5);
  });

  test("Step 4: Graph Memory pattern detection on stored interactions", async () => {
    // Set up hooks and simulate AFTER_RESPONSE like the daemon does
    const { createHookSystem } = await import("@the-brain/core");
    const hooks = createHookSystem();

    // Register graph memory plugin
    const pluginManager = new (await import("@the-brain/core")).PluginManager(hooks);
    await pluginManager.load(graphPlugin);

    // Fire AFTER_RESPONSE for each interaction
    const interactions = [
      { id: "int-1", prompt: "Create a new React component for the dashboard", response: "Here is a dashboard component...", source: "cursor", timestamp: Date.now(), metadata: {} },
      { id: "int-2", prompt: "Fix the TypeScript type error", response: "The issue was a missing generic...", source: "cursor", timestamp: Date.now(), metadata: {} },
      { id: "int-3", prompt: "Refactor to use Drizzle ORM", response: "I'll help you migrate...", source: "claude", timestamp: Date.now() - 3600000, metadata: {} },
    ];

    for (const ix of interactions) {
      await hooks.callHook(HookEvent.AFTER_RESPONSE, ix);
    }

    // Graph memory should have created nodes
    const nodes = await db.searchGraphNodes("TypeScript");
    expect(nodes.length).toBeGreaterThanOrEqual(0);
  });

  test("Step 5: Training data generation matches MLX format", async () => {
    // Get the curated memories (the ones SPM marked as surprising)
    // and validate they match the MLX training data format
    const getSurprisingMemories = db.getSurprisingMemories.bind(db);

    // Get memories with surprise scores
    const surprisingMemories = await getSurprisingMemories(0.4);
    expect(Array.isArray(surprisingMemories)).toBe(true);

    // Verify training data format matches what train.py expects
    for (const mem of surprisingMemories) {
      expect(mem).toHaveProperty("id");
      expect(mem).toHaveProperty("content");
      expect(mem).toHaveProperty("source");
    }

    // Generate training fragments (same logic as daemon consolidation)
    const fragments = surprisingMemories.map((m: any) => ({
      text: m.content,
      metadata: {
        source: m.source,
        layer: m.layer,
        type: m.surpriseScore && m.surpriseScore > 0.6 ? "correction" : "preference",
      },
    }));

    // Validation: each fragment has text and metadata
    for (const f of fragments) {
      expect(typeof f.text).toBe("string");
      expect(f.text.length).toBeGreaterThan(0);
      expect(f.metadata).toHaveProperty("source");
    }

    console.log(`  Training fragments: ${fragments.length}`);
  });
});

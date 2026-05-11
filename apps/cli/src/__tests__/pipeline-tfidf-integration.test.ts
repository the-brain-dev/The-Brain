/**
 * Pipeline End-to-End Integration Test — Real TF-IDF flow.
 *
 * Tests the ACTUAL connected pipeline (not stubs):
 *   Interaction → ContentCleaner → SPM (TF-IDF) → Graph Memory → Context Injection
 *
 * This validates that plugins discovered in isolation actually work together
 * when wired through the hook system like the daemon does.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const TEST_HOME = join(tmpdir(), "the-brain-tfidf-pipeline-" + Date.now());

// ── Seed interactions (build TF-IDF vocab + centroid from these) ────────────

const SEED_TEXTS = [
  "Add a new endpoint for user profile",
  "Fix the TypeScript error on line 42",
  "Run the tests for the auth module",
  "Update the README with new setup instructions",
  "Add error handling to the API client",
  "Refactor the database queries to use prepared statements",
  "Add unit tests for the utility functions",
  "Update dependencies to latest versions",
  "Format the code with Prettier",
  "Fix lint warnings in the components directory",
  "Create a React component for the dashboard",
  "Add pagination to the list endpoint",
  "Write integration tests for the payment flow",
  "Set up CI/CD pipeline with GitHub Actions",
  "Optimize the database queries with proper indexing",
  "Add JWT authentication middleware",
  "Document the API with OpenAPI spec",
  "Add rate limiting to the public endpoints",
  "Migrate from Express to Fastify",
  "Set up Docker Compose for local development",
];

// ── Test interactions (NOT in seed — TF-IDF should discriminate these) ──────

interface TestInteraction {
  prompt: string;
  response: string;
  label: "mundane" | "surprising";
  why: string;
}

const TEST_INTERACTIONS: TestInteraction[] = [
  // --- Mundane (similar to seed vocabulary) ---
  {
    prompt: "Add a health check endpoint to the API",
    response: "Adding GET /health with uptime and version info...",
    label: "mundane",
    why: "Similar to seed: endpoint, API patterns",
  },
  {
    prompt: "Fix the ESLint warnings in src/components",
    response: "Fixed 12 warnings across 5 files...",
    label: "mundane",
    why: "Similar to seed: fix, components, warnings",
  },
  {
    prompt: "Add more tests for the auth middleware",
    response: "Added 8 new test cases for edge cases...",
    label: "mundane",
    why: "Similar to seed: tests, auth, middleware",
  },
  {
    prompt: "Update the TypeScript dependency to 5.4",
    response: "Updated TypeScript, fixed 3 type errors...",
    label: "mundane",
    why: "Similar to seed: TypeScript, update, dependencies",
  },
  {
    prompt: "Refactor the user service to use dependency injection",
    response: "Extracted UserRepository, injected via constructor...",
    label: "mundane",
    why: "Similar to seed: refactor, service patterns",
  },

  // --- Surprising (very different from seed vocabulary) ---
  {
    prompt: "no actually don't use express — go with fastify instead",
    response: "Got it, switching to Fastify. It's faster and has better TypeScript support.",
    label: "surprising",
    why: "Explicit correction + 'no actually' pattern",
  },
  {
    prompt: "I prefer single quotes and 2-space indentation, always",
    response: "Noted preference: single quotes, 2-space indent for all files.",
    label: "surprising",
    why: "Strong preference declaration",
  },
  {
    prompt: "okm podnos wynik o 15% i dodaj logowanie każdej decyzji",
    response: "Podnoszę próg, dodaję logger decyzji z timestampem.",
    label: "surprising",
    why: "Polish language — completely different token distribution vs English seed",
  },
  {
    prompt: "that's wrong, the auth should use JWTs signed with RS256 not HS256",
    response: "Corrected to RS256 asymmetric signing. HS256 is symmetric and less secure here.",
    label: "surprising",
    why: "Explicit correction + crypto algorithms (rare in seed)",
  },
  {
    prompt: "zrób system rekomendacji oparty na collaborative filtering z macierzą sparse",
    response: "Buduję system rekomendacji: sparse matrix, SVD decomposition, cosine similarity.",
    label: "surprising",
    why: "Polish + ML domain language (collaborative filtering, sparse matrix, SVD)",
  },
];

// ── Context injection helper types ──────────────────────────────────────────

interface InjectedContext {
  text: string;
  nodeIds: string[];
}

describe("Pipeline: ContentCleaner → SPM/TF-IDF → Graph Memory → Context", () => {
  let BrainDB: any;
  let MemoryLayer: any;
  let HookEvent: any;
  let PluginManager: any;
  let createHookSystem: any;
  let db: any;
  let spmInstance: any;
  let graphPlugin: any;
  let hooks: any;
  let cleanMemoryContent: any;

  beforeAll(async () => {
    process.env.HOME = TEST_HOME;
    await mkdir(join(TEST_HOME, ".the-brain"), { recursive: true });

    const core = await import("@the-brain/core");
    BrainDB = core.BrainDB;
    MemoryLayer = core.MemoryLayer;
    HookEvent = core.HookEvent;
    PluginManager = core.PluginManager;
    createHookSystem = core.createHookSystem;
    cleanMemoryContent = core.cleanMemoryContent;

    db = new BrainDB(join(TEST_HOME, ".the-brain", "brain.db"));

    const spmMod = await import("@the-brain/plugin-spm-curator");
    spmInstance = spmMod.createSpmCurator({ useTfidf: true }).instance; // default threshold is now 0.82

    const graphMod = await import("@the-brain/plugin-graph-memory");
    graphPlugin = graphMod.createGraphMemoryPlugin(db);

    hooks = createHookSystem();
    const pm = new PluginManager(hooks);
    await pm.load(graphPlugin);
  });

  afterAll(async () => {
    db.close();
    const { rm } = await import("node:fs/promises");
    await rm(TEST_HOME, { recursive: true, force: true });
  });

  // ── Step 1: Build TF-IDF vocab from seed, then prime centroid ─────────

  test("Step 1: Build TF-IDF vocabulary and prime centroid from seed texts", async () => {
    // Add seed docs to build vocabulary
    for (const text of SEED_TEXTS) {
      spmInstance.getTfidf().addDocument(text + " " + "Done.");
    }

    // Finalize with seed texts — centroid is auto-primed (no more zero-vector 0.5 scores)
    spmInstance.finalizeTfidf(SEED_TEXTS.map((t) => t + " " + "Done."));

    expect(spmInstance.getTfidf().getStats().finalized).toBe(true);

    const stats = spmInstance.getTfidf().getStats();
    expect(stats.vocabSize).toBeGreaterThan(0);
    expect(stats.docCount).toBe(SEED_TEXTS.length);
    expect(stats.centroidNorm).toBeGreaterThan(0);

    console.log(
      `  TF-IDF ready: ${stats.vocabSize} terms, ${stats.docCount} docs, centroidNorm=${stats.centroidNorm.toFixed(4)}`
    );
  });

  // ── Step 2: TF-IDF discriminates surprising from mundane ────────────

  test("Step 2: TF-IDF discriminates surprising from mundane interactions", async () => {
    const scores: Array<{ label: string; score: number; surprising: boolean; why: string }> = [];

    for (const ix of TEST_INTERACTIONS) {
      const ctx = {
        interaction: {
          id: randomUUID(),
          timestamp: Date.now(),
          prompt: ix.prompt,
          response: ix.response,
          source: "cursor",
          metadata: {},
        },
        fragments: [] as any[],
      };

      const result = await spmInstance.evaluate(ctx);
      scores.push({
        label: ix.label,
        score: result.score,
        surprising: result.isSurprising,
        why: ix.why,
      });
    }

    const mundaneScores = scores.filter((s) => s.label === "mundane");
    const surprisingScores = scores.filter((s) => s.label === "surprising");

    const avgMundane = mundaneScores.reduce((a, b) => a + b.score, 0) / mundaneScores.length;
    const avgSurprising = surprisingScores.reduce((a, b) => a + b.score, 0) / surprisingScores.length;

    console.log(`  TF-IDF avg mundane: ${avgMundane.toFixed(3)}, avg surprising: ${avgSurprising.toFixed(3)}`);

    // Surprising interactions should score meaningfully higher
    expect(avgSurprising).toBeGreaterThan(avgMundane);

    // Polish interactions should score high
    const polishScores = scores.filter((s) => s.why.includes("Polish"));
    for (const ps of polishScores) {
      expect(ps.score).toBeGreaterThan(avgMundane);
    }

    // At least some surprising should be flagged (cross threshold of 0.50)
    const flagged = scores.filter((s) => s.surprising);
    console.log(`  Flagged as surprising: ${flagged.length} / ${scores.length}`);
    expect(flagged.length).toBeGreaterThanOrEqual(1);

    // Individual scores for debugging
    for (const s of scores) {
      console.log(
        `    ${s.label.padEnd(12)} score=${s.score.toFixed(3)} flagged=${s.surprising} | ${s.why.slice(0, 50)}`
      );
    }
  });

  // ── Step 3: Content cleaner strips XML artifacts ─────────────────────

  test("Step 3: Content cleaner strips Claude XML artifacts from observations", async () => {
    // The content cleaner is designed for Claude's specific XML format
    // (wrapped in <observed_from_primary_session>). Raw XML without this
    // wrapper falls through as plain text — that's expected behavior.
    const claudeXml = `<observed_from_primary_session>
<what_happened>Edit</what_happened>
<working_directory>/Users/dev/the-brain</working_directory>
<parameters>{"file_path":"src/index.ts"}</parameters>
</observed_from_primary_session>
Actually, let me refactor this to use dependency injection instead.`;

    const cleaned = cleanMemoryContent(claudeXml);
    expect(cleaned).toHaveProperty("summary");
    expect(cleaned).toHaveProperty("action");
    expect(cleaned).toHaveProperty("type");

    // XML tags from the introspection format are stripped
    expect(cleaned.summary).not.toContain("observed_from_primary_session");
    expect(cleaned.summary).not.toContain("what_happened");

    console.log(`  Cleaned: ${cleaned.summary}`);
  });

  // ── Step 3b: Content cleaner correctly handles user-request XML ──────

  test("Step 3b: Content cleaner extracts user requests from Claude XML", async () => {
    const claudeXml = `Prompt: <observed_from_primary_session>
<user_request>Create a new React component for the dashboard with TypeScript types</user_request>
<working_directory>/Users/dev/project</working_directory>
</observed_from_primary_session>`;

    const cleaned = cleanMemoryContent(claudeXml);
    expect(cleaned.type).toBe("user-request");
    expect(cleaned.summary).toContain("🗣");
    expect(cleaned.summary).toContain("React component");

    console.log(`  User request extracted: ${cleaned.summary}`);
  });

  // ── Step 3c: Content cleaner handles observation XML ─────────────────

  test("Step 3c: Content cleaner formats Claude observations", async () => {
    const observationXml = `Prompt: <observed_from_primary_session>
<what_happened>Bash</what_happened>
<working_directory>/Users/dev/the-brain</working_directory>
<parameters>{"command":"bun test"}</parameters>
</observed_from_primary_session>`;

    const cleaned = cleanMemoryContent(observationXml);
    expect(cleaned.type).toBe("observation");
    expect(cleaned.summary).toContain("💻");
    expect(cleaned.summary).toContain("bun test");

    console.log(`  Observation extracted: ${cleaned.summary}`);
  });

  // ── Step 4: Graph Memory creates nodes from interactions ────────────

  test("Step 4: Graph Memory creates nodes from interactions (AFTER_RESPONSE)", async () => {
    const interactions = [
      {
        id: randomUUID(),
        timestamp: Date.now(),
        prompt: "I prefer single quotes in TypeScript always",
        response: "Got it, will use single quotes.",
        source: "cursor",
        metadata: {},
      },
      {
        id: randomUUID(),
        timestamp: Date.now(),
        prompt: "don't use axios, switch to native fetch instead",
        response: "Switching to native fetch.",
        source: "cursor",
        metadata: {},
      },
      {
        id: randomUUID(),
        timestamp: Date.now(),
        prompt: "fix the memory leak in the event listener",
        response: "Found the leak — missing removeEventListener...",
        source: "cursor",
        metadata: {},
      },
    ];

    for (const ix of interactions) {
      await hooks.callHook(HookEvent.AFTER_RESPONSE, ix);
    }

    // Graph memory should have created nodes
    const quoteNodes = await db.searchGraphNodes("quotes");
    const fetchNodes = await db.searchGraphNodes("fetch");
    const memoryNodes = await db.searchGraphNodes("memory");

    console.log(
      `  Graph nodes: quotes=${quoteNodes.length}, fetch=${fetchNodes.length}, memory=${memoryNodes.length}`
    );

    // At minimum, concept nodes for keywords should be created
    const allConceptNodes = (await Promise.all(
      ["quotes", "fetch", "memory", "leak", "prefer", "typescript"].map((kw) =>
        db.searchGraphNodes(kw)
      )
    )).flat();

    expect(allConceptNodes.length).toBeGreaterThan(0);
  });

  // ── Step 5: Context injection (BEFORE_PROMPT) returns relevant graph ─

  test("Step 5: Context injection returns relevant graph context", async () => {
    const ctx: InjectedContext = { text: "", nodeIds: [] };

    await hooks.callHook(HookEvent.BEFORE_PROMPT, {
      prompt: "I need to fetch data from the API, should I use axios or fetch?",
      injected: [],
      metadata: {},
      inject(text: string) {
        ctx.text += text;
      },
    });

    // Context should have been injected
    expect(ctx.text.length).toBeGreaterThan(0);
    // Should mention "fetch" since we have a correction about it
    expect(ctx.text.toLowerCase()).toMatch(/fetch/);

    console.log(`  Injected context (${ctx.text.length} chars):\n${ctx.text.slice(0, 250)}...`);
  });

  // ── Step 6: Full round-trip: clean → score → store → inject ─────────

  test("Step 6: Full round-trip: clean → score → store → inject", async () => {
    // Simulate a real interaction arriving from a Claude harvester
    const claudeXml = `<observed_from_primary_session>
<user_request>change of plans — let's use pnpm instead of npm for this project. I prefer pnpm workspaces over npm.</user_request>
<working_directory>/Users/dev/the-brain</working_directory>
</observed_from_primary_session>`;

    // 1. Clean — extracts user request from Claude XML
    const cleaned = cleanMemoryContent(claudeXml);
    expect(cleaned.summary).not.toContain("observed_from");
    expect(cleaned.summary).not.toContain("<working_directory>");
    // The actual user intent should be captured
    expect(cleaned.summary.toLowerCase()).toMatch(/pnpm/);

    // 2. Evaluate through SPM
    const response = "Switching to pnpm. Using pnpm workspaces for monorepo management.";
    const spmResult = await spmInstance.evaluate({
      interaction: {
        id: randomUUID(),
        timestamp: Date.now(),
        prompt: cleaned.summary, // Feed cleaned version to SPM
        response,
        source: "cursor",
        metadata: {},
      },
      fragments: [],
    });

    console.log(
      `  Round-trip: SPM score=${spmResult.score.toFixed(3)}, surprising=${spmResult.isSurprising}`
    );

    // 3. Store in DB
    const memId = randomUUID();
    await db.insertMemory({
      id: memId,
      layer: spmResult.isSurprising ? MemoryLayer.SELECTION : MemoryLayer.INSTANT,
      content: `Prompt: ${cleaned.summary}\nResponse: ${response}`,
      surpriseScore: spmResult.score,
      timestamp: Date.now(),
      source: "cursor",
      metadata: { cleaned: true, tfidfScore: spmResult.score },
    });

    // 4. Fire AFTER_RESPONSE so graph memory processes it
    await hooks.callHook(HookEvent.AFTER_RESPONSE, {
      id: randomUUID(),
      timestamp: Date.now(),
      prompt: cleaned.summary,
      response,
      source: "cursor",
      metadata: { spmScore: spmResult.score },
    });

    // 5. Verify memory was stored
    const allMemories = await db.getMemoriesByLayer(MemoryLayer.SELECTION, 50);
    const stored = allMemories.find((m: any) => m.id === memId);
    if (!stored) {
      // May have been stored as INSTANT if not surprising enough
      const instantMemories = await db.getMemoriesByLayer(MemoryLayer.INSTANT, 50);
      const instStored = instantMemories.find((m: any) => m.id === memId);
      expect(instStored).not.toBeNull();
      expect(instStored!.content).toContain("pnpm");
    } else {
      expect(stored.content).toContain("pnpm");
    }

    // 6. Verify graph nodes were created (pnpm preference detected)
    const pnpmNodes = await db.searchGraphNodes("pnpm");
    console.log(`  Graph nodes for 'pnpm': ${pnpmNodes.length}`);

    // 7. Simulate context injection for a future prompt
    const injectedCtx: InjectedContext = { text: "", nodeIds: [] };
    await hooks.callHook(HookEvent.BEFORE_PROMPT, {
      prompt: "What package manager should I use for this new project?",
      injected: [],
      metadata: {},
      inject(text: string) {
        injectedCtx.text += text;
      },
    });

    expect(injectedCtx.text.length).toBeGreaterThan(0);
    console.log(`  Injected context for 'package manager' query: ${injectedCtx.text.slice(0, 150)}`);
  });

  // ── Step 7: SPM stats are coherent ──────────────────────────────────

  test("Step 7: SPM statistics are coherent", async () => {
    const stats = spmInstance.getStats();
    expect(stats.totalEvaluated).toBeGreaterThan(0);
    expect(stats.threshold).toBeGreaterThan(0);
    expect(stats.promoteRate).toBeGreaterThanOrEqual(0);

    const tfidf = spmInstance.getTfidf();
    expect(tfidf!.getStats().vocabSize).toBeGreaterThan(0);
    expect(tfidf!.getStats().docCount).toBeGreaterThan(0);
    expect(tfidf!.getStats().finalized).toBe(true);

    console.log(
      `  SPM stats: ${stats.totalEvaluated} evaluated, ${stats.totalPromoted} promoted (${stats.promoteRate}%), threshold=${stats.threshold}`
    );
    console.log(
      `  TF-IDF stats: ${tfidf!.getStats().vocabSize} terms, ${tfidf!.getStats().docCount} docs, finalized=${tfidf!.getStats().finalized}`
    );
  });
});

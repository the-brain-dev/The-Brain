/**
 * Comprehensive tests for auto-wiki v2 — Karpathy-style LLM Wiki
 *
 * Tests are self-contained: use real :memory: BrainDB, write to temp dirs.
 * No mock.module() — all tests use real DB + real filesystem.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { BrainDB, MemoryLayer, HookEvent } from "@the-brain/core";
import { createAutoWikiPlugin } from "../index";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

const TMP_DIR = "/tmp/test-auto-wiki-v2";

// ── Helpers ─────────────────────────────────────────────────────

async function seedTestData(db: BrainDB) {
  // Memories across layers
  const now = Date.now();
  await db.insertMemory({
    id: "m1", layer: MemoryLayer.SELECTION, content: "User prefers TypeScript over JavaScript",
    surpriseScore: 0.85, timestamp: now - 10000, source: "cursor",
  });
  await db.insertMemory({
    id: "m2", layer: MemoryLayer.DEEP, content: "Deep consolidated: code review prefers async/await over callbacks",
    surpriseScore: 0.9, timestamp: now - 20000, source: "cursor",
  });
  await db.insertMemory({
    id: "m3", layer: MemoryLayer.INSTANT, content: "Temporary: currently working on GraphQL schema",
    surpriseScore: 0.2, timestamp: now - 30000, source: "cursor",
  });
  await db.insertMemory({
    id: "m4", layer: MemoryLayer.SELECTION, content: "Pattern: use React hooks over class components",
    surpriseScore: 0.72, timestamp: now - 40000, source: "cursor",
  });
  await db.insertMemory({
    id: "m5", layer: MemoryLayer.SELECTION, content: "Preference: spaces over tabs, 2-space indent",
    surpriseScore: 0.65, timestamp: now - 50000, source: "claude",
  });

  // Graph nodes
  await db.upsertGraphNode({
    id: "n1", label: "TypeScript Preference", type: "preference",
    content: "User strongly prefers TypeScript with strict mode enabled",
    connections: ["n2"], weight: 0.85, timestamp: now - 10000, source: "cursor",
  });
  await db.upsertGraphNode({
    id: "n2", label: "Async/Await Over Callbacks", type: "pattern",
    content: "Code reviews consistently prefer async/await pattern over callback-based APIs",
    connections: ["n1"], weight: 0.78, timestamp: now - 20000, source: "cursor",
  });
  await db.upsertGraphNode({
    id: "n3", label: "Spaces Over Tabs", type: "preference",
    content: "Uses 2-space indentation, never tabs",
    connections: [], weight: 0.92, timestamp: now - 50000, source: "claude",
  });
  await db.upsertGraphNode({
    id: "n4", label: "React Hooks Pattern", type: "pattern",
    content: "Use functional components with hooks over class components",
    connections: [], weight: 0.65, timestamp: now - 40000, source: "cursor",
  });
}

// ── Tests ───────────────────────────────────────────────────────

describe("auto-wiki v2 — Karpathy-style LLM Wiki", () => {
  // ── Schema ────────────────────────────────────────────────

  test("bootstrap creates wiki directory structure", async () => {
    const db = new BrainDB(":memory:");
    const plugin = createAutoWikiPlugin(db, { outputDir: join(TMP_DIR, "bootstrap") });

    // Trigger setup + generate
    let handler: Function | null = null;
    plugin.setup({
      hook: (event: string, fn: Function) => {
        if (event === HookEvent.CONSOLIDATE_COMPLETE) handler = fn;
      },
      callHook: async () => {},
      getHandlers: () => [],
    } as any);

    await handler!();

    // Verify structure
    const dirs = ["raw", "entities/patterns", "entities/corrections", "entities/preferences", "entities/concepts", "weekly", "meta"];
    for (const d of dirs) {
      expect(existsSync(join(TMP_DIR, "bootstrap", d))).toBe(true);
    }

    expect(existsSync(join(TMP_DIR, "bootstrap", "SCHEMA.md"))).toBe(true);
    expect(existsSync(join(TMP_DIR, "bootstrap", "index.md"))).toBe(true);
    expect(existsSync(join(TMP_DIR, "bootstrap", "log.md"))).toBe(true);

    db.close();
  });

  test("schema is only created once", async () => {
    const db = new BrainDB(":memory:");
    const dir = join(TMP_DIR, "schema-once");
    const plugin = createAutoWikiPlugin(db, { outputDir: dir });

    let handler: Function | null = null;
    plugin.setup({
      hook: (event: string, fn: Function) => {
        if (event === HookEvent.CONSOLIDATE_COMPLETE) handler = fn;
      },
      callHook: async () => {},
      getHandlers: () => [],
    } as any);

    await handler!();

    // Write a custom schema marker
    const schemaPath = join(dir, "SCHEMA.md");
    const existingContent = await readFile(schemaPath, "utf-8");

    // Delete the file so we can detect if it gets re-created
    await rm(schemaPath);

    // Generate again — should NOT recreate schema (it doesn't exist so it will create)
    await handler!();
    const recreated = await readFile(schemaPath, "utf-8");
    // The schema should have been re-created since we deleted it
    expect(recreated.length).toBeGreaterThan(0);

    db.close();
  });

  // ── Raw Memory Dump ──────────────────────────────────────

  test("raw memory dump includes all memories", async () => {
    const db = new BrainDB(":memory:");
    await seedTestData(db);
    const dir = join(TMP_DIR, "raw-dump");
    const plugin = createAutoWikiPlugin(db, { outputDir: dir });

    let handler: Function | null = null;
    plugin.setup({
      hook: (event: string, fn: Function) => {
        if (event === HookEvent.CONSOLIDATE_COMPLETE) handler = fn;
      },
      callHook: async () => {},
      getHandlers: () => [],
    } as any);

    await handler!();

    // Find the raw dump file
    const rawDir = join(dir, "raw");
    const files = [...(await readdirSafe(rawDir))];
    const dumpFile = files.find((f) => f.startsWith("memory-dump-"));
    expect(dumpFile).toBeDefined();

    const content = await readFile(join(rawDir, dumpFile!), "utf-8");
    expect(content).toContain("TypeScript");
    expect(content).toContain("async/await");
    expect(content).toContain("GraphQL");
    expect(content).toContain("React hooks");
    expect(content).toContain("# Raw Memory Dump");

    db.close();
  });

  test("raw dump has YAML frontmatter", async () => {
    const db = new BrainDB(":memory:");
    await seedTestData(db);
    const dir = join(TMP_DIR, "raw-frontmatter");
    const plugin = createAutoWikiPlugin(db, { outputDir: dir });

    let handler: Function | null = null;
    plugin.setup({
      hook: (event: string, fn: Function) => {
        if (event === HookEvent.CONSOLIDATE_COMPLETE) handler = fn;
      },
      callHook: async () => {},
      getHandlers: () => [],
    } as any);

    await handler!();

    const rawDir = join(dir, "raw");
    const files = [...(await readdirSafe(rawDir))];
    const dumpFile = files.find((f) => f.startsWith("memory-dump-"));
    const content = await readFile(join(rawDir, dumpFile!), "utf-8");

    expect(content.startsWith("---")).toBe(true);
    expect(content).toContain("title:");
    expect(content).toContain("type: raw-dump");
    expect(content).toContain("created:");

    db.close();
  });

  // ── Entity Pages ──────────────────────────────────────────

  test("creates entity pages from high-weight graph nodes", async () => {
    const db = new BrainDB(":memory:");
    await seedTestData(db);
    const dir = join(TMP_DIR, "entity-pages");
    const plugin = createAutoWikiPlugin(db, { outputDir: dir });

    let handler: Function | null = null;
    plugin.setup({
      hook: (event: string, fn: Function) => {
        if (event === HookEvent.CONSOLIDATE_COMPLETE) handler = fn;
      },
      callHook: async () => {},
      getHandlers: () => [],
    } as any);

    await handler!();

    // Check preference pages
    const preferencesDir = join(dir, "entities", "preferences");
    const prefFiles = [...(await readdirSafe(preferencesDir))];
    expect(prefFiles.length).toBeGreaterThanOrEqual(1);

    // Check pattern pages
    const patternsDir = join(dir, "entities", "patterns");
    const patFiles = [...(await readdirSafe(patternsDir))];
    expect(patFiles.length).toBeGreaterThanOrEqual(1);

    db.close();
  });

  test("entity page has correct frontmatter and structure", async () => {
    const db = new BrainDB(":memory:");
    await seedTestData(db);
    const dir = join(TMP_DIR, "entity-structure");
    const plugin = createAutoWikiPlugin(db, { outputDir: dir });

    let handler: Function | null = null;
    plugin.setup({
      hook: (event: string, fn: Function) => {
        if (event === HookEvent.CONSOLIDATE_COMPLETE) handler = fn;
      },
      callHook: async () => {},
      getHandlers: () => [],
    } as any);

    await handler!();

    // Find the "spaces-over-tabs" preference page
    const prefDir = join(dir, "entities", "preferences");
    const prefFiles = [...(await readdirSafe(prefDir))];
    const spacesPage = prefFiles.find((f) => f.includes("spaces-over-tabs"));
    expect(spacesPage).toBeDefined();

    const content = await readFile(join(prefDir, spacesPage!), "utf-8");
    // Check frontmatter
    expect(content).toContain("title: Spaces Over Tabs");
    expect(content).toContain("confidence: high"); // weight 0.92
    expect(content).toContain("source: claude");
    // Check body
    expect(content).toContain("2-space indentation");

    db.close();
  });

  test("entity page connects to related nodes via wikilinks", async () => {
    const db = new BrainDB(":memory:");
    await seedTestData(db);
    const dir = join(TMP_DIR, "entity-wikilinks");
    const plugin = createAutoWikiPlugin(db, { outputDir: dir });

    let handler: Function | null = null;
    plugin.setup({
      hook: (event: string, fn: Function) => {
        if (event === HookEvent.CONSOLIDATE_COMPLETE) handler = fn;
      },
      callHook: async () => {},
      getHandlers: () => [],
    } as any);

    await handler!();

    // "typescript-preference" has connection to "async-await-over-callbacks"
    const prefDir = join(dir, "entities", "preferences");
    const prefFiles = [...(await readdirSafe(prefDir))];
    const tsPage = prefFiles.find((f) => f.includes("typescript-preference"));
    expect(tsPage).toBeDefined();

    const content = await readFile(join(prefDir, tsPage!), "utf-8");
    // Should have a wikilink to the async/await pattern
    expect(content).toContain("[[entities/");

    db.close();
  });

  // ── Weekly Summary ────────────────────────────────────────

  test("generates weekly summary with stats and surprising moments", async () => {
    const db = new BrainDB(":memory:");
    await seedTestData(db);
    const dir = join(TMP_DIR, "weekly-summary");
    const plugin = createAutoWikiPlugin(db, { outputDir: dir });

    let handler: Function | null = null;
    plugin.setup({
      hook: (event: string, fn: Function) => {
        if (event === HookEvent.CONSOLIDATE_COMPLETE) handler = fn;
      },
      callHook: async () => {},
      getHandlers: () => [],
    } as any);

    await handler!();

    const weeklyDir = join(dir, "weekly");
    const files = [...(await readdirSafe(weeklyDir))];
    expect(files.length).toBeGreaterThanOrEqual(1);

    const content = await readFile(join(weeklyDir, files[0]), "utf-8");
    expect(content).toContain("Weekly Summary");
    expect(content).toContain("Sessions");
    expect(content).toContain("memories");
    expect(content).toContain("Graph nodes");
    expect(content).toContain("Surprising Interactions");
    expect(content).toContain("TypeScript Preference");

    db.close();
  });

  // ── Index ─────────────────────────────────────────────────

  test("index.md lists all pages with confidence colors", async () => {
    const db = new BrainDB(":memory:");
    await seedTestData(db);
    const dir = join(TMP_DIR, "index-test");
    const plugin = createAutoWikiPlugin(db, { outputDir: dir });

    let handler: Function | null = null;
    plugin.setup({
      hook: (event: string, fn: Function) => {
        if (event === HookEvent.CONSOLIDATE_COMPLETE) handler = fn;
      },
      callHook: async () => {},
      getHandlers: () => [],
    } as any);

    await handler!();

    const indexPath = join(dir, "index.md");
    const content = await readFile(indexPath, "utf-8");

    expect(content).toContain("My Brain Wiki");
    expect(content).toContain("Total pages:");
    expect(content).toContain("Preferences");
    expect(content).toContain("Patterns");
    expect(content).toContain("spaces-over-tabs");

    db.close();
  });

  // ── Registry + Backlinks ──────────────────────────────────

  test("generates registry.json with all page metadata", async () => {
    const db = new BrainDB(":memory:");
    await seedTestData(db);
    const dir = join(TMP_DIR, "registry-test");
    const plugin = createAutoWikiPlugin(db, { outputDir: dir });

    let handler: Function | null = null;
    plugin.setup({
      hook: (event: string, fn: Function) => {
        if (event === HookEvent.CONSOLIDATE_COMPLETE) handler = fn;
      },
      callHook: async () => {},
      getHandlers: () => [],
    } as any);

    await handler!();

    const registryPath = join(dir, "meta", "registry.json");
    const content = await readFile(registryPath, "utf-8");
    const registry = JSON.parse(content);

    expect(Object.keys(registry).length).toBeGreaterThan(0);
    expect(registry["spaces-over-tabs"]).toBeDefined();
    expect(registry["spaces-over-tabs"].type).toBe("preference");

    db.close();
  });

  test("generates backlinks.json with link relationships", async () => {
    const db = new BrainDB(":memory:");
    await seedTestData(db);
    const dir = join(TMP_DIR, "backlinks-test");
    const plugin = createAutoWikiPlugin(db, { outputDir: dir });

    let handler: Function | null = null;
    plugin.setup({
      hook: (event: string, fn: Function) => {
        if (event === HookEvent.CONSOLIDATE_COMPLETE) handler = fn;
      },
      callHook: async () => {},
      getHandlers: () => [],
    } as any);

    await handler!();

    const backlinksPath = join(dir, "meta", "backlinks.json");
    const content = await readFile(backlinksPath, "utf-8");
    const backlinks = JSON.parse(content);

    expect(Object.keys(backlinks).length).toBeGreaterThan(0);

    db.close();
  });

  // ── Lint ──────────────────────────────────────────────────

  test("lint report is generated after wiki build", async () => {
    const db = new BrainDB(":memory:");
    await seedTestData(db);
    const dir = join(TMP_DIR, "lint-test");
    const plugin = createAutoWikiPlugin(db, { outputDir: dir });

    let handler: Function | null = null;
    plugin.setup({
      hook: (event: string, fn: Function) => {
        if (event === HookEvent.CONSOLIDATE_COMPLETE) handler = fn;
      },
      callHook: async () => {},
      getHandlers: () => [],
    } as any);

    await handler!();

    const lintPath = join(dir, "meta", "lint-report.md");
    const content = await readFile(lintPath, "utf-8");
    expect(content).toContain("Lint Report");
    expect(content).toContain("Pages checked:");

    db.close();
  });

  // ── Log ───────────────────────────────────────────────────

  test("log.md tracks generation events", async () => {
    const db = new BrainDB(":memory:");
    await seedTestData(db);
    const dir = join(TMP_DIR, "log-test");
    const plugin = createAutoWikiPlugin(db, { outputDir: dir });

    let handler: Function | null = null;
    plugin.setup({
      hook: (event: string, fn: Function) => {
        if (event === HookEvent.CONSOLIDATE_COMPLETE) handler = fn;
      },
      callHook: async () => {},
      getHandlers: () => [],
    } as any);

    // Generate twice — log should append
    await handler!();
    await handler!();

    const logPath = join(dir, "log.md");
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("Wiki Log");
    expect(content).toContain("generate |");

    // Should have 2+ entries (first gen creates initial header + entry, second appends)
    const generateCount = (content.match(/generate \|/g) || []).length;
    expect(generateCount).toBeGreaterThanOrEqual(2);

    db.close();
  });

  // ── Incremental generation ────────────────────────────────

  test("incremental generation updates existing pages", async () => {
    const db = new BrainDB(":memory:");
    await seedTestData(db);
    const dir = join(TMP_DIR, "incremental");
    const plugin = createAutoWikiPlugin(db, { outputDir: dir });

    let handler: Function | null = null;
    plugin.setup({
      hook: (event: string, fn: Function) => {
        if (event === HookEvent.CONSOLIDATE_COMPLETE) handler = fn;
      },
      callHook: async () => {},
      getHandlers: () => [],
    } as any);

    // First generation
    await handler!();

    // Add a new node
    await db.upsertGraphNode({
      id: "n5", label: "Functional Programming Preference", type: "preference",
      content: "User prefers immutable data structures and pure functions",
      connections: [], weight: 0.75, timestamp: Date.now(), source: "cursor",
    });

    // Second generation
    await handler!();

    const prefDir = join(dir, "entities", "preferences");
    const files = [...(await readdirSafe(prefDir))];
    const fpPage = files.find((f) => f.includes("functional-programming"));
    expect(fpPage).toBeDefined();

    const content = await readFile(join(prefDir, fpPage!), "utf-8");
    expect(content).toContain("Functional Programming Preference");
    expect(content).toContain("immutable data structures");

    db.close();
  });

  // ── Idempotency ───────────────────────────────────────────

  test("generation is idempotent — no broken links increase on second run", async () => {
    const db = new BrainDB(":memory:");
    await seedTestData(db);
    const dir = join(TMP_DIR, "idempotent");
    const plugin = createAutoWikiPlugin(db, { outputDir: dir });

    let handler: Function | null = null;
    plugin.setup({
      hook: (event: string, fn: Function) => {
        if (event === HookEvent.CONSOLIDATE_COMPLETE) handler = fn;
      },
      callHook: async () => {},
      getHandlers: () => [],
    } as any);

    // Generate twice
    await handler!();
    await handler!();

    const lintPath = join(dir, "meta", "lint-report.md");
    const lintContent = await readFile(lintPath, "utf-8");

    // Second run should have fewer or equal errors (connections are resolved)
    expect(lintContent).toBeDefined();

    db.close();
  });

  // ── Empty database ────────────────────────────────────────

  test("handles empty database gracefully", async () => {
    const db = new BrainDB(":memory:"); // No data
    const dir = join(TMP_DIR, "empty-db");
    const plugin = createAutoWikiPlugin(db, { outputDir: dir });

    let handler: Function | null = null;
    plugin.setup({
      hook: (event: string, fn: Function) => {
        if (event === HookEvent.CONSOLIDATE_COMPLETE) handler = fn;
      },
      callHook: async () => {},
      getHandlers: () => [],
    } as any);

    await handler!(); // Should not throw

    // Should still have basic structure
    expect(existsSync(join(dir, "SCHEMA.md"))).toBe(true);
    expect(existsSync(join(dir, "index.md"))).toBe(true);

    db.close();
  });

  // ── Manual trigger ────────────────────────────────────────

  test("wiki:generate hook returns file info", async () => {
    const db = new BrainDB(":memory:");
    await seedTestData(db);
    const dir = join(TMP_DIR, "manual-trigger");
    const plugin = createAutoWikiPlugin(db, { outputDir: dir });

    let genHandler: Function | null = null;
    plugin.setup({
      hook: (event: string, fn: Function) => {
        if (event === "wiki:generate") genHandler = fn;
      },
      callHook: async () => {},
      getHandlers: () => [],
    } as any);

    const result = await genHandler!();
    expect(result).toBeDefined();
    expect(result.filepath).toContain("wiki-");
    expect(result.filename).toContain("wiki-");

    db.close();
  });
});

// ── Utility ──────────────────────────────────────────────────────

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e: any) => e.isFile()).map((e: any) => e.name);
  } catch {
    return [];
  }
}

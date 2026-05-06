/**
 * Tests for Extension Auto-Loader.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { ExtensionLoader } from "../extensions";
import { createHookSystem } from "../hooks";
import { BrainDB } from "../db/index";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageBackend, SchedulerPlugin, SchedulerHandle } from "../layers/index";
import type { TheBrainConfig } from "../types";

// ── Mock helpers ──────────────────────────────────────────────

function mockStorage(): StorageBackend {
  return {
    init: async () => {},
    createSession: async () => {},
    getSession: async () => undefined,
    getRecentSessions: async () => [],
    insertMemory: async () => {},
    insertMemories: async () => {},
    getMemoriesByLayer: async () => [],
    getSurprisingMemories: async () => [],
    updateMemory: async () => {},
    deleteMemory: async () => {},
    getAllMemories: async () => [],
    getRecentMemories: async () => [],
    upsertGraphNode: async (node) => ({ ...node, id: node.id ?? "mock-id", connections: node.connections ?? [] } as any),
    getGraphNode: async () => undefined,
    getConnectedNodes: async () => [],
    getHighWeightNodes: async () => [],
    searchGraphNodes: async () => [],
    getStats: async () => ({}),
    deleteOldMemories: async () => 0,
    close: async () => {},
  };
}

function mockScheduler(): SchedulerPlugin {
  const handles: SchedulerHandle[] = [];
  return {
    name: "mock-scheduler",
    schedule(_name: string, _ms: number, _task: () => Promise<void>): SchedulerHandle {
      const h = { id: `mock-${handles.length}`, name: _name };
      handles.push(h);
      return h;
    },
    scheduleOnce(_name: string, _ms: number, _task: () => Promise<void>): SchedulerHandle {
      return { id: "mock-once", name: _name };
    },
    cancel(_h: SchedulerHandle) {},
    list() { return handles.map(h => ({ name: h.name, handle: h })); },
    async shutdown() {},
  };
}

function mockConfig(): TheBrainConfig {
  return {
    plugins: [],
    daemon: { pollIntervalMs: 30000, logDir: "/tmp" },
    database: { path: ":memory:" },
    mlx: { enabled: false },
    wiki: { enabled: true, outputDir: "/tmp" },
    activeContext: "global",
    contexts: {},
  };
}

describe("ExtensionLoader", () => {
  let tmpDir: string;
  let db: BrainDB;
  let storage: StorageBackend;
  let scheduler: SchedulerPlugin;
  let config: TheBrainConfig;
  const hooks = createHookSystem();

  // Fresh state before each test
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "the-brain-ext-"));
    mkdirSync(tmpDir, { recursive: true });
    db = new BrainDB(join(tmpDir, "test.db"));
    storage = mockStorage();
    scheduler = mockScheduler();
    config = mockConfig();
  });

  afterAll(() => {
    try {
      db?.close();
    } catch {}
  });

  it("returns empty array when directory exists but is empty (no .ts files)", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "the-brain-empty-"));
    const loader = new ExtensionLoader(hooks, db, storage, scheduler, config, emptyDir);
    const results = await loader.loadAll();
    expect(results).toEqual([]);
  });

  it("loads a simple extension (function syntax)", async () => {
    writeFileSync(
      join(tmpDir, "hello.ts"),
      "export default function(brain) {\n" +
      "  brain.hook('consolidate:start', async () => {}); \n" +
      "}\n"
    );

    const loader = new ExtensionLoader(hooks, db, storage, scheduler, config, tmpDir);
    const results = await loader.loadAll();
    expect(results.length).toBe(1);

    const hello = results[0];
    expect(hello.name).toBe("hello");
    expect(hello.error).toBeUndefined();
  });

  it("loads arrow-function extension", async () => {
    writeFileSync(
      join(tmpDir, "arrow.ts"),
      "export default (brain) => {\n" +
      "  brain.hook('consolidate:start', () => {});\n" +
      "}\n"
    );

    const loader = new ExtensionLoader(hooks, db, storage, scheduler, config, tmpDir);
    const results = await loader.loadAll();
    expect(results.length).toBe(1);
    expect(results[0].name).toBe("arrow");
    expect(results[0].error).toBeUndefined();
  });

  it("reports error for file without export default", async () => {
    writeFileSync(
      join(tmpDir, "broken.ts"),
      "const x = 1;\nconst y = 2;\n"
    );

    const loader = new ExtensionLoader(hooks, db, storage, scheduler, config, tmpDir);
    const results = await loader.loadAll();
    expect(results.length).toBe(1);

    const broken = results[0];
    expect(broken.name).toBe("broken");
    expect(broken.error).toBeDefined();
  });

  it("lists loaded extensions", async () => {
    writeFileSync(
      join(tmpDir, "hello.ts"),
      "export default function(brain) {}\n"
    );

    const loader = new ExtensionLoader(hooks, db, storage, scheduler, config, tmpDir);
    await loader.loadAll();

    const list = loader.list();
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("hello");
  });

  it("gets specific extension by name", async () => {
    writeFileSync(
      join(tmpDir, "hello.ts"),
      "export default function(brain) {}\n"
    );

    const loader = new ExtensionLoader(hooks, db, storage, scheduler, config, tmpDir);
    await loader.loadAll();

    const ext = loader.get("hello");
    expect(ext).toBeDefined();
    expect(ext!.name).toBe("hello");
  });

  it("returns undefined for unknown extension", () => {
    const loader = new ExtensionLoader(hooks, db, storage, scheduler, config, tmpDir);
    const ext = loader.get("nonexistent");
    expect(ext).toBeUndefined();
  });

  describe("ExtensionLoader.ensureExtensionsDir", () => {
    it("creates directory and sample file", () => {
      const sampleDir = join(tmpDir, "sample-ext");
      const result = ExtensionLoader.ensureExtensionsDir(sampleDir);

      expect(result).toBe(sampleDir);
      expect(existsSync(result)).toBe(true);

      const files = readdirSync(result);
      expect(files).toContain("sample.ts");
    });
  });
});

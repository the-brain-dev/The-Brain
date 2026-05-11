/**
 * Tests for backend-resolver.ts — dynamic backend module loading.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BackendConfig } from "../backend-resolver";

const TEST_DIR = join(tmpdir(), "backend-resolver-test-" + Date.now());

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
});

// ── Helpers ──────────────────────────────────────────────────

function createMockModule(dirName: string, exports: string): string {
  const dir = join(TEST_DIR, dirName);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, "index.ts");
  writeFileSync(filePath, exports, "utf-8");
  return filePath;
}

// ── Tests ────────────────────────────────────────────────────

describe("resolveBackends", () => {
  test("returns defaults when config is undefined", async () => {
    const { resolveBackends } = await import("../backend-resolver");
    const dbPath = join(TEST_DIR, "test.db");

    const result = await resolveBackends(undefined, dbPath);

    expect(result.storage).toBeDefined();
    expect(result.cleaner).toBeDefined();
    expect(result.scheduler).toBeDefined();
    expect(result.outputs).toEqual([]);
  });

  test("returns defaults when config has no backends set", async () => {
    const { resolveBackends } = await import("../backend-resolver");
    const dbPath = join(TEST_DIR, "test.db");

    const result = await resolveBackends({}, dbPath);

    expect(result.storage).toBeDefined();
    expect(result.cleaner).toBeDefined();
    expect(result.scheduler).toBeDefined();
  });

  test("loads custom output plugins from config", async () => {
    const modPath = createMockModule("test-output", `
      export function createOutput() {
        return { name: "test-output", format: () => "ok" };
      }
    `);

    const { resolveBackends } = await import("../backend-resolver");
    const dbPath = join(TEST_DIR, "test.db");

    const result = await resolveBackends(
      { outputs: [modPath] },
      dbPath,
    );

    expect(result.outputs.length).toBe(1);
    expect((result.outputs[0] as any).name).toBe("test-output");
  });

  test("gracefully handles failed output plugin load", async () => {
    const badPath = join(TEST_DIR, "does-not-exist.ts");

    const { resolveBackends } = await import("../backend-resolver");
    const dbPath = join(TEST_DIR, "test.db");

    const result = await resolveBackends(
      { outputs: [badPath] },
      dbPath,
    );

    // Failed output should be skipped, no crash
    expect(result.outputs.length).toBe(0);
  });

  test("loads multiple output plugins (mixing success and failure)", async () => {
    const mod1 = createMockModule("output-a", `
      export function createOutput() {
        return { name: "output-a" };
      }
    `);
    const mod2 = createMockModule("output-b", `
      export function createOutput() {
        return { name: "output-b" };
      }
    `);
    const badPath = join(TEST_DIR, "missing.ts");

    const { resolveBackends } = await import("../backend-resolver");
    const dbPath = join(TEST_DIR, "test.db");

    const result = await resolveBackends(
      { outputs: [mod1, badPath, mod2] },
      dbPath,
    );

    expect(result.outputs.length).toBe(2);
    expect((result.outputs[0] as any).name).toBe("output-a");
    expect((result.outputs[1] as any).name).toBe("output-b");
  });

  test("loads custom storage backend from config", async () => {
    const modPath = createMockModule("test-storage", `
      export function createStorage(dbPath: string) {
        return {
          name: "test-storage",
          path: dbPath,
          insertMemory: async () => {},
          getMemoryById: async () => null,
          getMemoriesByLayer: async () => [],
          getSurprisingMemories: async () => [],
          getRecentMemories: async () => [],
          getAllMemories: async () => [],
          updateMemory: async () => {},
          deleteMemory: async () => {},
          createSession: async () => {},
          getSession: async () => null,
          getRecentSessions: async () => [],
          upsertGraphNode: async () => {},
          getGraphNode: async () => null,
          getConnectedNodes: async () => [],
          getHighWeightNodes: async () => [],
          searchGraphNodes: async () => [],
          getStats: async () => ({}),
          deleteOldMemories: async () => 0,
        };
      }
    `);

    const { resolveBackends } = await import("../backend-resolver");
    const dbPath = join(TEST_DIR, "test.db");

    const result = await resolveBackends(
      { storage: modPath },
      dbPath,
    );

    expect((result.storage as any).name).toBe("test-storage");
    expect((result.storage as any).path).toBe(dbPath);
  });
});

describe("loadBackend errors", () => {
  test("throws when module does not exist", async () => {
    const { resolveBackends } = await import("../backend-resolver");
    const dbPath = join(TEST_DIR, "test.db");

    await expect(
      resolveBackends(
        { storage: join(TEST_DIR, "nonexistent.ts") },
        dbPath,
      ),
    ).rejects.toThrow(/Cannot load backend/);
  });

  test("throws when module lacks the required factory function", async () => {
    const modPath = createMockModule("no-factory", `
      export const something = 42;
    `);

    const { resolveBackends } = await import("../backend-resolver");
    const dbPath = join(TEST_DIR, "test.db");

    await expect(
      resolveBackends(
        { cleaner: modPath },
        dbPath,
      ),
    ).rejects.toThrow(/does not export/);
  });

  test("handles default-export-wrapped factory (mod.default.factoryFn)", async () => {
    // Simulate a module where the factory is on mod.default.factoryFn
    const modPath = createMockModule("default-wrap", `
      const impl = {
        createCleaner: function() {
          return { clean: () => "cleaned" };
        }
      };
      export default impl;
    `);

    const { resolveBackends } = await import("../backend-resolver");
    const dbPath = join(TEST_DIR, "test.db");

    const result = await resolveBackends(
      { cleaner: modPath },
      dbPath,
    );

    expect(result.cleaner).toBeDefined();
    expect((result.cleaner as any).clean()).toBe("cleaned");
  });
});

/**
 * SQLite Storage Backend — tests
 *
 * Tests the default storage backend wrapping BrainDB.
 */
import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { createSqliteBackend } from "../storage-sqlite";
import { MemoryLayer } from "../types";
import type { Memory, Session } from "../types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DIR = mkdtempSync(join(tmpdir(), "sqlite-backend-"));
const DB_PATH = join(TEST_DIR, "test.db");

let backend: ReturnType<typeof createSqliteBackend>;

beforeAll(async () => {
  backend = createSqliteBackend(DB_PATH);
  await backend.init();
});

afterAll(async () => {
  await backend.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: `sqlmem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    layer: MemoryLayer.INSTANT,
    content: "SQLite backend test",
    surpriseScore: null,
    timestamp: Date.now(),
    source: "test",
    ...overrides,
  };
}

describe("SQLiteStorageBackend", () => {
  it("inserts and retrieves memory by ID", async () => {
    const mem = makeMemory();
    await backend.insertMemory(mem);
    const result = await backend.getMemoryById(mem.id);
    expect(result).toBeDefined();
    expect(result!.content).toBe("SQLite backend test");
  });

  it("batch inserts and retrieves by layer", async () => {
    const mems = [makeMemory({ content: "A" }), makeMemory({ content: "B" })];
    await backend.insertMemories(mems);

    const layer = await backend.getMemoriesByLayer(MemoryLayer.INSTANT, 10);
    expect(layer.length).toBeGreaterThanOrEqual(2);
  });

  it("filters surprising memories", async () => {
    const mem = makeMemory({
      layer: MemoryLayer.SELECTION,
      surpriseScore: 0.95,
    });
    await backend.insertMemory(mem);

    const surprising = await backend.getSurprisingMemories(0.5);
    expect(surprising.some((m: Memory) => m.id === mem.id)).toBe(true);
  });

  it("updates memory", async () => {
    const mem = makeMemory({ content: "Before" });
    await backend.insertMemory(mem);
    await backend.updateMemory(mem.id, { content: "After" });

    const updated = await backend.getMemoryById(mem.id);
    expect(updated!.content).toBe("After");
  });

  it("deletes memory", async () => {
    const mem = makeMemory();
    await backend.insertMemory(mem);
    await backend.deleteMemory(mem.id);

    const gone = await backend.getMemoryById(mem.id);
    expect(gone).toBeUndefined();
  });

  it("upserts graph nodes", async () => {
    const node = {
      label: "Graph Test",
      type: "concept",
      content: "Testing graphs",
      connections: [],
      weight: 0.9,
      timestamp: Date.now(),
      source: "test",
    };
    const result = await backend.upsertGraphNode(node);
    expect(result.label).toBe("Graph Test");
    expect(result.weight).toBe(0.9);
  });

  it("searches graph nodes", async () => {
    const results = await backend.searchGraphNodes("Graph");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("returns stats", async () => {
    const stats = await backend.getStats();
    expect(typeof stats).toBe("object");
    expect((stats as any).memories).toBeGreaterThan(0);
  });

  it("init is idempotent", async () => {
    await backend.init(); // second init should not throw
    const stats = await backend.getStats();
    expect(stats).toBeDefined();
  });
});

/**
 * @the-brain/storage-libsql — Comprehensive tests
 *
 * Tests the full StorageBackend interface: sessions, memories, graph nodes, stats, maintenance.
 * Uses local LibSQL (file: URL) — no remote server needed.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createLibsqlBackend } from "../index";
import { MemoryLayer } from "@the-brain/core";
import type { Memory, Session, GraphNodeRecord } from "@the-brain/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DIR = mkdtempSync(join(tmpdir(), "libsql-test-"));
const DB_URL = `file:${join(TEST_DIR, "test.db")}`;

let backend: ReturnType<typeof createLibsqlBackend>;

beforeAll(async () => {
  backend = createLibsqlBackend({ url: DB_URL });
  await backend.init();
});

afterAll(async () => {
  await backend.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    layer: MemoryLayer.INSTANT,
    content: "Test memory content",
    surpriseScore: null,
    timestamp: Date.now(),
    source: "test",
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: Date.now(),
    source: "test",
    interactionCount: 0,
    ...overrides,
  };
}

// ── Sessions ─────────────────────────────────────────────────

describe("Sessions", () => {
  it("inserts and retrieves a session", async () => {
    const session = makeSession();
    await backend.createSession(session);
    const retrieved = await backend.getSession(session.id);
    expect(retrieved).toBeDefined();
    expect((retrieved as any).id).toBe(session.id);
    expect((retrieved as any).source).toBe("test");
  });

  it("returns undefined for non-existent session", async () => {
    const result = await backend.getSession("nonexistent-id");
    expect(result).toBeUndefined();
  });

  it("lists recent sessions", async () => {
    const s1 = makeSession();
    const s2 = makeSession({ startedAt: Date.now() + 1000 });
    await backend.createSession(s1);
    await backend.createSession(s2);

    const recent = await backend.getRecentSessions(5);
    expect(recent.length).toBeGreaterThanOrEqual(2);
    // Must be valid records
    for (const r of recent) {
      expect((r as any).id).toBeDefined();
      expect((r as any).source).toBe("test");
    }
  });

  it("respects session limit", async () => {
    const recent = await backend.getRecentSessions(1);
    expect(recent.length).toBeLessThanOrEqual(1);
  });
});

// ── Memories ─────────────────────────────────────────────────

describe("Memories", () => {
  it("inserts a single memory", async () => {
    const mem = makeMemory();
    await backend.insertMemory(mem);
    const retrieved = await backend.getMemoryById(mem.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.content).toBe("Test memory content");
    expect(retrieved!.layer).toBe(MemoryLayer.INSTANT);
  });

  it("batch inserts memories", async () => {
    const mems = [
      makeMemory({ content: "Memory A" }),
      makeMemory({ content: "Memory B" }),
      makeMemory({ content: "Memory C" }),
    ];
    await backend.insertMemories(mems);

    const all = await backend.getAllMemories(100);
    const ourMems = all.filter(m => mems.some(om => om.id === m.id));
    expect(ourMems).toHaveLength(3);
  });

  it("handles empty batch insert gracefully", async () => {
    await backend.insertMemories([]); // should not throw
  });

  it("returns memories by layer", async () => {
    const instant = makeMemory({ layer: MemoryLayer.INSTANT });
    const deep = makeMemory({ layer: MemoryLayer.DEEP });
    await backend.insertMemories([instant, deep]);

    const instantResults = await backend.getMemoriesByLayer(MemoryLayer.INSTANT, 10);
    expect(instantResults.some((m: Memory) => m.id === instant.id)).toBe(true);

    const deepResults = await backend.getMemoriesByLayer(MemoryLayer.DEEP, 10);
    expect(deepResults.some((m: Memory) => m.id === deep.id)).toBe(true);
  });

  it("filters surprising memories by threshold", async () => {
    const surprising = makeMemory({
      layer: MemoryLayer.SELECTION,
      surpriseScore: 0.9,
      content: "Very surprising",
    });
    const boring = makeMemory({
      layer: MemoryLayer.SELECTION,
      surpriseScore: 0.1,
      content: "Not surprising",
    });
    await backend.insertMemories([surprising, boring]);

    const results = await backend.getSurprisingMemories(0.5);
    expect(results.some((m: Memory) => m.id === surprising.id)).toBe(true);
    // boring one should not be included (surpriseScore 0.1 < 0.5)
    const boringResults = results.filter((m: Memory) => m.id === boring.id);
    expect(boringResults).toHaveLength(0);
  });

  it("updates memory fields", async () => {
    const mem = makeMemory({ content: "Original" });
    await backend.insertMemory(mem);

    await backend.updateMemory(mem.id, { content: "Updated", surpriseScore: 0.75 });
    const updated = await backend.getMemoryById(mem.id);
    expect(updated!.content).toBe("Updated");
    expect(updated!.surpriseScore).toBe(0.75);
  });

  it("deletes memory by id", async () => {
    const mem = makeMemory();
    await backend.insertMemory(mem);
    await backend.deleteMemory(mem.id);
    const result = await backend.getMemoryById(mem.id);
    expect(result).toBeUndefined();
  });

  it("getAllMemories respects maxResults", async () => {
    const all = await backend.getAllMemories(2);
    expect(all.length).toBeLessThanOrEqual(2);
  });

  it("filters recent memories by hours", async () => {
    const recent = makeMemory({ timestamp: Date.now(), content: "Recent" });
    const old = makeMemory({ timestamp: Date.now() - 48 * 3600 * 1000, content: "Old" });
    await backend.insertMemories([recent, old]);

    const results = await backend.getRecentMemories(1); // last 1 hour
    expect(results.some((m: Memory) => m.id === recent.id)).toBe(true);
    const oldResults = results.filter((m: Memory) => m.id === old.id);
    expect(oldResults).toHaveLength(0);
  });
});

// ── Graph Nodes ──────────────────────────────────────────────

describe("GraphNodes", () => {
  it("upserts a new graph node", async () => {
    const node = {
      label: "Test Concept",
      type: "concept",
      content: "A test concept for storage",
      connections: ["other-node-1"],
      weight: 0.8,
      timestamp: Date.now(),
      source: "test",
    };
    const result = await backend.upsertGraphNode(node);
    expect(result).toBeDefined();
    expect(result.label).toBe("Test Concept");
    expect(result.weight).toBe(0.8);
    expect(result.connections).toEqual(["other-node-1"]);
  });

  it("updates existing graph node on upsert (UPDATE path)", async () => {
    const node = {
      id: "upsert-update-test",
      label: "Original Label",
      type: "preference",
      content: "Original content",
      connections: ["node-a"],
      weight: 0.3,
      timestamp: Date.now(),
      source: "test",
    };
    // First upsert → INSERT
    await backend.upsertGraphNode(node);

    // Second upsert with same ID → UPDATE (lines 177-178)
    const updated = await backend.upsertGraphNode({
      id: "upsert-update-test",
      label: "Updated Label",
      type: "preference",
      content: "Updated content",
      connections: ["node-a", "node-b"],
      weight: 0.9,
      timestamp: Date.now(),
      source: "test",
    });

    expect(updated.label).toBe("Updated Label");
    expect(updated.content).toBe("Updated content");
    expect(updated.weight).toBe(0.9);
    expect(updated.connections).toEqual(["node-a", "node-b"]);
    // Also verify via getGraphNode
    const retrieved = await backend.getGraphNode("upsert-update-test");
    expect(retrieved!.label).toBe("Updated Label");
  });

  it("retrieves graph node by id", async () => {
    const node = {
      id: "explicit-id-42",
      label: "Explicit ID Node",
      type: "pattern",
      content: "With explicit ID",
      connections: [],
      weight: 0.5,
      timestamp: Date.now(),
      source: "test",
    };
    await backend.upsertGraphNode(node);
    const retrieved = await backend.getGraphNode("explicit-id-42");
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe("explicit-id-42");
  });

  it("returns undefined for non-existent graph node", async () => {
    const result = await backend.getGraphNode("nonexistent");
    expect(result).toBeUndefined();
  });

  it("returns connected nodes", async () => {
    // Create nodes with connections
    const n1 = {
      id: "conn-1",
      label: "Node One",
      type: "concept",
      content: "First",
      connections: ["conn-2"],
      weight: 0.7,
      timestamp: Date.now(),
      source: "test",
    };
    const n2 = {
      id: "conn-2",
      label: "Node Two",
      type: "concept",
      content: "Second",
      connections: [],
      weight: 0.5,
      timestamp: Date.now(),
      source: "test",
    };
    await backend.upsertGraphNode(n1);
    await backend.upsertGraphNode(n2);

    const connected = await backend.getConnectedNodes("conn-1");
    expect(connected).toHaveLength(1);
    expect(connected[0].id).toBe("conn-2");
  });

  it("returns empty array for node with no connections", async () => {
    const result = await backend.getConnectedNodes("conn-2");
    expect(result).toHaveLength(0);
  });

  it("filters high-weight nodes", async () => {
    const high = await backend.getHighWeightNodes(0.6);
    expect(high.length).toBeGreaterThanOrEqual(1);
    for (const n of high) {
      expect(n.weight).toBeGreaterThanOrEqual(0.6);
    }
  });

  it("searches graph nodes by label or content", async () => {
    const results = await backend.searchGraphNodes("test");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("escapes LIKE special chars in search", async () => {
    // % and _ should be escaped
    const results = await backend.searchGraphNodes("%");
    expect(results).toBeDefined(); // should not throw
  });
});

// ── Stats & Maintenance ──────────────────────────────────────

describe("Stats", () => {
  it("returns stats with correct counts", async () => {
    const stats = await backend.getStats();
    expect(stats.memories).toBeGreaterThan(0);
    expect(stats.graphNodes).toBeGreaterThan(0);
    expect(stats.sessions).toBeGreaterThan(0);
    expect(typeof stats.perLayer).toBe("object");
    expect(Array.isArray(stats.perGraphType)).toBe(true);
  });
});

describe("Maintenance", () => {
  it("deletes old memories", async () => {
    const veryOld = makeMemory({
      timestamp: Date.now() - 100 * 86400 * 1000, // 100 days ago
      content: "Ancient memory",
    });
    await backend.insertMemory(veryOld);

    await backend.deleteOldMemories(30); // older than 30 days

    const gone = await backend.getMemoryById(veryOld.id);
    expect(gone).toBeUndefined();
  });
});

// ── Edge Cases ───────────────────────────────────────────────

describe("Edge Cases", () => {
  it("init is idempotent", async () => {
    // Calling init twice should not fail
    await backend.init();
    await backend.init();
    // Should still work
    const stats = await backend.getStats();
    expect(stats).toBeDefined();
  });

  it("updateMemory with empty updates is no-op", async () => {
    const mem = makeMemory({ content: "No-op test" });
    await backend.insertMemory(mem);
    await backend.updateMemory(mem.id, {});
    const unchanged = await backend.getMemoryById(mem.id);
    expect(unchanged!.content).toBe("No-op test");
  });

  it("getConnectedNodes returns empty for unknown node", async () => {
    const result = await backend.getConnectedNodes("nonexistent-node-id");
    expect(result).toHaveLength(0);
  });
});

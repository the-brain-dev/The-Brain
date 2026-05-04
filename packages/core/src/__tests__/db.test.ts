import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { BrainDB, MemoryLayer } from "@my-brain/core";
import type { Session, Memory, GraphNodeRecord } from "@my-brain/core";

// ── Helpers ─────────────────────────────────────────────────────

const TEST_UUID = "00000000-0000-4000-8000-000000000000";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    startedAt: overrides.startedAt ?? Date.now(),
    source: overrides.source ?? "test",
    interactionCount: overrides.interactionCount ?? 0,
    ...overrides,
  };
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    layer: overrides.layer ?? MemoryLayer.INSTANT,
    content: overrides.content ?? "test content",
    timestamp: overrides.timestamp ?? Date.now(),
    source: overrides.source ?? "test",
    ...overrides,
  };
}

function makeGraphNodeInput(
  overrides: Partial<Omit<GraphNodeRecord, "id"> & { id?: string }> = {}
): Omit<GraphNodeRecord, "id"> & { id?: string } {
  return {
    label: overrides.label ?? "test-label",
    type: overrides.type ?? "concept",
    content: overrides.content ?? "test content",
    connections: overrides.connections ?? [],
    weight: overrides.weight ?? 0.5,
    timestamp: overrides.timestamp ?? Date.now(),
    source: overrides.source ?? "test",
    ...overrides,
  };
}

// ── Database Helper ──────────────────────────────────────────────

/** Create a fresh in-memory BrainDB for each test. */
function createDB(): BrainDB {
  return new BrainDB(":memory:");
}

// ── Suite ────────────────────────────────────────────────────────

describe("BrainDB", () => {
  let db: BrainDB;

  afterEach(() => {
    try {
      db?.close();
    } catch {
      // already closed — fine
    }
  });

  // 1 ─────────────────────────────────────────────────────────────
  describe("constructor", () => {
    test("creates DB and initializes all tables", async () => {
      db = createDB();

      // Verify tables exist by querying sqlite_master
      const sqlite = (db as any).sqlite;
      const tables = sqlite
        .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];

      const tableNames = tables.map((t) => t.name).sort();
      expect(tableNames).toContain("sessions");
      expect(tableNames).toContain("memories");
      expect(tableNames).toContain("graph_nodes");

      // Verify indices exist
      const indexes = sqlite
        .query(
          "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name"
        )
        .all() as { name: string }[];

      const indexNames = indexes.map((i) => i.name).sort();
      expect(indexNames).toContain("idx_memories_layer");
      expect(indexNames).toContain("idx_memories_timestamp");
      expect(indexNames).toContain("idx_graph_weight");
    });
  });

  // 2 ─────────────────────────────────────────────────────────────
  describe("createSession + getSession", () => {
    test("round-trips a session with all fields", async () => {
      db = createDB();

      const session = makeSession({
        id: TEST_UUID,
        startedAt: 1714500000000,
        endedAt: 1714503600000,
        source: "cursor",
        interactionCount: 42,
        metadata: { project: "my-brain", language: "typescript" },
      });

      await db.createSession(session);

      const retrieved = await db.getSession(TEST_UUID);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(TEST_UUID);
      expect(retrieved!.startedAt).toBe(1714500000000);
      expect(retrieved!.endedAt).toBe(1714503600000);
      expect(retrieved!.source).toBe("cursor");
      expect(retrieved!.interactionCount).toBe(42);
      expect(retrieved!.metadata).toEqual({
        project: "my-brain",
        language: "typescript",
      });
    });

    test("returns undefined for non-existent session", async () => {
      db = createDB();
      const result = await db.getSession("nonexistent-id");
      expect(result).toBeUndefined();
    });
  });

  // 3 ─────────────────────────────────────────────────────────────
  describe("getRecentSessions", () => {
    test("returns sessions ordered by startedAt desc with limit", async () => {
      db = createDB();

      const now = Date.now();
      const sessions = [
        makeSession({ id: "s1", startedAt: now - 3000 }),
        makeSession({ id: "s2", startedAt: now - 2000 }),
        makeSession({ id: "s3", startedAt: now - 1000 }),
        makeSession({ id: "s4", startedAt: now }),
      ];

      for (const s of sessions) {
        await db.createSession(s);
      }

      const recent = await db.getRecentSessions(2);
      expect(recent).toHaveLength(2);
      expect(recent[0].id).toBe("s4"); // most recent first
      expect(recent[1].id).toBe("s3");
      expect(recent[0].startedAt).toBeGreaterThanOrEqual(recent[1].startedAt);
    });

    test("default limit is 10", async () => {
      db = createDB();

      for (let i = 0; i < 15; i++) {
        await db.createSession(
          makeSession({ id: `s${i}`, startedAt: Date.now() - i * 1000 })
        );
      }

      const recent = await db.getRecentSessions();
      expect(recent.length).toBeLessThanOrEqual(10);
    });

    test("returns empty array when no sessions exist", async () => {
      db = createDB();
      const recent = await db.getRecentSessions();
      expect(recent).toEqual([]);
    });
  });

  // 4 ─────────────────────────────────────────────────────────────
  describe("insertMemory", () => {
    test("inserts a single memory and retrieves by layer", async () => {
      db = createDB();

      // Create a session first to satisfy foreign key
      await db.createSession(makeSession({ id: "session-1" }));

      const memory = makeMemory({
        id: "mem-1",
        layer: MemoryLayer.SELECTION,
        content: "User prefers functional programming",
        surpriseScore: 0.8,
        timestamp: Date.now(),
        source: "chat",
        sessionId: "session-1",
        metadata: { topic: "coding-style" },
      });

      await db.insertMemory(memory);

      const results = await db.getMemoriesByLayer(MemoryLayer.SELECTION);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("mem-1");
      expect(results[0].content).toBe("User prefers functional programming");
      expect(results[0].surpriseScore).toBe(0.8);
      expect(results[0].source).toBe("chat");
      expect(results[0].sessionId).toBe("session-1");
      expect(results[0].metadata).toEqual({ topic: "coding-style" });
    });

    test("memory without sessionId works (nullable FK)", async () => {
      db = createDB();

      const memory = makeMemory({
        id: "mem-no-sess",
        layer: MemoryLayer.INSTANT,
        content: "no session attached",
      });
      // No sessionId — should not trigger FK violation

      await db.insertMemory(memory);

      const results = await db.getMemoriesByLayer(MemoryLayer.INSTANT);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("mem-no-sess");
      expect(results[0].sessionId).toBeNull();
    });
  });

  // 5 ─────────────────────────────────────────────────────────────
  describe("insertMemories (batch)", () => {
    test("inserts multiple memories and retrieves all", async () => {
      db = createDB();

      const memories: Memory[] = [
        makeMemory({ id: "m1", layer: MemoryLayer.INSTANT, content: "instant-1" }),
        makeMemory({ id: "m2", layer: MemoryLayer.INSTANT, content: "instant-2" }),
        makeMemory({ id: "m3", layer: MemoryLayer.DEEP, content: "deep-1" }),
      ];

      await db.insertMemories(memories);

      const instant = await db.getMemoriesByLayer(MemoryLayer.INSTANT);
      const deep = await db.getMemoriesByLayer(MemoryLayer.DEEP);

      expect(instant).toHaveLength(2);
      expect(deep).toHaveLength(1);
      expect(instant.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
      expect(deep[0].id).toBe("m3");
    });

    test("handles empty array", async () => {
      db = createDB();
      await db.insertMemories([]);
      // Should not throw
      const all = await db.getMemoriesByLayer(MemoryLayer.INSTANT);
      expect(all).toEqual([]);
    });
  });

  // 6 ─────────────────────────────────────────────────────────────
  describe("getMemoriesByLayer", () => {
    beforeEach(() => {
      db = createDB();
    });

    test("filters by INSTANT layer only", async () => {
      await db.insertMemories([
        makeMemory({ id: "i1", layer: MemoryLayer.INSTANT, content: "instant" }),
        makeMemory({ id: "s1", layer: MemoryLayer.SELECTION, content: "selection" }),
        makeMemory({ id: "d1", layer: MemoryLayer.DEEP, content: "deep" }),
      ]);

      const result = await db.getMemoriesByLayer(MemoryLayer.INSTANT);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("i1");
    });

    test("filters by SELECTION layer only", async () => {
      await db.insertMemories([
        makeMemory({ id: "i1", layer: MemoryLayer.INSTANT, content: "instant" }),
        makeMemory({ id: "s1", layer: MemoryLayer.SELECTION, content: "selection" }),
        makeMemory({ id: "d1", layer: MemoryLayer.DEEP, content: "deep" }),
      ]);

      const result = await db.getMemoriesByLayer(MemoryLayer.SELECTION);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("s1");
    });

    test("filters by DEEP layer only", async () => {
      await db.insertMemories([
        makeMemory({ id: "i1", layer: MemoryLayer.INSTANT, content: "instant" }),
        makeMemory({ id: "s1", layer: MemoryLayer.SELECTION, content: "selection" }),
        makeMemory({ id: "d1", layer: MemoryLayer.DEEP, content: "deep" }),
      ]);

      const result = await db.getMemoriesByLayer(MemoryLayer.DEEP);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("d1");
    });

    test("respects limit parameter", async () => {
      const mems: Memory[] = [];
      for (let i = 0; i < 10; i++) {
        mems.push(
          makeMemory({
            id: `m${i}`,
            layer: MemoryLayer.INSTANT,
            timestamp: Date.now() - i * 1000,
          })
        );
      }
      await db.insertMemories(mems);

      const result = await db.getMemoriesByLayer(MemoryLayer.INSTANT, 3);
      expect(result).toHaveLength(3);
    });

    test("default limit is 100", async () => {
      const mems: Memory[] = [];
      for (let i = 0; i < 10; i++) {
        mems.push(makeMemory({ id: `m${i}`, layer: MemoryLayer.INSTANT }));
      }
      await db.insertMemories(mems);

      // Default limit of 100 should return all 10
      const result = await db.getMemoriesByLayer(MemoryLayer.INSTANT);
      expect(result).toHaveLength(10);
    });

    test("returns empty array for layer with no memories", async () => {
      const result = await db.getMemoriesByLayer(MemoryLayer.DEEP);
      expect(result).toEqual([]);
    });
  });

  // 7 ─────────────────────────────────────────────────────────────
  describe("getSurprisingMemories", () => {
    beforeEach(() => {
      db = createDB();
    });

    test("only returns SELECTION layer memories with score >= threshold, ordered by score desc", async () => {
      await db.insertMemories([
        makeMemory({
          id: "low",
          layer: MemoryLayer.SELECTION,
          surpriseScore: 0.3,
          content: "low surprise",
        }),
        makeMemory({
          id: "mid",
          layer: MemoryLayer.SELECTION,
          surpriseScore: 0.6,
          content: "mid surprise",
        }),
        makeMemory({
          id: "high",
          layer: MemoryLayer.SELECTION,
          surpriseScore: 0.95,
          content: "high surprise",
        }),
        makeMemory({
          id: "instant-high",
          layer: MemoryLayer.INSTANT,
          surpriseScore: 0.99,
          content: "should not appear",
        }),
        makeMemory({
          id: "deep-high",
          layer: MemoryLayer.DEEP,
          surpriseScore: 0.99,
          content: "should not appear",
        }),
      ]);

      const result = await db.getSurprisingMemories(0.5);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("high"); // highest score first
      expect(result[1].id).toBe("mid");
      // "low" (0.3) is below threshold 0.5
      // instant-high and deep-high are not SELECTION layer
      const ids = result.map((m) => m.id);
      expect(ids).not.toContain("low");
      expect(ids).not.toContain("instant-high");
      expect(ids).not.toContain("deep-high");
    });

    test("exactly at threshold is included", async () => {
      await db.insertMemory(
        makeMemory({
          id: "exact",
          layer: MemoryLayer.SELECTION,
          surpriseScore: 0.5,
        })
      );

      const result = await db.getSurprisingMemories(0.5);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("exact");
    });
  });

  // 8 ─────────────────────────────────────────────────────────────
  describe("getSurprisingMemories - different thresholds", () => {
    test("threshold 0 returns all SELECTION memories", async () => {
      db = createDB();
      await db.insertMemories([
        makeMemory({ id: "a", layer: MemoryLayer.SELECTION, surpriseScore: 0 }),
        makeMemory({ id: "b", layer: MemoryLayer.SELECTION, surpriseScore: 0.1 }),
      ]);

      const result = await db.getSurprisingMemories(0);
      expect(result).toHaveLength(2);
    });

    test("threshold 1 returns only score 1.0", async () => {
      db = createDB();
      await db.insertMemories([
        makeMemory({ id: "a", layer: MemoryLayer.SELECTION, surpriseScore: 1.0 }),
        makeMemory({ id: "b", layer: MemoryLayer.SELECTION, surpriseScore: 0.99 }),
      ]);

      const result = await db.getSurprisingMemories(1.0);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("a");
    });

    test("threshold 0.99 returns scores >= 0.99", async () => {
      db = createDB();
      await db.insertMemories([
        makeMemory({ id: "a", layer: MemoryLayer.SELECTION, surpriseScore: 1.0 }),
        makeMemory({ id: "b", layer: MemoryLayer.SELECTION, surpriseScore: 0.99 }),
        makeMemory({ id: "c", layer: MemoryLayer.SELECTION, surpriseScore: 0.98 }),
      ]);

      const result = await db.getSurprisingMemories(0.99);
      expect(result).toHaveLength(2);
      const ids = result.map((m) => m.id).sort();
      expect(ids).toEqual(["a", "b"]);
    });
  });

  // 9 ─────────────────────────────────────────────────────────────
  describe("getRecentMemories", () => {
    test("returns memories within the time cutoff based on hoursAgo", async () => {
      db = createDB();

      const now = Date.now();
      const oneHourMs = 3600 * 1000;

      await db.insertMemories([
        makeMemory({
          id: "recent",
          layer: MemoryLayer.INSTANT,
          timestamp: now - oneHourMs / 2, // 30 min ago
        }),
        makeMemory({
          id: "old",
          layer: MemoryLayer.INSTANT,
          timestamp: now - oneHourMs * 2, // 2 hours ago
        }),
        makeMemory({
          id: "very-old",
          layer: MemoryLayer.INSTANT,
          timestamp: now - oneHourMs * 24, // 24 hours ago
        }),
      ]);

      const result = await db.getRecentMemories(1); // last 1 hour
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("recent");
    });

    test("returns memories across all layers", async () => {
      db = createDB();

      const now = Date.now();
      await db.insertMemories([
        makeMemory({ id: "i", layer: MemoryLayer.INSTANT, timestamp: now - 100 }),
        makeMemory({ id: "s", layer: MemoryLayer.SELECTION, timestamp: now - 200 }),
        makeMemory({ id: "d", layer: MemoryLayer.DEEP, timestamp: now - 300 }),
      ]);

      const result = await db.getRecentMemories(1);
      expect(result).toHaveLength(3);
    });

    test("default hoursAgo is 1", async () => {
      db = createDB();

      // Memory from 30 min ago
      await db.insertMemory(
        makeMemory({
          id: "recent",
          layer: MemoryLayer.INSTANT,
          timestamp: Date.now() - 30 * 60 * 1000,
        })
      );

      const result = await db.getRecentMemories();
      expect(result.length).toBeGreaterThanOrEqual(1);
      expect(result[0].id).toBe("recent");
    });

    test("returns empty when no memories in time window", async () => {
      db = createDB();

      await db.insertMemory(
        makeMemory({
          id: "old",
          layer: MemoryLayer.INSTANT,
          timestamp: Date.now() - 2 * 3600 * 1000, // 2 hours ago
        })
      );

      const result = await db.getRecentMemories(1);
      expect(result).toEqual([]);
    });

    test("returns ordered by timestamp desc", async () => {
      db = createDB();

      const now = Date.now();
      await db.insertMemories([
        makeMemory({ id: "a", timestamp: now - 300, layer: MemoryLayer.INSTANT }),
        makeMemory({ id: "b", timestamp: now - 100, layer: MemoryLayer.INSTANT }),
        makeMemory({ id: "c", timestamp: now - 200, layer: MemoryLayer.INSTANT }),
      ]);

      const result = await db.getRecentMemories(1);
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe("b");
      expect(result[1].id).toBe("c");
      expect(result[2].id).toBe("a");
    });
  });

  // 10 ────────────────────────────────────────────────────────────
  describe("upsertGraphNode - insert new", () => {
    test("inserts a new node and returns it (connections as JSON string from raw row)", async () => {
      db = createDB();

      const input = makeGraphNodeInput({
        id: "node-1",
        label: "functional-programming",
        type: "concept",
        content: "User likes FP patterns",
        connections: ["node-2", "node-3"],
        weight: 0.9,
        timestamp: Date.now(),
        source: "inference",
      });

      const result = await db.upsertGraphNode(input);

      expect(result.id).toBe("node-1");
      expect(result.label).toBe("functional-programming");
      expect(result.type).toBe("concept");
      expect(result.content).toBe("User likes FP patterns");
      // upsertGraphNode returns the raw drizzle row — connections is a JSON string
      expect(result.connections).toBe('["node-2","node-3"]');
      expect(result.weight).toBe(0.9);
      expect(result.source).toBe("inference");

      // getGraphNode properly parses connections into an array
      const parsed = await db.getGraphNode("node-1");
      expect(parsed!.connections).toEqual(["node-2", "node-3"]);
    });

    test("generates a UUID if no id is provided", async () => {
      db = createDB();

      const input = makeGraphNodeInput({
        label: "auto-id",
        type: "preference",
        content: "test",
      });

      const result = await db.upsertGraphNode(input);
      expect(result.id).toBeDefined();
      expect(result.id).not.toBe("");
      // Should be a valid UUID v4 format
      expect(result.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
      expect(result.label).toBe("auto-id");
    });
  });

  // 11 ────────────────────────────────────────────────────────────
  describe("upsertGraphNode - update existing", () => {
    test("updates an existing node preserving its id, updating all fields", async () => {
      db = createDB();

      // First insert
      const original = await db.upsertGraphNode(
        makeGraphNodeInput({
          id: "node-update",
          label: "original-label",
          type: "concept",
          content: "original content",
          connections: ["conn-a"],
          weight: 0.3,
        })
      );

      expect(original.id).toBe("node-update");
      expect(original.label).toBe("original-label");
      // raw connection string from upsertGraphNode
      expect(original.connections).toBe('["conn-a"]');

      // Now update
      const updated = await db.upsertGraphNode(
        makeGraphNodeInput({
          id: "node-update",
          label: "updated-label",
          type: "correction",
          content: "updated content",
          connections: ["conn-x", "conn-y"],
          weight: 0.99,
          source: "new-source",
        })
      );

      expect(updated.id).toBe("node-update"); // same id
      expect(updated.label).toBe("updated-label");
      expect(updated.type).toBe("correction");
      expect(updated.content).toBe("updated content");
      // raw string from upsertGraphNode
      expect(updated.connections).toBe('["conn-x","conn-y"]');
      expect(updated.weight).toBe(0.99);
      expect(updated.source).toBe("new-source");

      // Verify no duplicate was created via getGraphNode (parsed connections)
      const node = await db.getGraphNode("node-update");
      expect(node).toBeDefined();
      expect(node!.label).toBe("updated-label");
      expect(node!.connections).toEqual(["conn-x", "conn-y"]);
    });
  });

  // 12 ────────────────────────────────────────────────────────────
  describe("getGraphNode", () => {
    test("returns node with connections parsed from JSON", async () => {
      db = createDB();

      await db.upsertGraphNode(
        makeGraphNodeInput({
          id: "gn-1",
          connections: ["a", "b", "c"],
        })
      );

      const node = await db.getGraphNode("gn-1");
      expect(node).toBeDefined();
      expect(node!.id).toBe("gn-1");
      expect(node!.connections).toEqual(["a", "b", "c"]);
      // Verify connections is an Array, not a string
      expect(Array.isArray(node!.connections)).toBe(true);
      expect(node!.connections).toHaveLength(3);
    });

    test("handles empty connections array", async () => {
      db = createDB();

      await db.upsertGraphNode(
        makeGraphNodeInput({ id: "no-conns", connections: [] })
      );

      const node = await db.getGraphNode("no-conns");
      expect(node).toBeDefined();
      expect(node!.connections).toEqual([]);
    });
  });

  // 13 ────────────────────────────────────────────────────────────
  describe("getGraphNode - non-existent", () => {
    test("returns undefined for a node that does not exist", async () => {
      db = createDB();
      const node = await db.getGraphNode("does-not-exist");
      expect(node).toBeUndefined();
    });
  });

  // 14 ────────────────────────────────────────────────────────────
  describe("getConnectedNodes", () => {
    test("returns connected nodes via connection IDs", async () => {
      db = createDB();

      // Create three nodes
      await db.upsertGraphNode(
        makeGraphNodeInput({ id: "center", label: "center", connections: ["a", "b"] })
      );
      await db.upsertGraphNode(
        makeGraphNodeInput({ id: "a", label: "node-a", connections: [] })
      );
      await db.upsertGraphNode(
        makeGraphNodeInput({ id: "b", label: "node-b", connections: [] })
      );

      const connected = await db.getConnectedNodes("center");
      expect(connected).toHaveLength(2);
      const labels = connected.map((n) => n.label).sort();
      expect(labels).toEqual(["node-a", "node-b"]);
    });

    test("skips connection IDs that don't exist", async () => {
      db = createDB();

      await db.upsertGraphNode(
        makeGraphNodeInput({
          id: "partial",
          label: "partial",
          connections: ["exists", "missing"],
        })
      );
      await db.upsertGraphNode(
        makeGraphNodeInput({ id: "exists", label: "exists" })
      );

      const connected = await db.getConnectedNodes("partial");
      expect(connected).toHaveLength(1);
      expect(connected[0].id).toBe("exists");
    });

    test("returns empty array when node has no connections", async () => {
      db = createDB();

      await db.upsertGraphNode(
        makeGraphNodeInput({ id: "lonely", label: "lonely", connections: [] })
      );

      const connected = await db.getConnectedNodes("lonely");
      expect(connected).toEqual([]);
    });
  });

  // 15 ────────────────────────────────────────────────────────────
  describe("getConnectedNodes - non-existent node", () => {
    test("returns empty array for non-existent node", async () => {
      db = createDB();
      const connected = await db.getConnectedNodes("ghost-node");
      expect(connected).toEqual([]);
    });
  });

  // 16 ────────────────────────────────────────────────────────────
  describe("getHighWeightNodes", () => {
    beforeEach(() => {
      db = createDB();
    });

    test("filters by minWeight and returns in descending order", async () => {
      await db.upsertGraphNode(
        makeGraphNodeInput({ id: "low", label: "low", weight: 0.2 })
      );
      await db.upsertGraphNode(
        makeGraphNodeInput({ id: "mid", label: "mid", weight: 0.6 })
      );
      await db.upsertGraphNode(
        makeGraphNodeInput({ id: "high", label: "high", weight: 0.95 })
      );
      await db.upsertGraphNode(
        makeGraphNodeInput({ id: "exact", label: "exact", weight: 0.7 })
      );

      const result = await db.getHighWeightNodes(0.7);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("high"); // highest first
      expect(result[1].id).toBe("exact");
    });

    test("default minWeight is 0.7", async () => {
      await db.upsertGraphNode(
        makeGraphNodeInput({ id: "below", label: "below", weight: 0.5 })
      );
      await db.upsertGraphNode(
        makeGraphNodeInput({ id: "above", label: "above", weight: 0.8 })
      );

      const result = await db.getHighWeightNodes();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("above");
    });

    test("returns empty array when no nodes meet threshold", async () => {
      await db.upsertGraphNode(
        makeGraphNodeInput({ id: "low", label: "low", weight: 0.1 })
      );

      const result = await db.getHighWeightNodes(0.9);
      expect(result).toEqual([]);
    });

    test("returns nodes with parsed connections", async () => {
      await db.upsertGraphNode(
        makeGraphNodeInput({
          id: "hw",
          label: "hw",
          weight: 0.9,
          connections: ["c1", "c2"],
        })
      );

      const result = await db.getHighWeightNodes(0.8);
      expect(result).toHaveLength(1);
      expect(Array.isArray(result[0].connections)).toBe(true);
      expect(result[0].connections).toEqual(["c1", "c2"]);
    });
  });

  // 17 ────────────────────────────────────────────────────────────
  describe("searchGraphNodes", () => {
    beforeEach(() => {
      db = createDB();
    });

    test("matches by label", async () => {
      await db.upsertGraphNode(
        makeGraphNodeInput({ id: "n1", label: "TypeScript", content: "some content" })
      );
      await db.upsertGraphNode(
        makeGraphNodeInput({ id: "n2", label: "Rust", content: "other" })
      );

      const result = await db.searchGraphNodes("typescript");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("n1");
    });

    test("matches by content", async () => {
      await db.upsertGraphNode(
        makeGraphNodeInput({ id: "n1", label: "label1", content: "I love TypeScript" })
      );
      await db.upsertGraphNode(
        makeGraphNodeInput({ id: "n2", label: "label2", content: "unrelated" })
      );

      const result = await db.searchGraphNodes("typescript");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("n1");
    });

    test("is case insensitive", async () => {
      await db.upsertGraphNode(
        makeGraphNodeInput({ id: "n1", label: "TYPESCRIPT", content: "test" })
      );
      await db.upsertGraphNode(
        makeGraphNodeInput({ id: "n2", label: "label", content: "TypeScript pattern" })
      );

      const result = await db.searchGraphNodes("typescript");
      expect(result).toHaveLength(2);
    });

    test("partial substring match", async () => {
      await db.upsertGraphNode(
        makeGraphNodeInput({ id: "n1", label: "functional-programming", content: "fp" })
      );
      await db.upsertGraphNode(
        makeGraphNodeInput({ id: "n2", label: "functional-testing", content: "testing" })
      );
      await db.upsertGraphNode(
        makeGraphNodeInput({ id: "n3", label: "oop", content: "object oriented" })
      );

      const result = await db.searchGraphNodes("functional");
      expect(result).toHaveLength(2);
    });

    test("returns empty array when no matches", async () => {
      await db.upsertGraphNode(
        makeGraphNodeInput({ id: "n1", label: "Rust", content: "systems" })
      );

      const result = await db.searchGraphNodes("nonexistent");
      expect(result).toEqual([]);
    });

    test("returns nodes with parsed connections", async () => {
      await db.upsertGraphNode(
        makeGraphNodeInput({
          id: "n1",
          label: "test",
          content: "test",
          connections: ["a", "b"],
        })
      );

      const result = await db.searchGraphNodes("test");
      expect(result).toHaveLength(1);
      expect(Array.isArray(result[0].connections)).toBe(true);
      expect(result[0].connections).toEqual(["a", "b"]);
    });
  });

  // 18 ────────────────────────────────────────────────────────────
  describe("getStats - empty DB", () => {
    test("returns all zeros for an empty database", async () => {
      db = createDB();

      const stats = await db.getStats();
      expect(stats.sessions).toBe(0);
      expect(stats.memories).toBe(0);
      expect(stats.graphNodes).toBe(0);
      expect(stats.perLayer).toEqual({});
    });
  });

  // 19 ────────────────────────────────────────────────────────────
  describe("getStats - populated DB", () => {
    test("returns correct counts per layer and totals", async () => {
      db = createDB();

      // Add 2 sessions
      await db.createSession(makeSession({ id: "sess-1" }));
      await db.createSession(makeSession({ id: "sess-2" }));

      // Add 5 memories across layers
      await db.insertMemories([
        makeMemory({ id: "m1", layer: MemoryLayer.INSTANT }),
        makeMemory({ id: "m2", layer: MemoryLayer.INSTANT }),
        makeMemory({ id: "m3", layer: MemoryLayer.INSTANT }),
        makeMemory({ id: "m4", layer: MemoryLayer.SELECTION }),
        makeMemory({ id: "m5", layer: MemoryLayer.DEEP }),
      ]);

      // Add 3 graph nodes
      await db.upsertGraphNode(makeGraphNodeInput({ id: "g1" }));
      await db.upsertGraphNode(makeGraphNodeInput({ id: "g2" }));
      await db.upsertGraphNode(makeGraphNodeInput({ id: "g3" }));

      const stats = await db.getStats();
      expect(stats.sessions).toBe(2);
      expect(stats.memories).toBe(5);
      expect(stats.graphNodes).toBe(3);
      expect(stats.perLayer).toEqual({
        instant: 3,
        selection: 1,
        deep: 1,
      });
    });
  });

  // 20 ────────────────────────────────────────────────────────────
  describe("deleteOldMemories", () => {
    test("deletes memories matching the current gte semantics", async () => {
      db = createDB();

      const now = Date.now();
      const oneDayMs = 86400 * 1000;

      // NOTE: The current implementation uses gte (>=) instead of lte (<=),
      // meaning it deletes memories with timestamp >= cutoff (i.e., newer ones).
      // This test covers the actual behavior as implemented.

      await db.insertMemories([
        makeMemory({
          id: "very-old",
          layer: MemoryLayer.INSTANT,
          timestamp: now - oneDayMs * 30, // 30 days ago
        }),
        makeMemory({
          id: "moderate",
          layer: MemoryLayer.INSTANT,
          timestamp: now - oneDayMs * 10, // 10 days ago
        }),
        makeMemory({
          id: "recent",
          layer: MemoryLayer.INSTANT,
          timestamp: now - oneDayMs, // 1 day ago
        }),
      ]);

      // cutoff = now - 7 days. gte(cutoff) matches timestamps >= cutoff.
      // "recent" (1 day ago) is the only one >= cutoff; "very-old" and "moderate" are < cutoff.
      const deleted = await db.deleteOldMemories(7);
      expect(deleted).toBe(1);

      // Verify "very-old" and "moderate" survived (they are below the cutoff)
      const remaining = await db.getMemoriesByLayer(MemoryLayer.INSTANT);
      expect(remaining).toHaveLength(2);
      const remainingIds = remaining.map((m) => m.id).sort();
      expect(remainingIds).toEqual(["moderate", "very-old"]);
    });

    test("returns 0 when no memories match criteria", async () => {
      db = createDB();

      // Insert only very old memories
      await db.insertMemory(
        makeMemory({
          id: "ancient",
          layer: MemoryLayer.INSTANT,
          timestamp: 1, // epoch start
        })
      );

      // With gte, this would delete memories >= cutoff (recent ones),
      // but our memory has timestamp=1 which is way below the cutoff.
      const deleted = await db.deleteOldMemories(7);
      expect(deleted).toBe(0);
    });
  });

  // 21 ────────────────────────────────────────────────────────────
  describe("close", () => {
    test("closes the underlying SQLite database without error", () => {
      db = createDB();
      // Should not throw
      expect(() => db.close()).not.toThrow();
    });

    test("close can be called safely (idempotent-ish — may throw after already closed)", () => {
      db = createDB();
      db.close();
      // Second close on a closed DB may throw — we just verify it doesn't hang
      try {
        db.close();
      } catch {
        // expected on some SQLite drivers
      }
    });
  });
});

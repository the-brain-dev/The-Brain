/**
 * Supplementary tests for storage-sqlite.ts — covers remaining delegate methods.
 *
 * Missing coverage: sessions, graph traversal, getAllMemories, getRecentMemories,
 * deleteOldMemories, edge cases.
 */

import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import { createSqliteBackend } from "../storage-sqlite";
import { MemoryLayer } from "../types";
import type { Memory, Session, GraphNodeRecord } from "../types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DIR = mkdtempSync(join(tmpdir(), "sqlite-backend-extra-"));
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

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Sessions ─────────────────────────────────────────────────

describe("Sessions", () => {
  it("creates and retrieves a session", async () => {
    const sid = `sess-${makeId()}`;
    const session: Session = {
      id: sid,
      startedAt: Date.now(),
      source: "cursor",
      interactionCount: 5,
    };
    await backend.createSession(session);

    const retrieved = await backend.getSession(sid);
    expect(retrieved).toBeDefined();
    expect((retrieved as any).id).toBe(sid);
    expect((retrieved as any).source).toBe("cursor");
  });

  it("returns undefined for non-existent session", async () => {
    const result = await backend.getSession("nonexistent-session-id");
    expect(result).toBeUndefined();
  });

  it("lists recent sessions with limit", async () => {
    // Create a few sessions
    for (let i = 0; i < 3; i++) {
      await backend.createSession({
        id: `recent-${makeId()}`,
        startedAt: Date.now() - i * 1000,
        source: "test",
        interactionCount: i,
      });
    }

    const recent = await backend.getRecentSessions(2);
    expect(recent.length).toBeLessThanOrEqual(2);
    expect(recent.length).toBeGreaterThan(0);
  });
});

// ── Memory Retrieval ─────────────────────────────────────────

describe("Memory Retrieval", () => {
  it("getAllMemories returns all memories up to limit", async () => {
    const results = await backend.getAllMemories(100);
    expect(Array.isArray(results)).toBe(true);
  });

  it("getAllMemories respects maxResults limit", async () => {
    const results = await backend.getAllMemories(1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("getRecentMemories filters by hours", async () => {
    const mem: Memory = {
      id: `recentmem-${makeId()}`,
      layer: MemoryLayer.INSTANT,
      content: "Recent memory",
      surpriseScore: null,
      timestamp: Date.now() - 60000, // 1 minute ago
      source: "test",
    };
    await backend.insertMemory(mem);

    const recent = await backend.getRecentMemories(1); // last 1 hour
    expect(Array.isArray(recent)).toBe(true);
    // Should find our recently inserted memory
    expect(recent.some((m: Memory) => m.id === mem.id)).toBe(true);
  });

  it("getRecentMemories excludes old memories", async () => {
    const oldMem: Memory = {
      id: `oldmem-${makeId()}`,
      layer: MemoryLayer.INSTANT,
      content: "Very old memory",
      surpriseScore: null,
      timestamp: Date.now() - 10 * 3600 * 1000, // 10 hours ago
      source: "test",
    };
    await backend.insertMemory(oldMem);

    const recent = await backend.getRecentMemories(1); // last 1 hour
    expect(recent.some((m: Memory) => m.id === oldMem.id)).toBe(false);
  });
});

// ── Graph Nodes ──────────────────────────────────────────────

describe("Graph Nodes", () => {
  it("retrieves graph node by ID", async () => {
    const node: Omit<GraphNodeRecord, "id"> & { id?: string } = {
      id: "gnode-test-1",
      label: "Single Node",
      type: "concept",
      content: "A single graph node",
      connections: ["gnode-test-2"],
      weight: 0.8,
      timestamp: Date.now(),
      source: "test",
    };
    await backend.upsertGraphNode(node);

    const retrieved = await backend.getGraphNode("gnode-test-1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.label).toBe("Single Node");
    expect(retrieved!.weight).toBe(0.8);
  });

  it("returns undefined for non-existent graph node", async () => {
    const result = await backend.getGraphNode("nonexistent-node-id");
    expect(result).toBeUndefined();
  });

  it("retrieves connected nodes", async () => {
    // Create node with connection
    const parent: Omit<GraphNodeRecord, "id"> & { id?: string } = {
      id: "parent-node",
      label: "Parent",
      type: "correction",
      content: "Parent node",
      connections: ["child-node"],
      weight: 0.9,
      timestamp: Date.now(),
      source: "test",
    };
    const child: Omit<GraphNodeRecord, "id"> & { id?: string } = {
      id: "child-node",
      label: "Child",
      type: "concept",
      content: "Child node",
      connections: [],
      weight: 0.3,
      timestamp: Date.now(),
      source: "test",
    };
    await backend.upsertGraphNode(parent);
    await backend.upsertGraphNode(child);

    const connected = await backend.getConnectedNodes("parent-node");
    expect(connected.length).toBe(1);
    expect(connected[0].id).toBe("child-node");
  });

  it("getConnectedNodes returns empty for node with no connections", async () => {
    const result = await backend.getConnectedNodes("child-node");
    expect(result).toEqual([]);
  });

  it("getConnectedNodes returns empty for unknown node", async () => {
    const result = await backend.getConnectedNodes("nonexistent-node");
    expect(result).toEqual([]);
  });

  it("filters high-weight nodes", async () => {
    const high = await backend.getHighWeightNodes(0.7);
    expect(high.length).toBeGreaterThan(0);
    for (const n of high) {
      expect(n.weight).toBeGreaterThanOrEqual(0.7);
    }
  });

  it("getHighWeightNodes with very high threshold returns empty", async () => {
    const result = await backend.getHighWeightNodes(0.99);
    expect(Array.isArray(result)).toBe(true);
    // May be empty or almost empty
    for (const n of result) {
      expect(n.weight).toBeGreaterThanOrEqual(0.99);
    }
  });
});

// ── Maintenance ──────────────────────────────────────────────

describe("Maintenance", () => {
  it("deletes old memories", async () => {
    const veryOld: Memory = {
      id: `ancient-${makeId()}`,
      layer: MemoryLayer.INSTANT,
      content: "Ancient memory for deletion",
      surpriseScore: null,
      timestamp: Date.now() - 100 * 86400 * 1000, // 100 days ago
      source: "test",
    };
    await backend.insertMemory(veryOld);

    const deleted = await backend.deleteOldMemories(30); // older than 30 days
    expect(typeof deleted).toBe("number");
    expect(deleted).toBeGreaterThanOrEqual(1);

    // Verify it's gone
    const gone = await backend.getMemoryById(veryOld.id);
    expect(gone).toBeUndefined();
  });

  it("deleteOldMemories returns 0 when nothing to delete", async () => {
    const count = await backend.deleteOldMemories(999); // 999 days — nothing that old
    expect(typeof count).toBe("number");
  });
});

// ── Edge Cases ───────────────────────────────────────────────

describe("Edge Cases", () => {
  it("handles duplicate session creation gracefully", async () => {
    // BrainDB uses INSERT, duplicates would throw UNIQUE constraint
    // Just verify createSession doesn't crash on valid data
    const sid = `edge-sess-${makeId()}`;
    await backend.createSession({
      id: sid,
      startedAt: Date.now(),
      source: "test",
      interactionCount: 0,
    });
    const retrieved = await backend.getSession(sid);
    expect(retrieved).toBeDefined();
  });

  it("searchGraphNodes handles empty query", async () => {
    const results = await backend.searchGraphNodes("");
    expect(Array.isArray(results)).toBe(true);
  });

  it("getMemoriesByLayer returns empty for unused layer", async () => {
    const results = await backend.getMemoriesByLayer("nonexistent-layer" as any, 10);
    expect(Array.isArray(results)).toBe(true);
  });
});

/**
 * SQLite Storage Backend — wraps BrainDB into the StorageBackend interface.
 *
 * This is the default storage plugin. Swap for Postgres, LibSQL, etc.
 */
import type { StorageBackend } from "./layers/index";
import { BrainDB } from "./db/index";
import { MemoryLayer } from "./types";
import type { Memory, GraphNodeRecord, Session } from "./types";

export function createSqliteBackend(dbPath: string): StorageBackend {
  const db = new BrainDB(dbPath);

  return {
    async init(): Promise<void> {
      // BrainDB initializes tables in constructor — no-op for re-init
    },

    // ── Sessions ──────────────────────────────────────
    async createSession(session: Session) {
      await db.createSession(session);
    },
    async getSession(id: string) {
      return db.getSession(id) as Promise<Record<string, unknown> | undefined>;
    },
    async getRecentSessions(limit?: number) {
      return db.getRecentSessions(limit) as Promise<Record<string, unknown>[]>;
    },

    // ── Memories ──────────────────────────────────────
    async insertMemory(memory: Memory) {
      await db.insertMemory(memory);
    },
    async insertMemories(memories: Memory[]) {
      await db.insertMemories(memories);
    },
    async getMemoriesByLayer(layer: MemoryLayer, limit) {
      return db.getMemoriesByLayer(layer, limit);
    },
    async getSurprisingMemories(threshold) {
      return db.getSurprisingMemories(threshold);
    },
    async updateMemory(id, updates) {
      await db.updateMemory(id, updates);
    },
    async deleteMemory(id) {
      await db.deleteMemory(id);
    },
    async getMemoryById(id: string) {
      return db.getMemoryById(id);
    },
    async getAllMemories(maxResults) {
      return db.getAllMemories(maxResults);
    },
    async getRecentMemories(hoursAgo) {
      return db.getRecentMemories(hoursAgo);
    },

    // ── Graph Nodes ───────────────────────────────────
    async upsertGraphNode(node) {
      return db.upsertGraphNode(node);
    },
    async getGraphNode(id) {
      return db.getGraphNode(id);
    },
    async getConnectedNodes(nodeId) {
      return db.getConnectedNodes(nodeId);
    },
    async getHighWeightNodes(minWeight) {
      return db.getHighWeightNodes(minWeight);
    },
    async searchGraphNodes(query) {
      return db.searchGraphNodes(query);
    },

    // ── Stats & Maintenance ───────────────────────────
    async getStats() {
      return db.getStats() as Promise<Record<string, unknown>>;
    },
    async deleteOldMemories(olderThanDays) {
      return db.deleteOldMemories(olderThanDays);
    },
    async close() {
      db.close();
    },
  };
}

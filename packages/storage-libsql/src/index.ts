/**
 * @the-brain/storage-libsql — Remote LibSQL / Turso Storage Backend
 *
 * Implements the StorageBackend interface using @libsql/client for
 * SQLite-compatible remote storage over HTTP or WebSocket.
 *
 * Configuration:
 *   - url:      LibSQL server URL (e.g., "https://the-brain.turso.io")
 *   - authToken: Turso auth token (or " " for local dev)
 *
 * Usage in config.json:
 *   "backends": {
 *     "storage": "@the-brain/storage-libsql"
 *   }
 *
 * Environment variables:
 *   THE_BRAIN_LIBSQL_URL       — server URL
 *   THE_BRAIN_LIBSQL_TOKEN     — auth token
 */

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { eq, desc, and, gte, lte, like, or } from "drizzle-orm";
import type { StorageBackend } from "@the-brain/core";
import { MemoryLayer } from "@the-brain/core";
import type { Memory, GraphNodeRecord, Session } from "@the-brain/core";

// ── Drizzle Schema (mirrors BrainDB tables) ──────

const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at"),
  source: text("source").notNull(),
  interactionCount: integer("interaction_count").notNull().default(0),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
});

const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  layer: text("layer").notNull(),
  content: text("content").notNull(),
  surpriseScore: real("surprise_score"),
  timestamp: integer("timestamp").notNull(),
  source: text("source").notNull(),
  sessionId: text("session_id"),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
});

const graphNodes = sqliteTable("graph_nodes", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  type: text("type").notNull(),
  content: text("content").notNull(),
  connections: text("connections", { mode: "json" }).notNull().$type<string[]>(),
  weight: real("weight").notNull().default(0.5),
  timestamp: integer("timestamp").notNull(),
  source: text("source").notNull(),
});

// ── LibSQL Storage Backend ──────────────────────────

export function createLibsqlBackend(options?: {
  url?: string;
  authToken?: string;
}): StorageBackend {
  const url = options?.url ?? process.env.THE_BRAIN_LIBSQL_URL ?? "http://127.0.0.1:8080";
  const authToken = options?.authToken ?? process.env.THE_BRAIN_LIBSQL_TOKEN;

  const client = createClient({ url, authToken });
  const db = drizzle(client);

  // Init tables on first use
  let initialized = false;

  async function ensureInit(): Promise<void> {
    if (initialized) return;
    await client.execute(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER,
      source TEXT NOT NULL, interaction_count INTEGER NOT NULL DEFAULT 0, metadata TEXT
    )`);
    await client.execute(`CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY, layer TEXT NOT NULL, content TEXT NOT NULL,
      surprise_score REAL, timestamp INTEGER NOT NULL, source TEXT NOT NULL,
      session_id TEXT, metadata TEXT
    )`);
    await client.execute(`CREATE TABLE IF NOT EXISTS graph_nodes (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, type TEXT NOT NULL,
      content TEXT NOT NULL, connections TEXT NOT NULL DEFAULT '[]',
      weight REAL NOT NULL DEFAULT 0.5, timestamp INTEGER NOT NULL, source TEXT NOT NULL
    )`);
    await client.execute(`CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(layer)`);
    await client.execute(`CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp)`);
    await client.execute(`CREATE INDEX IF NOT EXISTS idx_graph_weight ON graph_nodes(weight)`);
    initialized = true;
  }

  return {
    async init() { await ensureInit(); },

    // ── Sessions ──────────────────────────
    async createSession(session: Session) {
      await ensureInit();
      await db.insert(sessions).values(session).run();
    },
    async getSession(id: string) {
      await ensureInit();
      return db.select().from(sessions).where(eq(sessions.id, id)).get() as Promise<Record<string, unknown> | undefined>;
    },
    async getRecentSessions(limit = 10) {
      await ensureInit();
      return db.select().from(sessions).orderBy(desc(sessions.startedAt)).limit(limit).all() as Promise<Record<string, unknown>[]>;
    },

    // ── Memories ──────────────────────────
    async insertMemory(memory: Memory) {
      await ensureInit();
      await db.insert(memories).values(memory).run();
    },
    async insertMemories(memoryList: Memory[]) {
      await ensureInit();
      if (memoryList.length === 0) return;
      await db.insert(memories).values(memoryList).run();
    },
    async getMemoriesByLayer(layer: MemoryLayer, limit = 100) {
      await ensureInit();
      return db.select().from(memories).where(eq(memories.layer, layer))
        .orderBy(desc(memories.timestamp)).limit(limit).all() as Promise<Memory[]>;
    },
    async getSurprisingMemories(threshold = 0.5) {
      await ensureInit();
      const rows = await client.execute({
        sql: `SELECT * FROM memories WHERE layer = ? AND surprise_score IS NOT NULL AND surprise_score >= ? ORDER BY surprise_score DESC`,
        args: [MemoryLayer.SELECTION, threshold],
      });
      return rows.rows as unknown as Memory[];
    },
    async updateMemory(id: string, updates: Partial<Omit<Memory, "id">>) {
      await ensureInit();
      const setClauses: string[] = [];
      const bindValues: unknown[] = [];
      for (const [key, value] of Object.entries(updates)) {
        const col = key === "surpriseScore" ? "surprise_score" : key === "sessionId" ? "session_id" : key;
        setClauses.push(`${col} = ?`);
        bindValues.push(value);
      }
      if (setClauses.length === 0) return;
      bindValues.push(id);
      await client.execute({ sql: `UPDATE memories SET ${setClauses.join(", ")} WHERE id = ?`, args: bindValues });
    },
    async deleteMemory(id: string) {
      await ensureInit();
      await client.execute({ sql: "DELETE FROM memories WHERE id = ?", args: [id] });
    },
    async getMemoryById(id: string) {
      await ensureInit();
      return db.select().from(memories).where(eq(memories.id, id)).get() as Promise<Memory | undefined>;
    },
    async getAllMemories(maxResults = 1000) {
      await ensureInit();
      return db.select().from(memories).orderBy(desc(memories.timestamp)).limit(maxResults).all() as Promise<Memory[]>;
    },
    async getRecentMemories(hoursAgo = 1) {
      await ensureInit();
      const cutoff = Date.now() - hoursAgo * 3600 * 1000;
      return db.select().from(memories).where(gte(memories.timestamp, cutoff))
        .orderBy(desc(memories.timestamp)).all() as Promise<Memory[]>;
    },

    // ── Graph Nodes ───────────────────────
    async upsertGraphNode(node: Omit<GraphNodeRecord, "id"> & { id?: string }) {
      await ensureInit();
      const id = node.id ?? crypto.randomUUID();
      const existing = await db.select().from(graphNodes).where(eq(graphNodes.id, id)).get();
      if (existing) {
        await db.update(graphNodes).set({ ...node, id, connections: JSON.stringify(node.connections) })
          .where(eq(graphNodes.id, id)).run();
      } else {
        await db.insert(graphNodes).values({ ...node, id, connections: JSON.stringify(node.connections) }).run();
      }
      return db.select().from(graphNodes).where(eq(graphNodes.id, id)).get()
        .then(r => r ? { ...r, connections: JSON.parse(r.connections as string) } : undefined)
        .catch((err) => {
          console.error("[StorageLibSQL] upsertGraphNode: failed to return result:", err);
          throw err;
        }) as Promise<GraphNodeRecord>;
    },
    async getGraphNode(id: string) {
      await ensureInit();
      const node = await db.select().from(graphNodes).where(eq(graphNodes.id, id)).get();
      if (!node) return undefined;
      return {
        ...node,
        connections: typeof node.connections === "string" ? JSON.parse(node.connections as string) : node.connections,
      } as GraphNodeRecord;
    },
    async getConnectedNodes(nodeId: string) {
      await ensureInit();
      const node = await db.select().from(graphNodes).where(eq(graphNodes.id, nodeId)).get();
      if (!node) return [];
      const connIds: string[] = typeof node.connections === "string" ? JSON.parse(node.connections as string) : node.connections;
      const connected: GraphNodeRecord[] = [];
      for (const connId of connIds) {
        const conn = await db.select().from(graphNodes).where(eq(graphNodes.id, connId)).get();
        if (conn) {
          connected.push({
            ...conn,
            connections: typeof conn.connections === "string" ? JSON.parse(conn.connections as string) : conn.connections,
          } as GraphNodeRecord);
        }
      }
      return connected;
    },
    async getHighWeightNodes(minWeight = 0.7) {
      await ensureInit();
      const nodes = await db.select().from(graphNodes).where(gte(graphNodes.weight, minWeight))
        .orderBy(desc(graphNodes.weight)).all();
      return nodes.map(n => ({
        ...n,
        connections: typeof n.connections === "string" ? JSON.parse(n.connections as string) : n.connections,
      })) as GraphNodeRecord[];
    },
    async searchGraphNodes(query: string) {
      await ensureInit();
      const escaped = query.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
      const pattern = `%${escaped}%`;
      const nodes = await db.select().from(graphNodes).where(
        or(like(graphNodes.label, pattern), like(graphNodes.content, pattern))!
      ).orderBy(desc(graphNodes.weight)).all();
      return nodes.map(n => ({
        ...n,
        connections: typeof n.connections === "string" ? JSON.parse(n.connections as string) : n.connections,
      })) as GraphNodeRecord[];
    },

    // ── Stats & Maintenance ────────────────
    async getStats() {
      await ensureInit();
      const [sessionsRow, memoriesRow, graphRow] = await Promise.all([
        client.execute("SELECT COUNT(*) as c FROM sessions"),
        client.execute("SELECT COUNT(*) as c FROM memories"),
        client.execute("SELECT COUNT(*) as c FROM graph_nodes"),
      ]);
      const perLayer = await client.execute("SELECT layer, COUNT(*) as c FROM memories GROUP BY layer");
      const perGraphType = await client.execute("SELECT type, COUNT(*) as c, ROUND(AVG(weight),2) as avg_w FROM graph_nodes GROUP BY type ORDER BY c DESC");
      const perSource = await client.execute("SELECT source, COUNT(*) as c FROM graph_nodes GROUP BY source ORDER BY c DESC");
      const memoryPerSource = await client.execute("SELECT source, COUNT(*) as c FROM memories GROUP BY source ORDER BY c DESC");

      return {
        sessions: Number((sessionsRow.rows[0] as any)?.c ?? 0),
        memories: Number((memoriesRow.rows[0] as any)?.c ?? 0),
        graphNodes: Number((graphRow.rows[0] as any)?.c ?? 0),
        perLayer: Object.fromEntries(perLayer.rows.map(r => [r.layer as string, Number(r.c)])),
        perGraphType: perGraphType.rows,
        perSource: perSource.rows,
        memoryPerSource: memoryPerSource.rows,
      };
    },
    async deleteOldMemories(olderThanDays = 7) {
      await ensureInit();
      const cutoff = Date.now() - olderThanDays * 86400 * 1000;
      const result = await db.delete(memories).where(lte(memories.timestamp, cutoff)).run();
      return Number(result.changes);
    },
    async close() { client.close(); },
  };
}

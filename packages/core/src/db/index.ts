import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";
import { eq, desc, and, gte, lte, like, or, sql } from "drizzle-orm";
import type { Session, Memory, GraphNodeRecord, Interaction, MemoryFragment } from "../types";
import { MemoryLayer } from "../types";

// ── Drizzle Schema ──────────────────────────────────────────────

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  startedAt: integer("started_at").notNull(),
  endedAt: integer("ended_at"),
  source: text("source").notNull(),
  interactionCount: integer("interaction_count").notNull().default(0),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
});

export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  layer: text("layer").notNull().$type<MemoryLayer>(),
  content: text("content").notNull(),
  surpriseScore: real("surprise_score"),
  timestamp: integer("timestamp").notNull(),
  source: text("source").notNull(),
  sessionId: text("session_id").references(() => sessions.id),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
});

export const graphNodes = sqliteTable("graph_nodes", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  type: text("type").notNull().$type<"concept" | "correction" | "preference" | "pattern">(),
  content: text("content").notNull(),
  connections: text("connections", { mode: "json" }).notNull().$type<string[]>(),
  weight: real("weight").notNull().default(0.5),
  timestamp: integer("timestamp").notNull(),
  source: text("source").notNull(),
});

// ── Database Manager ────────────────────────────────────────────

export class BrainDB {
  private db: ReturnType<typeof drizzle>;
  private sqlite: Database;

  constructor(dbPath: string) {
    this.sqlite = new Database(dbPath);
    this.sqlite.run("PRAGMA journal_mode=WAL");
    this.sqlite.run("PRAGMA foreign_keys=ON");
    this.db = drizzle(this.sqlite);
    this.initTables();
  }

  private initTables(): void {
    this.sqlite.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        source TEXT NOT NULL,
        interaction_count INTEGER NOT NULL DEFAULT 0,
        metadata TEXT
      )
    `);
    this.sqlite.run(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        layer TEXT NOT NULL,
        content TEXT NOT NULL,
        surprise_score REAL,
        timestamp INTEGER NOT NULL,
        source TEXT NOT NULL,
        session_id TEXT REFERENCES sessions(id),
        metadata TEXT
      )
    `);
    this.sqlite.run(`
      CREATE TABLE IF NOT EXISTS graph_nodes (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        connections TEXT NOT NULL DEFAULT '[]',
        weight REAL NOT NULL DEFAULT 0.5,
        timestamp INTEGER NOT NULL,
        source TEXT NOT NULL
      )
    `);
    this.sqlite.run(`
      CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(layer)
    `);
    this.sqlite.run(`
      CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp)
    `);
    this.sqlite.run(`
      CREATE INDEX IF NOT EXISTS idx_graph_weight ON graph_nodes(weight)
    `);
  }

  // ── Sessions ────────────────────────────────────────────────

  async createSession(session: Session): Promise<void> {
    await this.db.insert(sessions).values(session).run();
  }

  async getSession(id: string): Promise<Session | undefined> {
    return this.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .get() as Session | undefined;
  }

  async getRecentSessions(limit = 10): Promise<Session[]> {
    return this.db
      .select()
      .from(sessions)
      .orderBy(desc(sessions.startedAt))
      .limit(limit)
      .all() as Session[];
  }

  // ── Memories ────────────────────────────────────────────────

  async insertMemory(memory: Memory): Promise<void> {
    await this.db.insert(memories).values(memory).run();
  }

  async insertMemories(memoryList: Memory[]): Promise<void> {
    if (memoryList.length === 0) return;
    // Batch insert for performance — single VALUES clause with multiple rows
    await this.db.insert(memories).values(memoryList).run();
  }

  async getMemoriesByLayer(layer: MemoryLayer, limit = 100): Promise<Memory[]> {
    return this.db
      .select()
      .from(memories)
      .where(eq(memories.layer, layer))
      .orderBy(desc(memories.timestamp))
      .limit(limit)
      .all() as Memory[];
  }

  async getSurprisingMemories(threshold = 0.5): Promise<Memory[]> {
    // Use raw SQL to safely handle nullable surprise_score column
    const rows = this.sqlite
      .query(
        `SELECT * FROM memories WHERE layer = ? AND surprise_score IS NOT NULL AND surprise_score >= ? ORDER BY surprise_score DESC`
      )
      .all(MemoryLayer.SELECTION, threshold) as Memory[];
    return rows;
  }

  async updateMemory(id: string, updates: Partial<Omit<Memory, "id">>): Promise<void> {
    // Use raw SQLite for updates since Drizzle doesn't support dynamic column sets easily
    const setClauses: string[] = [];
    const bindValues: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      const col = key === "surpriseScore" ? "surprise_score" :
                   key === "sessionId" ? "session_id" :
                   key;
      setClauses.push(`${col} = ?`);
      bindValues.push(value);
    }

    if (setClauses.length === 0) return;

    bindValues.push(id);
    this.sqlite.run(
      `UPDATE memories SET ${setClauses.join(", ")} WHERE id = ?`,
      ...bindValues
    );
  }

  async deleteMemory(id: string): Promise<void> {
    this.sqlite.run("DELETE FROM memories WHERE id = ?", id);
  }

  async getMemoryById(id: string): Promise<Memory | undefined> {
    return this.db
      .select()
      .from(memories)
      .where(eq(memories.id, id))
      .get() as Memory | undefined;
  }

  async getAllMemories(maxResults = 1000): Promise<Memory[]> {
    return this.db
      .select()
      .from(memories)
      .orderBy(desc(memories.timestamp))
      .limit(maxResults)
      .all() as Memory[];
  }

  async getRecentMemories(hoursAgo = 1): Promise<Memory[]> {
    const cutoff = Date.now() - hoursAgo * 3600 * 1000;
    return this.db
      .select()
      .from(memories)
      .where(gte(memories.timestamp, cutoff))
      .orderBy(desc(memories.timestamp))
      .all() as Memory[];
  }

  // ── Graph Nodes ─────────────────────────────────────────────

  async upsertGraphNode(node: Omit<GraphNodeRecord, "id"> & { id?: string }): Promise<GraphNodeRecord> {
    const id = node.id ?? crypto.randomUUID();
    const existing = await this.db
      .select()
      .from(graphNodes)
      .where(eq(graphNodes.id, id))
      .get();

    if (existing) {
      await this.db
        .update(graphNodes)
        .set({
          ...node,
          id,
          connections: JSON.stringify(node.connections),
        })
        .where(eq(graphNodes.id, id))
        .run();
    } else {
      await this.db
        .insert(graphNodes)
        .values({
          ...node,
          id,
          connections: JSON.stringify(node.connections),
        })
        .run();
    }

    return (await this.db
      .select()
      .from(graphNodes)
      .where(eq(graphNodes.id, id))
      .get()) as GraphNodeRecord;
  }

  async getGraphNode(id: string): Promise<GraphNodeRecord | undefined> {
    const node = await this.db
      .select()
      .from(graphNodes)
      .where(eq(graphNodes.id, id))
      .get();

    if (node) {
      return {
        ...node,
        connections: typeof node.connections === "string"
          ? JSON.parse(node.connections as string)
          : node.connections,
      } as GraphNodeRecord;
    }
    return undefined;
  }

  async getConnectedNodes(nodeId: string): Promise<GraphNodeRecord[]> {
    const node = await this.getGraphNode(nodeId);
    if (!node) return [];

    const connected: GraphNodeRecord[] = [];
    for (const connId of node.connections) {
      const conn = await this.getGraphNode(connId);
      if (conn) connected.push(conn);
    }
    return connected;
  }

  async getHighWeightNodes(minWeight = 0.7): Promise<GraphNodeRecord[]> {
    const nodes = await this.db
      .select()
      .from(graphNodes)
      .where(gte(graphNodes.weight, minWeight))
      .orderBy(desc(graphNodes.weight))
      .all();

    return nodes.map((n) => ({
      ...n,
      connections: typeof n.connections === "string"
        ? JSON.parse(n.connections as string)
        : n.connections,
    })) as GraphNodeRecord[];
  }

  async searchGraphNodes(query: string): Promise<GraphNodeRecord[]> {
    // SQL LIKE with server-side filtering — O(n) but fine for <10k nodes.
    // Escape LIKE special chars: %, _, and the escape char itself
    const escaped = query
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
    const pattern = `%${escaped}%`;

    const nodes = await this.db
      .select()
      .from(graphNodes)
      .where(
        or(
          like(graphNodes.label, pattern),
          like(graphNodes.content, pattern),
        )!
      )
      .orderBy(desc(graphNodes.weight))
      .all();

    return nodes.map((n) => ({
      ...n,
      connections: typeof n.connections === "string"
        ? JSON.parse(n.connections as string)
        : n.connections,
    })) as GraphNodeRecord[];
  }

  // ── Stats & Maintenance ─────────────────────────────────────

  async getStats() {
    const sessionCount = (
      await this.sqlite.query("SELECT COUNT(*) as c FROM sessions").get()
    ) as { c: number };
    const memoryCount = (
      await this.sqlite.query("SELECT COUNT(*) as c FROM memories").get()
    ) as { c: number };
    const graphCount = (
      await this.sqlite.query("SELECT COUNT(*) as c FROM graph_nodes").get()
    ) as { c: number };
    const perLayer = (await this.sqlite
      .query("SELECT layer, COUNT(*) as c FROM memories GROUP BY layer")
      .all()) as { layer: string; c: number }[];
    const perGraphType = (await this.sqlite
      .query("SELECT type, COUNT(*) as c, ROUND(AVG(weight),2) as avg_w FROM graph_nodes GROUP BY type ORDER BY c DESC")
      .all()) as { type: string; c: number; avg_w: number }[];
    const perSource = (await this.sqlite
      .query("SELECT source, COUNT(*) as c FROM graph_nodes GROUP BY source ORDER BY c DESC")
      .all()) as { source: string; c: number }[];
    const memoryPerSource = (await this.sqlite
      .query("SELECT source, COUNT(*) as c FROM memories GROUP BY source ORDER BY c DESC")
      .all()) as { source: string; c: number }[];

    return {
      sessions: sessionCount.c,
      memories: memoryCount.c,
      graphNodes: graphCount.c,
      perLayer: Object.fromEntries(perLayer.map((r) => [r.layer, r.c])),
      perGraphType,
      perSource,
      memoryPerSource,
    };
  }

  async deleteOldMemories(olderThanDays = 7): Promise<number> {
    const cutoff = Date.now() - olderThanDays * 86400 * 1000;
    const result = await this.db
      .delete(memories)
      .where(lte(memories.timestamp, cutoff))
      .run();
    return result.changes;
  }

  close(): void {
    this.sqlite.close();
  }
}

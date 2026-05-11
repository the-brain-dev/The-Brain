import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { eq, desc, and } from "drizzle-orm";
import type { User, UserRole, UserPermission, AuthToken, AuditEntry } from "../auth-types";

// ── Drizzle Schema ──────────────────────────────────────────────

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  displayName: text("display_name"),
  role: text("role").notNull().$type<UserRole>(),
  permissions: text("permissions", { mode: "json" }).notNull().$type<UserPermission[]>(),
  createdAt: integer("created_at").notNull(),
  lastActive: integer("last_active"),
});

export const authTokens = sqliteTable("auth_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id).notNull(),
  token: text("token").notNull().unique(),
  label: text("label"),
  createdAt: integer("created_at").notNull(),
  lastUsed: integer("last_used"),
  revoked: integer("revoked").notNull().default(0),
});

export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  action: text("action").notNull(),
  project: text("project"),
  detail: text("detail"),
  timestamp: integer("timestamp").notNull(),
});

// ── Token Generator ─────────────────────────────────────────────

function generateToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `mb_${hex}`;
}

// ── Auth Database Manager ───────────────────────────────────────

export class AuthDB {
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
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        display_name TEXT,
        role TEXT NOT NULL,
        permissions TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        last_active INTEGER
      )
    `);
    this.sqlite.run(`
      CREATE TABLE IF NOT EXISTS auth_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        token TEXT NOT NULL UNIQUE,
        label TEXT,
        created_at INTEGER NOT NULL,
        last_used INTEGER,
        revoked INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.sqlite.run(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        project TEXT,
        detail TEXT,
        timestamp INTEGER NOT NULL
      )
    `);
    this.sqlite.run(`CREATE INDEX IF NOT EXISTS idx_auth_tokens_token ON auth_tokens(token)`);
    this.sqlite.run(`CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id)`);
    this.sqlite.run(`CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp)`);
  }

  // ── User Management ─────────────────────────────────────────

  async getUser(id: string): Promise<User | null> {
    const row = this.sqlite.query("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!row) return null;
    return this.toUser(row);
  }

  async getUserByName(name: string): Promise<User | null> {
    const row = this.sqlite.query("SELECT * FROM users WHERE name = ?").get(name) as Record<string, unknown> | null;
    if (!row) return null;
    return this.toUser(row);
  }

  async getAllUsers(): Promise<User[]> {
    const rows = this.sqlite.query("SELECT * FROM users ORDER BY created_at DESC").all() as Record<string, unknown>[];
    return rows.map((r) => this.toUser(r));
  }

  async createUser(
    name: string,
    displayName?: string,
    role: UserRole = "contributor" as UserRole,
    permissions: UserPermission[] = []
  ): Promise<User> {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.sqlite.run(
      `INSERT INTO users (id, name, display_name, role, permissions, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      name,
      displayName ?? null,
      role,
      JSON.stringify(permissions),
      now
    );
    const user = await this.getUser(id);
    if (!user) throw new Error("Failed to create user");
    return user;
  }

  async updateUserPermissions(
    id: string,
    updates: { role?: UserRole; permissions?: UserPermission[] }
  ): Promise<User | null> {
    const user = await this.getUser(id);
    if (!user) return null;

    const newRole = updates.role ?? user.role;
    const newPermissions = updates.permissions ?? user.permissions;

    this.sqlite.run(
      `UPDATE users SET role = ?, permissions = ? WHERE id = ?`,
      newRole,
      JSON.stringify(newPermissions),
      id
    );

    return this.getUser(id);
  }

  async removeUser(id: string): Promise<boolean> {
    // Revoke all tokens first, then delete audit log, then delete user
    this.sqlite.run("DELETE FROM auth_tokens WHERE user_id = ?", id);
    this.sqlite.run("DELETE FROM audit_log WHERE user_id = ?", id);
    const result = this.sqlite.run("DELETE FROM users WHERE id = ?", id);
    return result.changes > 0;
  }

  // ── Token Management ────────────────────────────────────────

  async createToken(userId: string, label?: string): Promise<AuthToken> {
    const id = crypto.randomUUID();
    const token = generateToken();
    const now = Date.now();
    this.sqlite.run(
      `INSERT INTO auth_tokens (id, user_id, token, label, created_at, revoked) VALUES (?, ?, ?, ?, ?, 0)`,
      id,
      userId,
      token,
      label ?? null,
      now
    );
    const authToken = await this.getTokenById(id);
    if (!authToken) throw new Error("Failed to create token");
    return authToken;
  }

  async revokeToken(tokenId: string): Promise<boolean> {
    const result = this.sqlite.run("UPDATE auth_tokens SET revoked = 1 WHERE id = ?", tokenId);
    return result.changes > 0;
  }

  async validateToken(token: string): Promise<{ user: User; token: AuthToken } | null> {
    const tokenRow = this.sqlite.query(
      "SELECT * FROM auth_tokens WHERE token = ? AND revoked = 0"
    ).get(token) as Record<string, unknown> | null;
    if (!tokenRow) return null;

    const authToken = this.toAuthToken(tokenRow);
    // Update last_used
    this.sqlite.run("UPDATE auth_tokens SET last_used = ? WHERE id = ?", Date.now(), authToken.id);
    authToken.lastUsed = Date.now();

    const user = await this.getUser(authToken.userId);
    if (!user) return null;

    return { user, token: authToken };
  }

  async listUserTokens(userId: string): Promise<AuthToken[]> {
    const rows = this.sqlite.query(
      "SELECT * FROM auth_tokens WHERE user_id = ? ORDER BY created_at DESC"
    ).all(userId) as Record<string, unknown>[];
    return rows.map((r) => this.toAuthToken(r));
  }

  private async getTokenById(id: string): Promise<AuthToken | null> {
    const row = this.sqlite.query("SELECT * FROM auth_tokens WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!row) return null;
    return this.toAuthToken(row);
  }

  // ── Audit Log ───────────────────────────────────────────────

  async logAudit(userId: string, action: string, project?: string, detail?: string): Promise<void> {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.sqlite.run(
      `INSERT INTO audit_log (id, user_id, action, project, detail, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      action,
      project ?? null,
      detail ?? null,
      now
    );
  }

  async getAuditLog(userId?: string, project?: string, limit = 100): Promise<AuditEntry[]> {
    let query = "SELECT * FROM audit_log";
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (userId) {
      conditions.push("user_id = ?");
      params.push(userId);
    }
    if (project) {
      conditions.push("project = ?");
      params.push(project);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " ORDER BY timestamp DESC LIMIT ?";
    params.push(limit);

    const rows = this.sqlite.query(query).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.toAuditEntry(r));
  }

  // ── Serialization Helpers ───────────────────────────────────

  private toUser(row: Record<string, unknown>): User {
    return {
      id: row.id as string,
      name: row.name as string,
      displayName: (row.display_name as string) ?? undefined,
      role: row.role as UserRole,
      permissions: typeof row.permissions === "string" ? JSON.parse(row.permissions as string) : (row.permissions as UserPermission[]),
      createdAt: row.created_at as number,
      lastActive: (row.last_active as number) ?? undefined,
    };
  }

  private toAuthToken(row: Record<string, unknown>): AuthToken {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      token: row.token as string,
      label: (row.label as string) ?? undefined,
      createdAt: row.created_at as number,
      lastUsed: (row.last_used as number) ?? undefined,
      revoked: row.revoked === 1 || row.revoked === true,
    };
  }

  private toAuditEntry(row: Record<string, unknown>): AuditEntry {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      action: row.action as string,
      project: (row.project as string) ?? undefined,
      detail: (row.detail as string) ?? undefined,
      timestamp: row.timestamp as number,
    };
  }

  close(): void {
    this.sqlite.close();
  }
}

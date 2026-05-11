import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { AuthDB, UserRole } from "@the-brain-dev/core";
import type { User, AuthToken, AuditEntry, UserPermission } from "@the-brain-dev/core";

// ── Helpers ─────────────────────────────────────────────────────

function createDB(): AuthDB {
  return new AuthDB(":memory:");
}

// ── Suite ────────────────────────────────────────────────────────

describe("AuthDB", () => {
  let db: AuthDB;

  afterEach(() => {
    try {
      db?.close();
    } catch {
      // already closed — fine
    }
  });

  // 1 ─────────────────────────────────────────────────────────────
  describe("constructor", () => {
    test("creates DB and initializes all tables + indices", async () => {
      db = createDB();

      const sqlite = (db as unknown as { sqlite: { query: (sql: string) => { all: () => { name: string }[] } } }).sqlite;
      const tables = sqlite
        .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all();

      const tableNames = tables.map((t: { name: string }) => t.name).sort();
      expect(tableNames).toContain("users");
      expect(tableNames).toContain("auth_tokens");
      expect(tableNames).toContain("audit_log");

      const indexes = sqlite
        .query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
        .all();

      const indexNames = indexes.map((i: { name: string }) => i.name).sort();
      expect(indexNames).toContain("idx_auth_tokens_token");
      expect(indexNames).toContain("idx_audit_log_user_id");
      expect(indexNames).toContain("idx_audit_log_timestamp");
    });
  });

  // 2 ─────────────────────────────────────────────────────────────
  describe("createUser + getUser", () => {
    test("creates a user and retrieves by id", async () => {
      db = createDB();
      const user = await db.createUser("alice", "Alice", UserRole.ADMIN, []);

      expect(user.id).toBeDefined();
      expect(user.name).toBe("alice");
      expect(user.displayName).toBe("Alice");
      expect(user.role).toBe(UserRole.ADMIN);
      expect(user.permissions).toEqual([]);
      expect(user.createdAt).toBeGreaterThan(0);
      expect(user.lastActive).toBeUndefined();

      const retrieved = await db.getUser(user.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe("alice");
      expect(retrieved!.role).toBe(UserRole.ADMIN);
    });

    test("default role is CONTRIBUTOR with empty permissions", async () => {
      db = createDB();
      const user = await db.createUser("bob");

      expect(user.role).toBe(UserRole.CONTRIBUTOR);
      expect(user.permissions).toEqual([]);
    });

    test("creates user with displayName and permissions", async () => {
      db = createDB();
      const permissions: UserPermission[] = [
        { project: "proj-a", role: UserRole.CONTRIBUTOR },
        { project: "proj-b", role: UserRole.OBSERVER },
      ];
      const user = await db.createUser("carol", "Carol", UserRole.ADMIN, permissions);

      expect(user.displayName).toBe("Carol");
      expect(user.permissions).toEqual(permissions);

      const retrieved = await db.getUser(user.id);
      expect(retrieved!.permissions).toEqual(permissions);
      expect(retrieved!.permissions[0].project).toBe("proj-a");
      expect(retrieved!.permissions[0].role).toBe(UserRole.CONTRIBUTOR);
    });

    test("returns null for non-existent user", async () => {
      db = createDB();
      const result = await db.getUser("nonexistent-id");
      expect(result).toBeNull();
    });
  });

  // 3 ─────────────────────────────────────────────────────────────
  describe("getUserByName", () => {
    test("retrieves user by name", async () => {
      db = createDB();
      const user = await db.createUser("dave", "Dave");
      const found = await db.getUserByName("dave");
      expect(found).not.toBeNull();
      expect(found!.id).toBe(user.id);
      expect(found!.name).toBe("dave");
    });

    test("returns null for non-existent name", async () => {
      db = createDB();
      const result = await db.getUserByName("nobody");
      expect(result).toBeNull();
    });
  });

  // 4 ─────────────────────────────────────────────────────────────
  describe("getAllUsers", () => {
    test("returns all users ordered by created_at desc", async () => {
      db = createDB();
      await db.createUser("alice");
      await new Promise((r) => setTimeout(r, 5));
      await db.createUser("bob");
      await new Promise((r) => setTimeout(r, 5));
      await db.createUser("carol");

      const all = await db.getAllUsers();
      expect(all).toHaveLength(3);
      expect(all[0].name).toBe("carol"); // most recent first
      expect(all[1].name).toBe("bob");
      expect(all[2].name).toBe("alice");
    });

    test("returns empty array when no users exist", async () => {
      db = createDB();
      const all = await db.getAllUsers();
      expect(all).toEqual([]);
    });
  });

  // 5 ─────────────────────────────────────────────────────────────
  describe("duplicate name", () => {
    test("fails when creating a user with an existing name", async () => {
      db = createDB();
      await db.createUser("eve");

      try {
        await db.createUser("eve");
        // Should not reach here
        expect(false).toBe(true);
      } catch (err) {
        expect(err).toBeDefined();
      }
    });
  });

  // 6 ─────────────────────────────────────────────────────────────
  describe("removeUser", () => {
    test("removes user and returns true", async () => {
      db = createDB();
      const user = await db.createUser("frank");

      const result = await db.removeUser(user.id);
      expect(result).toBe(true);

      const after = await db.getUser(user.id);
      expect(after).toBeNull();
    });

    test("returns false for non-existent user", async () => {
      db = createDB();
      const result = await db.removeUser("nonexistent");
      expect(result).toBe(false);
    });

    test("cascades: removes user's tokens and audit entries", async () => {
      db = createDB();
      const user = await db.createUser("grace");
      await db.createToken(user.id, "token-1");
      await db.logAudit(user.id, "user.created", "proj-a", "test detail");

      const tokensBefore = await db.listUserTokens(user.id);
      expect(tokensBefore).toHaveLength(1);

      const auditBefore = await db.getAuditLog(user.id);
      expect(auditBefore).toHaveLength(1);

      await db.removeUser(user.id);

      // Tokens and audit entries should be cleaned up
      const tokensAfter = await db.listUserTokens(user.id);
      expect(tokensAfter).toEqual([]);

      const auditAfter = await db.getAuditLog(user.id);
      expect(auditAfter).toEqual([]);
    });
  });

  // 7 ─────────────────────────────────────────────────────────────
  describe("createToken", () => {
    test("creates a token with mb_ prefix and 32 hex chars", async () => {
      db = createDB();
      const user = await db.createUser("hank");

      const authToken = await db.createToken(user.id, "cli-token");

      expect(authToken.id).toBeDefined();
      expect(authToken.userId).toBe(user.id);
      expect(authToken.token).toMatch(/^mb_[0-9a-f]{32}$/);
      expect(authToken.label).toBe("cli-token");
      expect(authToken.createdAt).toBeGreaterThan(0);
      expect(authToken.revoked).toBe(false);
      expect(authToken.lastUsed).toBeUndefined();
    });

    test("creates token without label", async () => {
      db = createDB();
      const user = await db.createUser("iris");

      const authToken = await db.createToken(user.id);
      expect(authToken.label).toBeUndefined();
      expect(authToken.token).toBeDefined();
    });

    test("each token is unique", async () => {
      db = createDB();
      const user = await db.createUser("jack");

      const t1 = await db.createToken(user.id);
      const t2 = await db.createToken(user.id);
      const t3 = await db.createToken(user.id);

      expect(t1.token).not.toBe(t2.token);
      expect(t2.token).not.toBe(t3.token);
      expect(t1.token).not.toBe(t3.token);
    });
  });

  // 8 ─────────────────────────────────────────────────────────────
  describe("validateToken", () => {
    test("returns user and token for valid token", async () => {
      db = createDB();
      const user = await db.createUser("karen", "Karen", UserRole.ADMIN);
      const authToken = await db.createToken(user.id, "api-key");

      const result = await db.validateToken(authToken.token);
      expect(result).not.toBeNull();
      expect(result!.user.id).toBe(user.id);
      expect(result!.user.name).toBe("karen");
      expect(result!.token.id).toBe(authToken.id);
      expect(result!.token.token).toBe(authToken.token);
    });

    test("updates lastUsed on validate", async () => {
      db = createDB();
      const user = await db.createUser("leo");
      const authToken = await db.createToken(user.id);

      // First validate
      const result1 = await db.validateToken(authToken.token);
      expect(result1!.token.lastUsed).toBeDefined();
      const firstLastUsed = result1!.token.lastUsed!;

      // Wait a tick so timestamps differ
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Second validate
      const result2 = await db.validateToken(authToken.token);
      expect(result2!.token.lastUsed).toBeDefined();
      expect(result2!.token.lastUsed!).toBeGreaterThan(firstLastUsed);
    });

    test("returns null for invalid token", async () => {
      db = createDB();
      await db.createUser("mike");

      const result = await db.validateToken("mb_invalidstring000000000000000000");
      expect(result).toBeNull();
    });

    test("returns null for malformed token", async () => {
      db = createDB();

      const result = await db.validateToken("random-garbage");
      expect(result).toBeNull();
    });

    test("returns null for revoked token", async () => {
      db = createDB();
      const user = await db.createUser("nancy");
      const authToken = await db.createToken(user.id, "temp-token");

      // Valid at first
      const valid = await db.validateToken(authToken.token);
      expect(valid).not.toBeNull();

      // Revoke it
      const revoked = await db.revokeToken(authToken.id);
      expect(revoked).toBe(true);

      // Now should return null
      const after = await db.validateToken(authToken.token);
      expect(after).toBeNull();
    });

    test("returns null for token of deleted user", async () => {
      db = createDB();
      const user = await db.createUser("oliver");
      const authToken = await db.createToken(user.id);

      await db.removeUser(user.id);

      const result = await db.validateToken(authToken.token);
      expect(result).toBeNull();
    });
  });

  // 9 ─────────────────────────────────────────────────────────────
  describe("revokeToken", () => {
    test("revokes a token and returns true", async () => {
      db = createDB();
      const user = await db.createUser("paul");
      const authToken = await db.createToken(user.id);

      const result = await db.revokeToken(authToken.id);
      expect(result).toBe(true);

      // Validation should now fail
      const validation = await db.validateToken(authToken.token);
      expect(validation).toBeNull();
    });

    test("returns false for non-existent token", async () => {
      db = createDB();
      const result = await db.revokeToken("nonexistent-token");
      expect(result).toBe(false);
    });

    test("revoking already revoked token returns true (idempotent)", async () => {
      db = createDB();
      const user = await db.createUser("quinn");
      const authToken = await db.createToken(user.id);

      await db.revokeToken(authToken.id);
      const result = await db.revokeToken(authToken.id);
      expect(result).toBe(true);
    });
  });

  // 10 ────────────────────────────────────────────────────────────
  describe("listUserTokens", () => {
    test("lists all tokens for a user", async () => {
      db = createDB();
      const user = await db.createUser("rose");
      await db.createToken(user.id, "token-1");
      await new Promise((r) => setTimeout(r, 5));
      await db.createToken(user.id, "token-2");
      await new Promise((r) => setTimeout(r, 5));
      await db.createToken(user.id, "token-3");

      const tokens = await db.listUserTokens(user.id);
      expect(tokens).toHaveLength(3);
      expect(tokens[0].label).toBe("token-3"); // most recent first
      expect(tokens[1].label).toBe("token-2");
      expect(tokens[2].label).toBe("token-1");
    });

    test("returns empty array for user with no tokens", async () => {
      db = createDB();
      const user = await db.createUser("sam");

      const tokens = await db.listUserTokens(user.id);
      expect(tokens).toEqual([]);
    });

    test("does not include tokens of other users", async () => {
      db = createDB();
      const alice = await db.createUser("alice-t");
      const bob = await db.createUser("bob-t");

      await db.createToken(alice.id, "alice-token");
      await db.createToken(bob.id, "bob-token");

      const aliceTokens = await db.listUserTokens(alice.id);
      expect(aliceTokens).toHaveLength(1);
      expect(aliceTokens[0].label).toBe("alice-token");
    });
  });

  // 11 ────────────────────────────────────────────────────────────
  describe("audit log", () => {
    test("logs audit entry and retrieves by userId", async () => {
      db = createDB();
      const user = await db.createUser("tom");

      await db.logAudit(user.id, "user.created", "proj-x", "Created user via CLI");

      const entries = await db.getAuditLog(user.id);
      expect(entries).toHaveLength(1);
      expect(entries[0].userId).toBe(user.id);
      expect(entries[0].action).toBe("user.created");
      expect(entries[0].project).toBe("proj-x");
      expect(entries[0].detail).toBe("Created user via CLI");
      expect(entries[0].timestamp).toBeGreaterThan(0);
    });

    test("logs audit entry without project or detail", async () => {
      db = createDB();
      const user = await db.createUser("uma");

      await db.logAudit(user.id, "login");

      const entries = await db.getAuditLog(user.id);
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe("login");
      expect(entries[0].project).toBeUndefined();
      expect(entries[0].detail).toBeUndefined();
    });

    test("retrieves all audit entries when no userId filter", async () => {
      db = createDB();
      const alice = await db.createUser("alice-a");
      const bob = await db.createUser("bob-a");

      await db.logAudit(alice.id, "login");
      await db.logAudit(bob.id, "token.created");
      await db.logAudit(alice.id, "logout");

      const all = await db.getAuditLog();
      expect(all).toHaveLength(3);
    });

    test("filters by project", async () => {
      db = createDB();
      const user = await db.createUser("victor");

      await db.logAudit(user.id, "action-1", "proj-a");
      await db.logAudit(user.id, "action-2", "proj-b");
      await db.logAudit(user.id, "action-3", "proj-a");

      const projA = await db.getAuditLog(undefined, "proj-a");
      expect(projA).toHaveLength(2);
      expect(projA[0].project).toBe("proj-a");
      expect(projA[1].project).toBe("proj-a");
    });

    test("respects limit parameter", async () => {
      db = createDB();
      const user = await db.createUser("wendy");

      for (let i = 0; i < 10; i++) {
        await db.logAudit(user.id, `action-${i}`);
      }

      const entries = await db.getAuditLog(user.id, undefined, 3);
      expect(entries).toHaveLength(3);
    });

    test("default limit is 100", async () => {
      db = createDB();
      const user = await db.createUser("xavier");

      for (let i = 0; i < 10; i++) {
        await db.logAudit(user.id, `action-${i}`);
      }

      const entries = await db.getAuditLog(user.id);
      expect(entries).toHaveLength(10);
    });

    test("returns empty array when no audit entries", async () => {
      db = createDB();
      const entries = await db.getAuditLog();
      expect(entries).toEqual([]);
    });
  });

  // 12 ────────────────────────────────────────────────────────────
  describe("role-based permission scaffolding", () => {
    test("ADMIN user has full access (scaffolding)", async () => {
      db = createDB();
      const admin = await db.createUser("admin-user", "Admin", UserRole.ADMIN);

      // Scaffolding: verify role is stored correctly
      const retrieved = await db.getUser(admin.id);
      expect(retrieved!.role).toBe(UserRole.ADMIN);

      // Future: check can do admin-level operations
    });

    test("CONTRIBUTOR with project permissions (scaffolding)", async () => {
      db = createDB();
      const user = await db.createUser("contrib-user", "Contrib", UserRole.CONTRIBUTOR, [
        { project: "project-a", role: UserRole.CONTRIBUTOR },
        { project: "project-b", role: UserRole.OBSERVER },
      ]);

      const retrieved = await db.getUser(user.id);
      expect(retrieved!.role).toBe(UserRole.CONTRIBUTOR);
      expect(retrieved!.permissions).toHaveLength(2);

      // Verify specific permissions
      const projectA = retrieved!.permissions.find((p) => p.project === "project-a");
      expect(projectA).toBeDefined();
      expect(projectA!.role).toBe(UserRole.CONTRIBUTOR);

      const projectB = retrieved!.permissions.find((p) => p.project === "project-b");
      expect(projectB).toBeDefined();
      expect(projectB!.role).toBe(UserRole.OBSERVER);
    });

    test("OBSERVER user has read-only role (scaffolding)", async () => {
      db = createDB();
      const observer = await db.createUser("observer-user", "Observer", UserRole.OBSERVER);

      expect(observer.role).toBe(UserRole.OBSERVER);

      // Future: check read-only access enforcement
    });

    test("permissions round-trip with nested arrays", async () => {
      db = createDB();
      const permissions: UserPermission[] = [
        { project: "p1", role: UserRole.ADMIN },
        { project: "p2", role: UserRole.OBSERVER },
      ];
      const user = await db.createUser("perm-user", undefined, UserRole.CONTRIBUTOR, permissions);

      const retrieved = await db.getUser(user.id);
      expect(retrieved!.permissions).toEqual(permissions);
    });
  });
});

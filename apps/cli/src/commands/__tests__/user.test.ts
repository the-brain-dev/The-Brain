/**
 * user command tests — validates multi-user CLI operations against an isolated auth.db.
 *
 * Tests DB state (not console output) after each command invocation.
 * Uses dynamic imports to ensure process.env.HOME is set before module constants are read.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

let userCommand: any;
let AuthDB: any;
let UserRole: any;
let tmpDir: string;

const origExit = process.exit;

beforeAll(async () => {
  tmpDir = join(tmpdir(), `the-brain-user-test-${Date.now()}`);
  process.env.HOME = tmpDir;
  await mkdir(join(tmpDir, ".the-brain"), { recursive: true });

  // Minimal config so loadConfigSafe doesn't throw (it soft-fails anyway)
  await writeFile(
    join(tmpDir, ".the-brain", "config.json"),
    JSON.stringify({ server: { mode: "local" } }),
    "utf-8",
  );

  const userMod = await import("../user");
  userCommand = userMod.userCommand;

  const core = await import("@the-brain/core");
  AuthDB = core.AuthDB;
  UserRole = core.UserRole;

  // Mock process.exit to throw instead of terminating
  process.exit = ((code?: number) => {
    throw new Error(`EXIT:${code}`);
  }) as any;
});

afterAll(async () => {
  process.exit = origExit;
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────────

function authDbPath(): string {
  return join(tmpDir, ".the-brain", "auth.db");
}

function newAuthDB(): any {
  return new AuthDB(authDbPath());
}

describe("user add", () => {
  test("creates a user with default contributor role", async () => {
    await userCommand("add", { name: "testuser", project: "cpv" });

    const db = newAuthDB();
    const user = await db.getUserByName("testuser");
    expect(user).not.toBeNull();
    expect(user.name).toBe("testuser");
    expect(user.permissions).toHaveLength(1);
    expect(user.permissions[0].project).toBe("cpv");
    expect(user.permissions[0].role).toBe("contributor");
    db.close();
  });

  test("creates a user with explicit role", async () => {
    await userCommand("add", { name: "roleuser", project: "cpv", role: "admin" });

    const db = newAuthDB();
    const user = await db.getUserByName("roleuser");
    expect(user).not.toBeNull();
    expect(user.permissions[0].role).toBe("admin");
    db.close();
  });

  test("creates a user with contributor role explicitly", async () => {
    await userCommand("add", { name: "contrib", project: "cpv", role: "contributor" });

    const db = newAuthDB();
    const user = await db.getUserByName("contrib");
    expect(user).not.toBeNull();
    expect(user.permissions[0].role).toBe("contributor");
    db.close();
  });

  test("fails on duplicate name", async () => {
    await userCommand("add", { name: "dupuser", project: "cpv" });
    try {
      await userCommand("add", { name: "dupuser", project: "cpv" });
      expect.unreachable("Should have thrown on duplicate");
    } catch (e: any) {
      expect(e.message).toContain("EXIT:1");
    }
  });

  test("fails without --project", async () => {
    try {
      await userCommand("add", { name: "noproj" });
      expect.unreachable("Should have thrown on missing project");
    } catch (e: any) {
      expect(e.message).toContain("EXIT:1");
    }
  });

  test("fails without --name", async () => {
    try {
      await userCommand("add", { project: "cpv" });
      expect.unreachable("Should have thrown on missing name");
    } catch (e: any) {
      expect(e.message).toContain("EXIT:1");
    }
  });

  test("fails with invalid role", async () => {
    try {
      await userCommand("add", { name: "badrole", project: "cpv", role: "superadmin" });
      expect.unreachable("Should have thrown on invalid role");
    } catch (e: any) {
      expect(e.message).toContain("EXIT:1");
    }
  });
});

describe("user list", () => {
  test("lists all users without throwing", async () => {
    await userCommand("add", { name: "listuser1", project: "cpv" });
    await userCommand("add", { name: "listuser2", project: "other" });

    // Should not throw
    await userCommand("list", {});

    const db = newAuthDB();
    const users = await db.getAllUsers();
    expect(users.length).toBeGreaterThanOrEqual(2);
    const names = users.map((u: any) => u.name);
    expect(names).toContain("listuser1");
    expect(names).toContain("listuser2");
    db.close();
  });

  test("filters by project", async () => {
    // Should not throw with project filter
    await userCommand("list", { project: "cpv" });

    const db = newAuthDB();
    const users = await db.getAllUsers();
    // Both users from previous test should exist; filtering is console-only
    expect(users.length).toBeGreaterThanOrEqual(2);
    db.close();
  });

  test("handles empty user list", async () => {
    // Fresh DB scenario: after removing all, list should not throw
    const db = newAuthDB();
    const allUsers = await db.getAllUsers();
    for (const u of allUsers) {
      await db.removeUser(u.id);
    }
    db.close();

    await userCommand("list", {});
  });
});

describe("user remove", () => {
  test("removes an existing user", async () => {
    await userCommand("add", { name: "rmuser", project: "cpv" });
    await userCommand("remove", { name: "rmuser" });

    const db = newAuthDB();
    const user = await db.getUserByName("rmuser");
    expect(user).toBeNull();
    db.close();
  });

  test("fails on nonexistent user", async () => {
    try {
      await userCommand("remove", { name: "ghost" });
      expect.unreachable("Should have thrown on nonexistent user");
    } catch (e: any) {
      expect(e.message).toContain("EXIT:1");
    }
  });

  test("fails without --name", async () => {
    try {
      await userCommand("remove", {});
      expect.unreachable("Should have thrown on missing name");
    } catch (e: any) {
      expect(e.message).toContain("EXIT:1");
    }
  });
});

describe("user token", () => {
  test("generates a token for a user", async () => {
    await userCommand("add", { name: "tokuser", project: "cpv" });
    await userCommand("token", { name: "tokuser" });

    const db = newAuthDB();
    const user = await db.getUserByName("tokuser");
    expect(user).not.toBeNull();
    const tokens = await db.listUserTokens(user.id);
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    expect(tokens[0].revoked).toBe(false);
    expect(tokens[0].token).toMatch(/^mb_[0-9a-f]{32}$/);
    db.close();
  });

  test("generates a token with a label", async () => {
    await userCommand("add", { name: "labeluser", project: "cpv" });
    await userCommand("token", { name: "labeluser", label: "Laptop" });

    const db = newAuthDB();
    const user = await db.getUserByName("labeluser");
    const tokens = await db.listUserTokens(user.id);
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    expect(tokens[0].label).toBe("Laptop");
    db.close();
  });

  test("revokes a token by ID", async () => {
    await userCommand("add", { name: "revuser", project: "cpv" });
    // Generate a token first
    await userCommand("token", { name: "revuser" });

    const db = newAuthDB();
    const user = await db.getUserByName("revuser");
    const tokens = await db.listUserTokens(user.id);
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    const tokenId = tokens[0].id;
    db.close();

    // Revoke using the runtime option name (revoke, not tokenId)
    await (userCommand as Function)("token", { revoke: tokenId });

    const db2 = newAuthDB();
    const tokens2 = await db2.listUserTokens(user.id);
    expect(tokens2.length).toBeGreaterThanOrEqual(1);
    expect(tokens2[0].revoked).toBe(true);
    db2.close();
  });

  test("revoke fails on nonexistent token", async () => {
    try {
      await (userCommand as Function)("token", { revoke: "nonexistent-token-id" });
      expect.unreachable("Should have thrown on nonexistent token");
    } catch (e: any) {
      expect(e.message).toContain("EXIT:1");
    }
  });

  test("token creation fails on nonexistent user", async () => {
    try {
      await userCommand("token", { name: "ghost" });
      expect.unreachable("Should have thrown on nonexistent user");
    } catch (e: any) {
      expect(e.message).toContain("EXIT:1");
    }
  });

  test("token creation fails without --name or --revoke", async () => {
    try {
      await userCommand("token", {});
      expect.unreachable("Should have thrown on missing name");
    } catch (e: any) {
      expect(e.message).toContain("EXIT:1");
    }
  });
});

describe("user set-role", () => {
  test("updates role for an existing project", async () => {
    await userCommand("add", { name: "roleup", project: "cpv", role: "contributor" });
    await userCommand("set-role", { name: "roleup", project: "cpv", role: "admin" });

    const db = newAuthDB();
    const user = await db.getUserByName("roleup");
    expect(user).not.toBeNull();
    expect(user.permissions[0].project).toBe("cpv");
    expect(user.permissions[0].role).toBe("admin");
    db.close();
  });

  test("adds new project permission via set-role", async () => {
    await userCommand("add", { name: "newproj", project: "cpv", role: "contributor" });
    await userCommand("set-role", { name: "newproj", project: "otherproj", role: "observer" });

    const db = newAuthDB();
    const user = await db.getUserByName("newproj");
    expect(user).not.toBeNull();
    expect(user.permissions).toHaveLength(2);
    const otherPerm = user.permissions.find((p: any) => p.project === "otherproj");
    expect(otherPerm).not.toBeUndefined();
    expect(otherPerm.role).toBe("observer");
    db.close();
  });

  test("fails without --name", async () => {
    try {
      await userCommand("set-role", { project: "cpv", role: "admin" });
      expect.unreachable("Should have thrown on missing name");
    } catch (e: any) {
      expect(e.message).toContain("EXIT:1");
    }
  });

  test("fails without --project", async () => {
    try {
      await userCommand("set-role", { name: "test", role: "admin" });
      expect.unreachable("Should have thrown on missing project");
    } catch (e: any) {
      expect(e.message).toContain("EXIT:1");
    }
  });

  test("fails without --role", async () => {
    try {
      await userCommand("set-role", { name: "test", project: "cpv" });
      expect.unreachable("Should have thrown on missing role");
    } catch (e: any) {
      expect(e.message).toContain("EXIT:1");
    }
  });

  test("fails with invalid role value", async () => {
    try {
      await userCommand("set-role", { name: "test", project: "cpv", role: "bogus" });
      expect.unreachable("Should have thrown on invalid role");
    } catch (e: any) {
      expect(e.message).toContain("EXIT:1");
    }
  });

  test("fails on nonexistent user", async () => {
    try {
      await userCommand("set-role", { name: "ghost", project: "cpv", role: "admin" });
      expect.unreachable("Should have thrown on nonexistent user");
    } catch (e: any) {
      expect(e.message).toContain("EXIT:1");
    }
  });
});

describe("user invalid action", () => {
  test("unknown action triggers exit", async () => {
    try {
      await userCommand("bogus-action", {});
      expect.unreachable("Should have thrown on unknown action");
    } catch (e: any) {
      expect(e.message).toContain("EXIT:1");
    }
  });
});

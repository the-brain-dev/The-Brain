/**
 * init command tests — validates --team flag and backward compat.
 * Uses dynamic imports to set process.env.HOME before module constants resolve.
 */
import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdir, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AuthDB, UserRole } from "@the-brain/core";

let initCommand: any;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = join(tmpdir(), `the-brain-init-test-${Date.now()}`);
  await mkdir(join(tmpDir, ".the-brain"), { recursive: true });
  await mkdir(join(tmpDir, ".the-brain", "logs"), { recursive: true });

  // Dynamic import after HOME override
  process.env.HOME = tmpDir;
  const mod = await import("../init");
  initCommand = mod.initCommand;
});

afterEach(async () => {
  // Clean state between tests
  await rm(join(tmpDir, ".the-brain"), { recursive: true, force: true });
  await mkdir(join(tmpDir, ".the-brain"), { recursive: true });
  await mkdir(join(tmpDir, ".the-brain", "logs"), { recursive: true });
});

describe("init --team", () => {
  test("creates auth.db with admin user", async () => {
    process.env.HOME = tmpDir;
    await initCommand({ team: true, force: true });

    // Check auth.db exists and has content
    const authDbPath = join(tmpDir, ".the-brain", "auth.db");
    const exists = await Bun.file(authDbPath).exists();
    expect(exists).toBe(true);

    // Read directly via AuthDB
    const authDB = new AuthDB(authDbPath);
    const allUsers = await authDB.getAllUsers();
    expect(allUsers.length).toBe(1);
    expect(allUsers[0].name).toBe("admin");
    expect(allUsers[0].role).toBe(UserRole.ADMIN);

    // Verify admin has a token
    const tokens = await authDB.listUserTokens(allUsers[0].id);
    expect(tokens.length).toBe(1);
    expect(tokens[0].token.startsWith("mb_")).toBe(true);

    authDB.close();
  });

  test("sets server.mode to team in config.json", async () => {
    process.env.HOME = tmpDir;
    await initCommand({ team: true, force: true });

    const raw = await readFile(join(tmpDir, ".the-brain", "config.json"), "utf-8");
    const config = JSON.parse(raw);

    expect(config.server.mode).toBe("team");
    expect(config.server.bindAddress).toBe("0.0.0.0");
    expect(config.server.authToken).toBeUndefined(); // team mode uses per-user tokens
  });

  test("creates project + team config together", async () => {
    process.env.HOME = tmpDir;
    await initCommand({ team: true, project: "testproj", force: true });

    const raw = await readFile(join(tmpDir, ".the-brain", "config.json"), "utf-8");
    const config = JSON.parse(raw);

    expect(config.server.mode).toBe("team");
    expect(config.activeContext).toBe("testproj");
    expect(config.contexts.testproj).toBeDefined();
    expect(config.contexts.testproj.name).toBe("testproj");
  });

  test("remote mode does NOT create auth.db (backward compat)", async () => {
    process.env.HOME = tmpDir;
    await initCommand({ remote: true, force: true });

    const authDbPath = join(tmpDir, ".the-brain", "auth.db");
    await expect(access(authDbPath)).rejects.toThrow();

    const raw = await readFile(join(tmpDir, ".the-brain", "config.json"), "utf-8");
    const config = JSON.parse(raw);
    expect(config.server.mode).toBe("remote");
    expect(config.server.authToken).toBeDefined();
  });

  test("remote mode authToken starts with mb_", async () => {
    process.env.HOME = tmpDir;
    await initCommand({ remote: true, force: true });

    const raw = await readFile(join(tmpDir, ".the-brain", "config.json"), "utf-8");
    const config = JSON.parse(raw);
    expect(config.server.authToken.startsWith("mb_")).toBe(true);
  });

  test("local mode (default) has no auth", async () => {
    process.env.HOME = tmpDir;
    await initCommand({ force: true });

    const raw = await readFile(join(tmpDir, ".the-brain", "config.json"), "utf-8");
    const config = JSON.parse(raw);
    expect(config.server.mode).toBe("local");
    expect(config.server.authToken).toBeUndefined();
  });
});

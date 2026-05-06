/**
 * user command — Manage multi-user authentication (team mode).
 *
 * Usage:
 *   the-brain user add --name <name> --project <project> [--role admin|contributor|observer]
 *   the-brain user list [--project <project>]
 *   the-brain user remove --name <name>
 *   the-brain user token --name <name> [--label <label>]
 *   the-brain user token --revoke <token-id>
 *   the-brain user set-role --name <name> --project <project> --role <role>
 */
import { join } from "node:path";
import { readFile, access } from "node:fs/promises";
import { AuthDB, UserRole, safeParseConfig } from "@the-brain/core";
import type { TheBrainConfig } from "@the-brain/core";

const CONFIG_PATH = join(process.env.HOME || "~", ".the-brain", "config.json");
const AUTH_DB_PATH = join(process.env.HOME || "~", ".the-brain", "auth.db");

const VALID_ROLES = [UserRole.ADMIN, UserRole.CONTRIBUTOR, UserRole.OBSERVER] as const;

export async function userCommand(
  action: string,
  options: {
    name?: string;
    project?: string;
    role?: string;
    label?: string;
    tokenId?: string;
  }
): Promise<void> {
  const config = await loadConfigSafe();
  const authDB = new AuthDB(AUTH_DB_PATH);

  try {
    switch (action) {
      case "add":
        await handleAdd(authDB, options);
        break;
      case "list":
        await handleList(authDB, options);
        break;
      case "remove":
        await handleRemove(authDB, options);
        break;
      case "token":
        await handleToken(authDB, options);
        break;
      case "set-role":
        await handleSetRole(authDB, options);
        break;
      default:
        console.error(`Unknown action: ${action}`);
        console.error("Usage: the-brain user <add|list|remove|token|set-role> [options]");
        process.exit(1);
    }
  } finally {
    authDB.close();
  }
}

// ── Load config (soft — don't exit if missing) ───────────────────

async function loadConfigSafe(): Promise<TheBrainConfig | null> {
  try {
    await access(CONFIG_PATH);
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const result = safeParseConfig(JSON.parse(raw));
    if (!result.success) return null;
    return result.data;
  } catch (err) {
    console.error("[UserCmd] Failed to load config:", err);
    return null;
  }
}

// ── Handlers ─────────────────────────────────────────────────────

async function handleAdd(
  authDB: AuthDB,
  options: { name?: string; project?: string; role?: string }
): Promise<void> {
  if (!options.name) {
    console.error("Error: --name is required for 'user add'");
    process.exit(1);
  }
  if (!options.project) {
    console.error("Error: --project is required for 'user add'");
    process.exit(1);
  }

  // Validate role
  let role: UserRole = UserRole.CONTRIBUTOR;
  if (options.role) {
    if (!VALID_ROLES.includes(options.role as UserRole)) {
      console.error(`Error: Invalid role "${options.role}". Must be: ${VALID_ROLES.join(", ")}`);
      process.exit(1);
    }
    role = options.role as UserRole;
  }

  // Check for duplicate
  const existing = await authDB.getUserByName(options.name);
  if (existing) {
    console.error(`Error: User "${options.name}" already exists (id: ${existing.id})`);
    process.exit(1);
  }

  const permissions = [{ project: options.project, role }];
  const user = await authDB.createUser(options.name, undefined, role, permissions);

  console.log(`\nUser created:`);
  console.log(`  ID:       ${user.id}`);
  console.log(`  Name:     ${user.name}`);
  console.log(`  Role:     ${user.role}`);
  console.log(`  Projects: ${user.permissions.map((p) => `${p.project} (${p.role})`).join(", ")}`);
  console.log();
}

async function handleList(
  authDB: AuthDB,
  options: { project?: string }
): Promise<void> {
  const users = await authDB.getAllUsers();

  if (users.length === 0) {
    console.log("No users found.");
    return;
  }

  console.log("\nUsers:");
  console.log("──────");
  for (const user of users) {
    const active = user.lastActive ? new Date(user.lastActive).toISOString().slice(0, 10) : "never";
    const perms = user.permissions.map((p) => `${p.project}:${p.role}`).join(", ") || "(none)";

    // Filter by project if specified
    if (options.project) {
      const hasProject = user.permissions.some((p) => p.project === options.project);
      if (!hasProject && user.role !== UserRole.ADMIN) continue;
    }

    console.log(`  ${user.name}`);
    console.log(`    ID:      ${user.id}`);
    console.log(`    Role:    ${user.role}`);
    console.log(`    Perms:   ${perms}`);
    console.log(`    Active:  ${active}`);
    console.log();
  }
}

async function handleRemove(
  authDB: AuthDB,
  options: { name?: string }
): Promise<void> {
  if (!options.name) {
    console.error("Error: --name is required for 'user remove'");
    process.exit(1);
  }

  const user = await authDB.getUserByName(options.name);
  if (!user) {
    console.error(`Error: User "${options.name}" not found`);
    process.exit(1);
  }

  const removed = await authDB.removeUser(user.id);
  if (removed) {
    console.log(`User "${options.name}" removed.`);
  } else {
    console.error(`Error: Failed to remove user "${options.name}"`);
    process.exit(1);
  }
}

async function handleToken(
  authDB: AuthDB,
  options: { name?: string; label?: string; revoke?: string }
): Promise<void> {
  // ── Revoke path: --revoke <token-id> ──
  if (options.revoke) {
    const revoked = await authDB.revokeToken(options.revoke);
    if (revoked) {
      console.log(`Token ${options.revoke} revoked.`);
    } else {
      console.error(`Error: Token ${options.revoke} not found or already revoked`);
      process.exit(1);
    }
    return;
  }

  // ── Create path: --name <name> ──
  if (!options.name) {
    console.error("Error: --name is required for 'user token' (or use --revoke <token-id>)");
    process.exit(1);
  }

  const user = await authDB.getUserByName(options.name);
  if (!user) {
    console.error(`Error: User "${options.name}" not found`);
    process.exit(1);
  }

  const token = await authDB.createToken(user.id, options.label);

  console.log("\nToken created:");
  console.log(`  ID:      ${token.id}`);
  console.log(`  User:    ${user.name}`);
  console.log(`  Label:   ${token.label ?? "(none)"}`);
  console.log(`  Token:   ${token.token}`);
  console.log("\n  Save this token — it won't be shown again.");
  console.log(`  Use: Authorization: Bearer ${token.token}`);
  console.log();
}

async function handleSetRole(
  authDB: AuthDB,
  options: { name?: string; project?: string; role?: string }
): Promise<void> {
  if (!options.name) {
    console.error("Error: --name is required for 'user set-role'");
    process.exit(1);
  }
  if (!options.project) {
    console.error("Error: --project is required for 'user set-role'");
    process.exit(1);
  }
  if (!options.role) {
    console.error("Error: --role is required for 'user set-role'");
    process.exit(1);
  }
  if (!VALID_ROLES.includes(options.role as UserRole)) {
    console.error(`Error: Invalid role "${options.role}". Must be: ${VALID_ROLES.join(", ")}`);
    process.exit(1);
  }

  const user = await authDB.getUserByName(options.name);
  if (!user) {
    console.error(`Error: User "${options.name}" not found`);
    process.exit(1);
  }

  const newRole = options.role as UserRole;

  // Update permissions: replace existing project entry or add new one
  const existingPerms = [...user.permissions];
  const existingIdx = existingPerms.findIndex((p) => p.project === options.project);
  if (existingIdx >= 0) {
    existingPerms[existingIdx] = { project: options.project!, role: newRole };
  } else {
    existingPerms.push({ project: options.project!, role: newRole });
  }

  const updated = await authDB.updateUserPermissions(user.id, { permissions: existingPerms });
  if (!updated) {
    console.error(`Error: Failed to update user "${options.name}"`);
    process.exit(1);
  }

  console.log(`\nUser "${options.name}" role updated:`);
  console.log(`  Project: ${options.project} → ${newRole}`);
  console.log(`  All perms: ${updated.permissions.map((p) => `${p.project}:${p.role}`).join(", ")}`);
  console.log();
}

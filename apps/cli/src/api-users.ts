/**
 * User management API routes for the the-brain daemon HTTP server.
 *
 * Registers endpoints under /api/users* and /api/audit-log*.
 * All endpoints require admin authentication via Bearer token.
 *
 * Usage:
 *   import { registerUserRoutes } from "./api-users";
 *   registerUserRoutes(server, authDB);
 */
import type { AuthDB } from "@the-brain/core";
import { UserRole } from "@the-brain/core";

// ── Helpers ──────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function errorResponse(message: string, status: number, detail?: string): Response {
  return json({ status: "error", error: message, ...(detail ? { detail } : {}) }, status);
}

function okResponse(data: Record<string, unknown> = {}): Response {
  return json({ status: "ok", ...data });
}

// ── Auth Helper ──────────────────────────────────────────────────

async function requireAdmin(req: Request, authDB: AuthDB): Promise<Response | null> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return errorResponse("Unauthorized — missing or invalid Authorization header", 401);
  }

  const token = authHeader.slice(7);
  const result = await authDB.validateToken(token);
  if (!result) {
    return errorResponse("Unauthorized — invalid or revoked token", 401);
  }

  if (result.user.role !== UserRole.ADMIN) {
    return errorResponse("Forbidden — admin access required", 403);
  }

  return null; // null means "authorized, proceed"
}

// ── Route Parser ─────────────────────────────────────────────────

interface ParsedRoute {
  type:
    | "create-user"       // POST /api/users
    | "list-users"        // GET  /api/users
    | "delete-user"       // DELETE /api/users/:id
    | "create-token"      // POST /api/users/:id/tokens
    | "list-tokens"       // GET  /api/users/:id/tokens
    | "revoke-token"      // DELETE /api/users/:id/tokens/:tid
    | "audit-log";        // GET  /api/audit-log
  userId?: string;
  tokenId?: string;
}

function parseRoute(method: string, path: string): ParsedRoute | null {
  // POST /api/users
  if (method === "POST" && path === "/api/users") {
    return { type: "create-user" };
  }

  // GET /api/users
  if (method === "GET" && path === "/api/users") {
    return { type: "list-users" };
  }

  // DELETE /api/users/:id
  const deleteUserMatch = path.match(/^\/api\/users\/([^/]+)$/);
  if (method === "DELETE" && deleteUserMatch) {
    return { type: "delete-user", userId: deleteUserMatch[1] };
  }

  // POST /api/users/:id/tokens
  const createTokenMatch = path.match(/^\/api\/users\/([^/]+)\/tokens$/);
  if (method === "POST" && createTokenMatch) {
    return { type: "create-token", userId: createTokenMatch[1] };
  }

  // GET /api/users/:id/tokens
  if (method === "GET" && createTokenMatch) {
    return { type: "list-tokens", userId: createTokenMatch[1] };
  }

  // DELETE /api/users/:id/tokens/:tid
  const revokeTokenMatch = path.match(/^\/api\/users\/([^/]+)\/tokens\/([^/]+)$/);
  if (method === "DELETE" && revokeTokenMatch) {
    return { type: "revoke-token", userId: revokeTokenMatch[1], tokenId: revokeTokenMatch[2] };
  }

  // GET /api/audit-log
  if (method === "GET" && path === "/api/audit-log") {
    return { type: "audit-log" };
  }

  return null;
}

// ── Route Handler ────────────────────────────────────────────────

async function handleUserRoute(req: Request, authDB: AuthDB): Promise<Response> {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  const url = new URL(req.url);
  const route = parseRoute(req.method, url.pathname);

  if (!route) {
    return errorResponse("Not found", 404);
  }

  // Auth check — all user management endpoints require admin
  const authError = await requireAdmin(req, authDB);
  if (authError) return authError;

  switch (route.type) {
    case "create-user":
      return handleCreateUser(req, authDB);
    case "list-users":
      return handleListUsers(authDB);
    case "delete-user":
      return handleDeleteUser(route.userId!, authDB);
    case "create-token":
      return handleCreateToken(route.userId!, req, authDB);
    case "list-tokens":
      return handleListTokens(route.userId!, authDB);
    case "revoke-token":
      return handleRevokeToken(route.userId!, route.tokenId!, authDB);
    case "audit-log":
      return handleAuditLog(req, authDB);
    default:
      return errorResponse("Not found", 404);
  }
}

// ── Individual Handlers ──────────────────────────────────────────

async function handleCreateUser(req: Request, authDB: AuthDB): Promise<Response> {
  try {
    const body = await req.json() as {
      name?: string;
      displayName?: string;
      role?: string;
      permissions?: Array<{ project: string; role: string }>;
    };

    if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
      return errorResponse("Missing required field: name (non-empty string)", 400);
    }

    // Validate role if provided
    let role: UserRole = UserRole.CONTRIBUTOR;
    if (body.role) {
      if (!Object.values(UserRole).includes(body.role as UserRole)) {
        return errorResponse(
          `Invalid role: ${body.role}. Must be one of: ${Object.values(UserRole).join(", ")}`,
          400,
        );
      }
      role = body.role as UserRole;
    }

    // Validate permissions if provided
    const permissions: Array<{ project: string; role: UserRole }> = [];
    if (body.permissions && Array.isArray(body.permissions)) {
      for (const p of body.permissions) {
        if (!p.project || typeof p.project !== "string") {
          return errorResponse("Each permission entry must have a 'project' string", 400);
        }
        if (!Object.values(UserRole).includes(p.role as UserRole)) {
          return errorResponse(
            `Invalid role in permissions: ${p.role}. Must be one of: ${Object.values(UserRole).join(", ")}`,
            400,
          );
        }
        permissions.push({ project: p.project, role: p.role as UserRole });
      }
    }

    const user = await authDB.createUser(body.name.trim(), body.displayName, role, permissions);

    return okResponse({ user }, 201);
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
      return errorResponse("User with this name already exists", 409);
    }
    return errorResponse("Failed to create user", 500, String(err));
  }
}

async function handleListUsers(authDB: AuthDB): Promise<Response> {
  try {
    const users = await authDB.getAllUsers();
    return okResponse({ users });
  } catch (err) {
    return errorResponse("Failed to list users", 500, String(err));
  }
}

async function handleDeleteUser(userId: string, authDB: AuthDB): Promise<Response> {
  try {
    const removed = await authDB.removeUser(userId);
    if (!removed) {
      return errorResponse("User not found", 404);
    }
    return okResponse({ removed: true, userId });
  } catch (err) {
    return errorResponse("Failed to remove user", 500, String(err));
  }
}

async function handleCreateToken(userId: string, req: Request, authDB: AuthDB): Promise<Response> {
  try {
    // Verify user exists
    const user = await authDB.getUser(userId);
    if (!user) {
      return errorResponse("User not found", 404);
    }

    let label: string | undefined;
    if (req.headers.get("content-type")?.includes("application/json")) {
      try {
        const body = await req.json() as { label?: string };
        label = body.label;
      } catch {
        // Body might be empty or not JSON — that's fine
      }
    }

    const token = await authDB.createToken(userId, label);

    return okResponse({ token }, 201);
  } catch (err) {
    return errorResponse("Failed to create token", 500, String(err));
  }
}

async function handleListTokens(userId: string, authDB: AuthDB): Promise<Response> {
  try {
    // Verify user exists
    const user = await authDB.getUser(userId);
    if (!user) {
      return errorResponse("User not found", 404);
    }

    const tokens = await authDB.listUserTokens(userId);
    return okResponse({ tokens });
  } catch (err) {
    return errorResponse("Failed to list tokens", 500, String(err));
  }
}

async function handleRevokeToken(userId: string, tokenId: string, authDB: AuthDB): Promise<Response> {
  try {
    // Verify user exists
    const user = await authDB.getUser(userId);
    if (!user) {
      return errorResponse("User not found", 404);
    }

    // Verify token belongs to this user
    const tokens = await authDB.listUserTokens(userId);
    const token = tokens.find((t) => t.id === tokenId);
    if (!token) {
      return errorResponse("Token not found for this user", 404);
    }

    const revoked = await authDB.revokeToken(tokenId);
    if (!revoked) {
      return errorResponse("Failed to revoke token", 500);
    }

    return okResponse({ revoked: true, tokenId, userId });
  } catch (err) {
    return errorResponse("Failed to revoke token", 500, String(err));
  }
}

async function handleAuditLog(req: Request, authDB: AuthDB): Promise<Response> {
  try {
    const url = new URL(req.url);
    const userId = url.searchParams.get("userId") ?? undefined;
    const project = url.searchParams.get("project") ?? undefined;
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 100, 1), 500) : 100;

    const entries = await authDB.getAuditLog(userId, project, limit);

    return okResponse({ entries, count: entries.length });
  } catch (err) {
    return errorResponse("Failed to query audit log", 500, String(err));
  }
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Registers user management routes on an existing Bun HTTP server.
 * Wraps the server's fetch handler to intercept /api/users* and /api/audit-log*
 * paths, forwarding all other requests to the original handler.
 */
export function registerUserRoutes(
  server: ReturnType<typeof Bun.serve>,
  authDB: AuthDB,
): void {
  const originalFetch = server.fetch;

  // Overwrite the fetch handler to intercept user routes
  (server as unknown as { fetch: (req: Request) => Promise<Response> }).fetch = async (
    req: Request,
  ): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;

    // Intercept /api/users* and /api/audit-log*
    if (
      path.startsWith("/api/users") ||
      path.startsWith("/api/audit-log")
    ) {
      return handleUserRoute(req, authDB);
    }

    // Fall through to original handler
    return originalFetch(req);
  };
}

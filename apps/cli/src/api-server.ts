/**
 * Micro HTTP API server for the the-brain daemon.
 * Serves on localhost:9420 — consumed by the menu bar app.
 *
 * Endpoints:
 *   GET  /api/health      → daemon status, uptime, active project
 *   GET  /api/stats       → memory counts, graph nodes, last events
 *   POST /api/consolidate → trigger force consolidation
 *   POST /api/train       → trigger LoRA training
 */
import type { DaemonEngine } from "./engine";
import { MemoryLayer, HookEvent, AuthDB } from "@the-brain-dev/core";
import { registerUserRoutes } from "./api-users";
import { readFileSync, existsSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join as pathJoin, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync, execSync } from "node:child_process";

const PORT = 9420;

export interface APIState {
  startTime: number;
  lastTraining: number | null;
  lastTrainingDuration: number | null;
  lastTrainingLoss: number | null;
  lastConsolidationAt: number | null;
}

export interface ServerConfig {
  mode: "local" | "remote" | "team";
  bindAddress: string;
  authToken?: string;
  port?: number;
}

export function startAPIServer(engine: DaemonEngine, state: APIState, serverCfg?: ServerConfig) {
  const cfg: ServerConfig = serverCfg ?? { mode: "local", bindAddress: "127.0.0.1" };
  const isRemote = cfg.mode === "remote";
  const isTeamMode = cfg.mode === "team";
  const actualPort = cfg.port ?? 9420;

  // ── Team mode: initialize auth database ──────────
  let authDB: AuthDB | null = null;
  if (isTeamMode) {
    const authDbPath = join(homedir(), ".the-brain", "auth.db");
    if (existsSync(authDbPath)) {
      authDB = new AuthDB(authDbPath);
      console.log("Auth: team mode — per-user token validation enabled");
    } else {
      console.warn("Auth: team mode enabled but auth.db not found — run 'the-brain init --team'");
    }
  }

  const ingestedHashes = new Set<string>();
  const ingestedHashesOrder: string[] = []; // LRU tracking
  const MAX_INGESTED_HASHES = 1000; // Prevent unbounded memory growth

  // ── Local auth token ──────────────────────────────
  // Generate a random token for local API access (defense-in-depth against browser attacks)
  const apiTokenPath = join(homedir(), ".the-brain", ".api-token");
  let localAuthToken: string;
  try {
    if (existsSync(apiTokenPath)) {
      localAuthToken = readFileSync(apiTokenPath, "utf-8").trim();
    } else {
      localAuthToken = randomUUID();
      writeFileSync(apiTokenPath, localAuthToken, { mode: 0o600 });
      console.log(`[API] Generated local auth token: ${apiTokenPath}`);
    }
  } catch {
    localAuthToken = randomUUID();
    console.warn("[API] Could not persist local auth token; using ephemeral token");
  }

  // Allowed roots for file ingest (realpath-canonicalized)
  const allowedIngestRoots: string[] = (() => {
    const home = homedir();
    const roots = [home];
    try {
      const configPath = join(home, ".the-brain", "config.json");
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        if (config.database?.path) roots.push(resolve(config.database.path, ".."));
        if (config.wiki?.outputDir) roots.push(resolve(config.wiki.outputDir));
        if (config.daemon?.logDir) roots.push(resolve(config.daemon.logDir));
        if (config.contexts) {
          for (const ctx of Object.values(config.contexts)) {
            roots.push(resolve(ctx.dbPath, ".."));
            roots.push(resolve(ctx.wikiDir));
          }
        }
      }
    } catch {}
    // Deduplicate and resolve all to canonical paths
    const canonical = new Set<string>();
    for (const r of roots) {
      try { canonical.add(realpathSync(r)); } catch { canonical.add(resolve(r)); }
    }
    console.log(`[API] Allowed ingest roots: ${[...canonical].join(", ")}`);
    return [...canonical];
  })();

  let server: ReturnType<typeof Bun.serve>;
  const serverOptions = {
    port: actualPort,
    hostname: cfg.bindAddress,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      // ── Auth check ─────────────────────────────────
      let resolvedUserId: string | null = null;

      if (isRemote && cfg.authToken) {
        // Remote mode: single shared token
        if (path !== "/api/health") {
          const auth = req.headers.get("authorization");
          const expected = `Bearer ${cfg.authToken}`;
          if (auth !== expected) {
            return new Response(
              JSON.stringify({ error: "Unauthorized", hint: "Pass Authorization: Bearer <token>" }),
              { status: 401, headers: { "Content-Type": "application/json", ...getCorsHeaders(req) } }
            );
          }
        }
      } else if (isTeamMode && authDB) {
        // Team mode: per-user tokens
        if (path !== "/api/health") {
          const auth = req.headers.get("authorization");
          if (!auth || !auth.startsWith("Bearer ")) {
            return new Response(
              JSON.stringify({ error: "Unauthorized", hint: "Pass Authorization: Bearer <user-token>" }),
              { status: 401, headers: { "Content-Type": "application/json", ...getCorsHeaders(req) } }
            );
          }
          const token = auth.slice(7);
          const result = await authDB.validateToken(token);
          if (!result) {
            return new Response(
              JSON.stringify({ error: "Unauthorized — invalid or revoked token" }),
              { status: 401, headers: { "Content-Type": "application/json", ...getCorsHeaders(req) } }
            );
          }
          resolvedUserId = result.user.id;
        }
      }

      // ── CORS per-request ──
      const corsHeaders = getCorsHeaders(req);

      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      try {
        // ── Health ───────────────────────────────────────
        if (path === "/api/health" && method === "GET") {
          const uptime = Date.now() - state.startTime;
          return json({
            status: engine.running ? "running" : "stopped",
            pid: process.pid,
            uptime,
            uptimeFormatted: formatUptime(uptime),
            activeProject: engine.activeProject || "global",
            interactionCount: engine.interactionCount,
            mode: cfg.mode,
          }, corsHeaders);
        }

        // ── Stats ────────────────────────────────────────
        if (path === "/api/stats" && method === "GET") {
          try {
            const activeDB = await engine.projectManager.getActiveDB();
            const stats = await activeDB.getStats();

            return json({
              memories: {
                total: stats.memories,
                instant: stats.instantCount ?? 0,
                selection: stats.selectionCount ?? 0,
                deep: stats.deepCount ?? 0,
              },
              graphNodes: stats.graphNodes,
              lastConsolidation: state.lastConsolidationAt,
              lastTraining: state.lastTraining,
              lastTrainingDuration: state.lastTrainingDuration,
              lastTrainingLoss: state.lastTrainingLoss,
              interactionCount: engine.interactionCount,
            }, corsHeaders);
          } catch (err) {
            return json({ error: "Failed to read stats", detail: String(err) }, corsHeaders, 500);
          }
        }

        // ── Consolidate ──────────────────────────────────
        if (path === "/api/consolidate" && method === "POST") {
          try {
            const activeDB = await engine.projectManager.getActiveDB();
            const surprising = await activeDB.getSurprisingMemories(0.3);

            if (surprising.length === 0) {
              return json({ consolidated: false, reason: "No surprising memories", memoriesChecked: 0 }, corsHeaders);
            }

            const ctx = {
              targetLayer: MemoryLayer.DEEP,
              fragments: surprising,
              results: {
                layer: MemoryLayer.DEEP,
                fragmentsPromoted: 0,
                fragmentsDiscarded: 0,
                duration: 0,
              },
            };

            await engine.layerRouter.runDeep(ctx);
            await engine.hooks.callHook("deep:consolidate", ctx);

            state.lastConsolidationAt = Date.now();

            return json({
              consolidated: true,
              memoriesProcessed: surprising.length,
              timestamp: state.lastConsolidationAt,
            }, corsHeaders);
          } catch (err) {
            return json({ error: "Consolidation failed", detail: String(err) }, corsHeaders, 500);
          }
        }

        // ── Train ────────────────────────────────────────
        if (path === "/api/train" && method === "POST") {
          try {
            const startTime = Date.now();
            const activeDB = await engine.projectManager.getActiveDB();
            const deepMemories = await activeDB.getMemoriesByLayer(MemoryLayer.DEEP, 500);

            if (deepMemories.length === 0) {
              return json({ trained: false, reason: "No DEEP memories" }, corsHeaders);
            }

            const fragments = deepMemories.map((m) => ({
              id: m.id,
              layer: MemoryLayer.DEEP,
              content: m.content,
              surpriseScore: m.surpriseScore,
              timestamp: m.timestamp,
              source: m.source,
              metadata: m.metadata,
            }));

            const trainCtx = {
              targetLayer: MemoryLayer.DEEP,
              fragments,
              results: {
                promoted: fragments.length,
                discarded: 0,
                remaining: 0,
                enrichedFragments: fragments,
              },
            };

            await engine.hooks.callHook("training:run", trainCtx);

            const duration = (Date.now() - startTime) / 1000;
            state.lastTraining = Date.now();
            state.lastTrainingDuration = duration;

            return json({
              trained: true,
              fragmentCount: fragments.length,
              duration,
            }, corsHeaders);
          } catch (err) {
            return json({ error: "Training failed", detail: String(err) }, corsHeaders, 500);
          }
        }

        // ── Ingest File (drag & drop) ─────────────────────
        if (path === "/api/ingest-file" && method === "POST") {
          try {
            const body = await req.json() as { path?: string; paths?: string[] };
            const filePaths = body.paths ?? (body.path ? [body.path] : []);

            if (filePaths.length === 0) {
              return json({ error: "No file paths provided" }, corsHeaders, 400);
            }

            const results: Array<{ path: string; ingested: boolean; bytes: number; error?: string }> = [];

            for (const filePath of filePaths) {
              try {
                // Path traversal guard — block '..' and require absolute paths
                if (filePath.includes("..")) {
                  results.push({ path: filePath, ingested: false, bytes: 0, error: "Path traversal blocked — '..' not allowed" });
                  continue;
                }
                if (!existsSync(filePath)) {
                  results.push({ path: filePath, ingested: false, bytes: 0, error: "File not found" });
                  continue;
                }

                // Canonicalize with realpath and check against allowed roots
                let canonicalPath: string;
                try {
                  canonicalPath = realpathSync(filePath);
                } catch {
                  results.push({ path: filePath, ingested: false, bytes: 0, error: "Cannot resolve real path" });
                  continue;
                }

                const isAllowed = allowedIngestRoots.some((root) => canonicalPath.startsWith(root));
                if (!isAllowed) {
                  results.push({
                    path: filePath, ingested: false, bytes: 0,
                    error: `File not in allowed ingest directories. Allowed roots: ${allowedIngestRoots.join(", ")}`,
                  });
                  continue;
                }

                const { statSync } = await import("node:fs");
                const stat = statSync(filePath);
                const ext = basename(filePath).split(".").pop()?.toLowerCase();

                // ── Guards ────────────────────────────────────
                const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

                // Size guard
                if (stat.size > MAX_FILE_SIZE) {
                  const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
                  results.push({
                    path: filePath, ingested: false, bytes: 0,
                    error: `File too large (${sizeMB} MB, max 20 MB)`,
                  });
                  continue;
                }

                // Deduplication guard (SHA256-based, in-memory)
                const fileBytes = readFileSync(filePath);
                const hash = createHash("sha256").update(fileBytes).digest("hex");

                if (ingestedHashes.has(hash)) {
                  results.push({
                    path: filePath, ingested: false, bytes: 0,
                    error: "Already ingested (duplicate content)",
                  });
                  continue;
                }
                ingestedHashes.add(hash);
                // ── End guards ────────────────────────────────

                let content: string;
                let format: string = ext ?? "unknown";

                // ── Convert to markdown via MarkItDown (Python sidecar) ──
                try {
                  const sidecarDir = pathJoin(
                    import.meta.dir,
                    "..", "..", "packages", "python-sidecar",
                  );
                  const convertScript = pathJoin(sidecarDir, "convert_file.py");

                  // Use uv run (consistent with trainer-local-mlx)
                  const result = spawnSync("uv", [
                    "run", "python3", convertScript, "--json", filePath,
                  ], {
                    encoding: "utf-8",
                    timeout: 30000,
                    cwd: sidecarDir,
                  });

                  if (result.error) throw result.error;

                  const parsed = JSON.parse(result.stdout);
                  if (parsed.success) {
                    content = parsed.markdown;
                    format = parsed.meta?.format ?? format;
                  } else {
                    content = `[Could not convert: ${basename(filePath)} — ${parsed.meta?.error ?? "unknown error"}]`;
                  }
                } catch (convErr) {
                  // Fallback: try reading as plain text
                  try {
                    content = readFileSync(filePath, "utf-8");
                  } catch {
                    content = `[Binary file: ${basename(filePath)}, ${stat.size} bytes — conversion failed: ${convErr instanceof Error ? convErr.message : String(convErr)}]`;
                  }
                }

                // ── Feed into pipeline ──────────────────
                const id = `ingest-${Date.now()}-${Buffer.from(filePath).toString("base64").slice(0, 8)}`;

                const interaction = {
                  id,
                  timestamp: Date.now(),
                  prompt: `📄 Ingested file: ${basename(filePath)}`,
                  response: content.slice(0, 5000),
                  source: "drag-drop",
                  metadata: {
                    filePath,
                    fileName: basename(filePath),
                    fileSize: stat.size,
                    fileType: format,
                    convertedWith: "markitdown",
                  },
                };

                const ctx = {
                  interaction,
                  fragments: [{
                    id: `frag-${id}`,
                    layer: MemoryLayer.INSTANT,
                    content: `Prompt: ${interaction.prompt}\nResponse: ${interaction.response.slice(0, 500)}`,
                    timestamp: interaction.timestamp,
                    source: interaction.source,
                    metadata: interaction.metadata,
                  }],
                  promoteToDeep(frag) { engine.hooks.callHook(HookEvent.SELECTION_PROMOTE, frag).catch(() => {}); },
                };

                await engine.hooks.callHook(HookEvent.HARVESTER_NEW_DATA, ctx);
                await engine.hooks.callHook(HookEvent.ON_INTERACTION, ctx);

                results.push({
                  path: filePath,
                  ingested: true,
                  bytes: content.length,
                });
              } catch (err) {
                results.push({
                  path: filePath,
                  ingested: false,
                  bytes: 0,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }

            return json({
              ingested: results.filter(r => r.ingested).length,
              total: results.length,
              results,
            }, corsHeaders);
          } catch (err) {
            return json({ error: "Ingest failed", detail: String(err) }, corsHeaders, 500);
          }
        }

        // ── Ingest Interaction (agent push) ──────────────
        if (path === "/api/ingest-interaction" && method === "POST") {
          try {
            const body = await req.json() as {
              interaction?: { id: string; timestamp: number; prompt: string; response: string; source: string; metadata?: Record<string, unknown> };
            };
            const interaction = body.interaction;
            if (!interaction?.prompt || !interaction?.source) {
              return json({ error: "Missing interaction fields (prompt + source required)" }, corsHeaders, 400);
            }

            const ctx = {
              interaction: {
                id: interaction.id ?? crypto.randomUUID(),
                timestamp: interaction.timestamp ?? Date.now(),
                prompt: interaction.prompt,
                response: interaction.response ?? "",
                source: interaction.source,
                metadata: {
                  ...interaction.metadata,
                  ...(resolvedUserId ? { userId: resolvedUserId } : {}),
                },
              },
              fragments: [{
                id: `frag-${interaction.id ?? crypto.randomUUID()}`,
                layer: MemoryLayer.INSTANT,
                content: `Prompt: ${interaction.prompt}\nResponse: ${(interaction.response ?? "").slice(0, 500)}`,
                timestamp: interaction.timestamp ?? Date.now(),
                source: interaction.source,
                metadata: interaction.metadata,
              }],
              promoteToDeep(frag: any) {
                engine.hooks.callHook(HookEvent.SELECTION_PROMOTE, frag).catch(() => {});
              },
            };

            await engine.hooks.callHook(HookEvent.HARVESTER_NEW_DATA, ctx);
            await engine.hooks.callHook(HookEvent.ON_INTERACTION, ctx);

            return json({ ingested: true, id: ctx.interaction.id }, corsHeaders);
          } catch (err) {
            return json({ error: "Ingest interaction failed", detail: String(err) }, corsHeaders, 500);
          }
        }

        // ── Timeline API ──────────────────────────────────
        if (path === "/api/timeline" && method === "GET") {
          try {
            const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
            const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10), 100);
            const layer = url.searchParams.get("layer") ?? "";
            const source = url.searchParams.get("source") ?? "";
            const activeDB = await engine.projectManager.getActiveDB();

            // Fetch more than needed so we can filter client-side
            const all = await activeDB.getAllMemories(1000);

            // Apply filters server-side
            let filtered = all;
            if (layer && layer !== "all") {
              const memoLayer = parseInt(layer, 10);
              filtered = filtered.filter((m: any) => m.layer === memoLayer);
            }
            if (source && source !== "all") {
              filtered = filtered.filter((m: any) => m.source === source);
            }

            // Sort newest first
            filtered.sort((a: any, b: any) => b.timestamp - a.timestamp);

            const page = filtered.slice(offset, offset + limit);
            const hasMore = offset + limit < filtered.length;

            return json({ memories: page, hasMore, total: filtered.length }, corsHeaders);
          } catch (err) {
            return json({ error: "Timeline fetch failed", detail: String(err) }, corsHeaders, 500);
          }
        }

        // ── Timeline page (static) ────────────────────────
        if (path === "/timeline" && method === "GET") {
          try {
            const htmlPath = pathJoin(import.meta.dir, "timeline.html");
            const html = readFileSync(htmlPath, "utf-8");
            return new Response(html, {
              headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders },
            });
          } catch {
            return new Response("Timeline page not found", { status: 404, headers: corsHeaders });
          }
        }

        // ── 404 ──────────────────────────────────────────
        return json({ error: "Not found" }, corsHeaders, 404);

      } catch (err) {
        return json({ error: "Internal error", detail: String(err) }, corsHeaders, 500);
      }
    },
  };

  // Start server with EADDRINUSE auto-recovery
  try {
    server = Bun.serve(serverOptions);
  } catch (err: any) {
    if (err?.code === "EADDRINUSE") {
      const pid = execSync(`lsof -ti :${actualPort}`, { encoding: "utf-8" }).trim();
      if (pid && pid !== String(process.pid)) {
        console.log(`[API] Port ${actualPort} in use by PID ${pid}, releasing...`);
        execSync(`kill -9 ${pid}`);
        // Wait for OS to release the port (synchronous)
        Bun.sleepSync(1000);
        server = Bun.serve(serverOptions);
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }

  // ── Team mode: register user management API routes ──────────
  if (authDB) {
    registerUserRoutes(server, authDB);
    console.log("Auth: team mode — user management API enabled");
  }

  return server;
}

// ── CORS helper ──────────────────────────────────────────────────

/**
 * Returns CORS headers appropriate for the request origin.
 * - No Origin header (native apps, curl, CLI): allow, echo a safe default
 * - Known local origins (localhost, 127.0.0.1): echo the origin back
 * - Unknown origins: omit CORS headers → browser blocks reading the response
 */
function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  const safeLocal = "http://localhost:9420";

  if (!origin) {
    // Non-browser client — no CORS needed
    return {
      "Access-Control-Allow-Origin": safeLocal,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      Vary: "Origin",
    };
  }

  // Trusted local origins
  const trustedOrigins = [
    "http://localhost",
    "http://127.0.0.1",
    "capacitor://localhost",
    "file://",
    "app://",
  ];

  const isTrusted = trustedOrigins.some((t) => origin.startsWith(t) || origin === t);
  if (isTrusted) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      Vary: "Origin",
    };
  }

  // Unknown origin — no CORS access granted
  return { Vary: "Origin" };
}

// ── Helpers ──────────────────────────────────────────────────────

function json(data: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

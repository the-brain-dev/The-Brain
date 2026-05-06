/**
 * CLI command: the-brain mcp serve
 *
 * Starts the MCP server over stdio or HTTP/SSE transport.
 *
 * Usage:
 *   the-brain mcp serve --transport stdio
 *   the-brain mcp serve --transport sse --port 9422
 */

import type { BrainDB, StorageBackend, SchedulerPlugin } from "@the-brain/core";
import type { TheBrainConfig, ProjectContext } from "@the-brain/core";
import { McpServer, runStdioServer, startSseServer, registerAllTools, registerAllResources, allTools, allResources } from "@the-brain/mcp-server";
import { consola } from "consola";

interface McpServeOptions {
  transport?: string;
  port?: number;
  project?: string;
  global?: boolean;
}

export async function mcpCommand(action: string, options: McpServeOptions): Promise<void> {
  if (action !== "serve") {
    consola.error(`Unknown MCP action: "${action}". Use "the-brain mcp serve".`);
    process.exit(1);
  }

  const transport = options.transport ?? "stdio";
  const log = (...args: unknown[]) => console.error("[the-brain-mcp]", ...args);

  // Build shared context
  const config = await loadConfig();
  const db = await openDatabase(config);
  const storage = createStorageAdapter(db);
  const scheduler = createSchedulerStub();

  const projects = new Map<string, ProjectContext>();
  projects.set("global", {
    name: "global",
    dbPath: config.database?.path ?? "~/.the-brain/global/brain.db",
    wikiDir: "~/.the-brain/global/wiki",
    createdAt: Date.now(),
    lastActive: Date.now(),
  });

  const ctx = {
    db,
    storage,
    scheduler,
    config,
    projects,
    currentProject: options.project ?? "global",
  };

  // Create server and register everything
  const server = new McpServer(ctx, "the-brain", "0.2.0");
  registerAllTools(server);
  registerAllResources(server);

  log(`MCP server ready (${Object.keys(allTools).length} tools, ${Object.keys(allResources).length} resources)`);

  if (transport === "sse") {
    const port = options.port ?? config.server?.mcpPort ?? 9422;
    const host = config.server?.bindAddress ?? "127.0.0.1";
    const bunServer = startSseServer(server, {
      port,
      host,
      authToken: config.server?.authToken,
    });
    log(`SSE transport listening on http://localhost:${port}`);
    log(`  SSE endpoint: http://localhost:${port}/sse`);
    log(`  RPC endpoint: http://localhost:${port}/message?sessionId=<id>`);
    log(`  Health:       http://localhost:${port}/`);

    // Keep alive until SIGTERM
    await new Promise<void>((resolve) => {
      process.on("SIGTERM", () => {
        log("Shutting down SSE server...");
        bunServer.stop();
        resolve();
      });
      process.on("SIGINT", () => {
        log("Shutting down SSE server...");
        bunServer.stop();
        resolve();
      });
    });
  } else {
    log("Waiting for MCP client to connect (stdio)...");
    await runStdioServer(server);
    log("MCP server stopped.");
  }
}

// ── Internal: Load configuration ─────────────────────────────

function getFallbackConfig(): TheBrainConfig {
  const home = process.env.HOME || "/tmp";
  return {
    plugins: [],
    daemon: { pollIntervalMs: 30000, logDir: `${home}/.the-brain/logs` },
    database: { path: `${home}/.the-brain/global/brain.db` },
    mlx: { enabled: false },
    wiki: { enabled: false, outputDir: `${home}/.the-brain/wiki` },
    activeContext: "global",
    contexts: {},
  };
}

async function loadConfig(): Promise<TheBrainConfig> {
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const { readFileSync, existsSync } = await import("node:fs");
  const { safeParseConfig } = await import("@the-brain/core");

  const configPath = join(homedir(), ".the-brain", "config.json");

  if (!existsSync(configPath)) {
    consola.warn("No config.json found. Run `the-brain init` first.");
    return getFallbackConfig();
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const result = safeParseConfig(raw);
    if (!result.success) {
      consola.warn(`Config validation failed: ${result.error}. Using defaults.`);
      return getFallbackConfig();
    }
    return result.data;
  } catch (e) {
    consola.warn("Failed to parse config.json. Using defaults.");
    return getFallbackConfig();
  }
}

// ── Internal: Open database ──────────────────────────────────

async function openDatabase(config: TheBrainConfig): Promise<BrainDB> {
  const { BrainDB } = await import("@the-brain/core");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");

  const dbPath = config.database?.path ?? join(homedir(), ".the-brain", "global", "brain.db");
  return new BrainDB(dbPath);
}

// ── Internal: Storage adapter (delegates to BrainDB) ────────

function createStorageAdapter(db: BrainDB): StorageBackend {
  return {
    init: async () => {},
    createSession: db.createSession.bind(db),
    getSession: async (id) => {
      const s = await db.getSession(id);
      return s as unknown as Record<string, unknown> | undefined;
    },
    getRecentSessions: async (limit) => {
      const s = await db.getRecentSessions(limit);
      return s as unknown as Record<string, unknown>[];
    },
    insertMemory: db.insertMemory.bind(db),
    insertMemories: db.insertMemories.bind(db),
    getMemoriesByLayer: db.getMemoriesByLayer.bind(db),
    getSurprisingMemories: db.getSurprisingMemories.bind(db),
    updateMemory: db.updateMemory.bind(db),
    deleteMemory: db.deleteMemory.bind(db),
    getAllMemories: db.getAllMemories.bind(db),
    getRecentMemories: db.getRecentMemories.bind(db),
    upsertGraphNode: db.upsertGraphNode.bind(db),
    getGraphNode: db.getGraphNode.bind(db),
    getConnectedNodes: db.getConnectedNodes.bind(db),
    getHighWeightNodes: db.getHighWeightNodes.bind(db),
    searchGraphNodes: db.searchGraphNodes.bind(db),
    getStats: db.getStats.bind(db),
    deleteOldMemories: db.deleteOldMemories.bind(db),
    close: db.close.bind(db),
  };
}

// ── Internal: Scheduler stub ─────────────────────────────────

function createSchedulerStub(): SchedulerPlugin {
  const tasks: Array<{ name: string; handle: { id: string; name: string } }> = [];
  return {
    name: "mcp-stub",
    schedule(name: string, _intervalMs: number, _task: () => Promise<void>) {
      const h = { id: `stub-${Date.now()}`, name };
      tasks.push({ name, handle: h });
      return h;
    },
    scheduleOnce(name: string, _delayMs: number, _task: () => Promise<void>) {
      const h = { id: `stub-once-${Date.now()}`, name };
      return h;
    },
    cancel(_handle: { id: string; name: string }) {},
    list() {
      return tasks;
    },
    shutdown: async () => {},
  };
}

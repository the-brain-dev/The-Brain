/**
 * @my-brain/plugin-harvester-cursor
 *
 * Data harvester that polls Cursor IDE's local conversation logs (JSONL and SQLite)
 * and feeds new interactions into the my-brain pipeline.
 *
 * Cursor stores conversation data in several locations:
 *   - SQLite: ~/Library/Application Support/Cursor/User/workspaceStorage/<hash>/state.vscdb
 *   - SQLite: ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 *   - JSONL:  ~/Library/Application Support/Cursor/logs/ (when enabled)
 *   - Raw chat data stored as JSON in SQLite ItemTable under various keys
 *
 * This plugin polls these sources, deduplicates by interaction ID, and feeds
 * new prompt/response pairs into the ON_INTERACTION hook as Interaction records.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type {
  Interaction,
  InteractionContext,
  MemoryFragment,
  PluginHooks,
} from "@my-brain/core";
import { HookEvent, MemoryLayer, definePlugin } from "@my-brain/core";
import type { HarvesterPlugin } from "@my-brain/core";

// ── Types ────────────────────────────────────────────────────────

interface CursorState {
  lastPollTimestamp: number;
  processedIds: Set<string>;
  /** Per-file read offsets for JSONL files */
  fileOffsets: Record<string, number>;
}

interface RawCursorMessage {
  text?: string;
  content?: string;
  role?: "user" | "assistant" | "system";
  type?: string;
  message?: {
    content?: string | { parts?: string[] };
    role?: string;
  };
}

interface CursorChatEntry {
  // Cursor stores chat sessions as JSON blobs
  id?: string;
  sessionId?: string;
  timestamp?: number;
  messages?: RawCursorMessage[];
  request?: { message?: string; messages?: RawCursorMessage[] };
  response?: { message?: string; text?: string };
  title?: string;
  // Less structured blobs
  [key: string]: unknown;
}

interface DiscoveredWorkspace {
  path: string;
  dbPath: string | null;
  logPath: string | null;
  projectFolder?: string;   // Resolved absolute path from workspace.json
  projectName?: string;      // Matched project context name
}

const PLUGIN_NAME = "plugin-harvester-cursor";

// ── Project Detection ────────────────────────────────────────

/**
 * Read workspace.json from a workspace storage folder and extract
 * the project folder path (file:// URI → absolute path).
 */
function detectWorkspaceFolder(wsPath: string): string | null {
  try {
    const workspaceJsonPath = join(wsPath, "workspace.json");
    if (!existsSync(workspaceJsonPath)) return null;
    const raw = readFileSync(workspaceJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as { folder?: string };
    if (!parsed.folder) return null;
    // Convert file:// URI to absolute path
    const uri = parsed.folder;
    if (uri.startsWith("file://")) {
      return decodeURIComponent(uri.slice("file://".length));
    }
    return uri;
  } catch {
    return null;
  }
}

/**
 * Match a workspace folder path against registered project contexts.
 * Returns the project name if the workspace is inside a project's workDir.
 */
function matchProjectFromConfig(
  folderPath: string,
  configDir: string
): string | null {
  try {
    const configPath = join(configDir, "config.json");
    if (!existsSync(configPath)) return null;
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    const contexts = config.contexts || {};
    for (const [name, ctx] of Object.entries(contexts) as [string, any][]) {
      const workDir = ctx.workDir as string | undefined;
      if (workDir && folderPath.startsWith(workDir)) {
        return name;
      }
    }
  } catch {
    // Config missing or corrupt — skip
  }
  return null;
}

function getMyBrainConfigDir(): string {
  return join(homedir(), ".my-brain");
}

// ── Cursor Path Discovery ────────────────────────────────────────

function getCursorBasePath(): string {
  const home = homedir();
  const os = platform();

  if (os === "darwin") {
    return join(home, "Library", "Application Support", "Cursor");
  }
  if (os === "linux") {
    return join(home, ".config", "Cursor");
  }
  if (os === "win32") {
    // Windows: %APPDATA%/Cursor
    return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Cursor");
  }
  return join(home, ".cursor");
}

function discoverWorkspaces(basePath: string): DiscoveredWorkspace[] {
  const workspaces: DiscoveredWorkspace[] = [];
  const configDir = getMyBrainConfigDir();

  // 1. Workspace storage (per-project state.vscdb)
  const wsStorage = join(basePath, "User", "workspaceStorage");
  if (existsSync(wsStorage)) {
    try {
      const entries = readdirSync(wsStorage, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const wsPath = join(wsStorage, entry.name);
        const dbPath = join(wsPath, "state.vscdb");

        // Detect project from workspace.json
        const folderPath = detectWorkspaceFolder(wsPath);
        const projectName = folderPath ? matchProjectFromConfig(folderPath, configDir) : null;

        workspaces.push({
          path: wsPath,
          dbPath: existsSync(dbPath) ? dbPath : null,
          logPath: null,
          projectFolder: folderPath ?? undefined,
          projectName: projectName ?? undefined,
        });
      }
    } catch {
      // Permission errors or missing directory — skip
    }
  }

  // 2. Global storage (cross-workspace state)
  const globalDb = join(basePath, "User", "globalStorage", "state.vscdb");
  if (existsSync(globalDb)) {
    workspaces.push({
      path: join(basePath, "User", "globalStorage"),
      dbPath: globalDb,
      logPath: null,
    });
  }

  // 3. Logs directory (JSONL chat logs if enabled)
  const logsDir = join(basePath, "logs");
  if (existsSync(logsDir)) {
    try {
      const logFiles = readdirSync(logsDir).filter(
        (f) => f.endsWith(".jsonl") || f.endsWith(".json") || f.endsWith(".log")
      );
      for (const logFile of logFiles) {
        // Reuse existing workspaces entry or add a log-only one
        workspaces.push({
          path: logsDir,
          dbPath: null,
          logPath: join(logsDir, logFile),
        });
      }
    } catch {
      // Skip
    }
  }

  return workspaces;
}

// ── SQLite Extraction ────────────────────────────────────────────

/**
 * Query a Cursor state.vscdb for chat-related entries.
 * Cursor stores chat data in the `ItemTable` table with keys like:
 *   - workbench.panel.aichat.view.aichat.chatdata
 *   - cursor.chat.*
 *   - chat.*
 */
function extractFromStateDb(dbPath: string, since: number): Interaction[] {
  const interactions: Interaction[] = [];

  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });

    // Check if ItemTable exists
    const tableCheck = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='ItemTable'")
      .get();
    if (!tableCheck) return interactions;

    // Search for chat-related keys
    const searchPatterns = [
      "%aichat%",
      "%chat%",
      "%cursor.aichat%",
      "%interactive.sessions%",
    ];

    for (const pattern of searchPatterns) {
      try {
        const rows = db
          .query(
            `SELECT key, value FROM ItemTable WHERE key LIKE ?`
          )
          .all(pattern) as { key: string; value: string }[];

        for (const row of rows) {
          try {
            const parsed = JSON.parse(row.value) as CursorChatEntry | CursorChatEntry[];

            // Handle both single object and array
            const entries = Array.isArray(parsed) ? parsed : [parsed];
            for (const entry of entries) {
              const extracted = parseChatEntry(entry, row.key);
              if (extracted && extracted.timestamp > since) {
                interactions.push(extracted);
              }
            }
          } catch {
            // Skip unparseable entries
          }
        }
      } catch {
        // Table might not exist in older versions
      }
    }
  } catch (err) {
    // Database locked or corrupt — skip gracefully
  } finally {
    try {
      db?.close();
    } catch {
      // Best effort
    }
  }

  return interactions;
}

/**
 * Query a Cursor state.vscdb for chat data stored in the cursorDiskKV table
 * (newer Cursor versions store composer/chat data here).
 */
function extractFromCursorDiskKV(dbPath: string, since: number): Interaction[] {
  const interactions: Interaction[] = [];

  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });

    // Check if cursorDiskKV table exists
    const tableCheck = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'")
      .get();
    if (!tableCheck) return interactions;

    // Search for chat/composer-related keys
    const searchPatterns = [
      "chat::%",
      "composer::%",
      "conversation::%",
    ];

    for (const pattern of searchPatterns) {
      try {
        const rows = db
          .query(`SELECT key, value FROM cursorDiskKV WHERE key LIKE ?`)
          .all(pattern) as { key: string; value: string }[];

        for (const row of rows) {
          try {
            // Try to parse as JSON chat entry
            const parsed = JSON.parse(row.value) as CursorChatEntry;
            // Remove key prefix for display
            const keyShort = row.key.split("::").slice(1).join("::");
            const extracted = parseChatEntry(parsed, `kv:${keyShort}`);
            if (extracted && extracted.timestamp > since) {
              interactions.push(extracted);
            }
          } catch {
            // Skip unparseable entries
          }
        }
      } catch {
        // Table might be locked
      }
    }
  } catch {
    // DB error
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }

  return interactions;
}

/**
 * Parse a raw Cursor chat entry into an Interaction.
 */
function parseChatEntry(
  entry: CursorChatEntry,
  sourceKey: string
): Interaction | null {
  // Generate a stable ID from the content
  const contentFingerprint = JSON.stringify({
    messages: entry.messages,
    request: entry.request,
    response: entry.response,
    sessionId: entry.sessionId,
    timestamp: entry.timestamp,
  });

  // Handle various message formats Cursor uses across versions
  let prompt = "";
  let response = "";

  // Format 1: entry.request.message / entry.response.text
  if (entry.request?.message) {
    prompt = String(entry.request.message);
  }
  if (entry.response?.text) {
    response = String(entry.response.text);
  } else if (entry.response?.message) {
    response = String(entry.response.message);
  }

  // Format 2: entry.messages array
  if (!prompt && !response && Array.isArray(entry.messages)) {
    const userMsgs: string[] = [];
    const assistantMsgs: string[] = [];

    for (const msg of entry.messages) {
      const role = msg.role ?? msg.type;
      const text = extractMessageText(msg);
      if (!text) continue;

      if (role === "user" || role === "human") {
        userMsgs.push(text);
      } else if (role === "assistant" || role === "ai" || role === "bot") {
        assistantMsgs.push(text);
      }
    }

    prompt = userMsgs.join("\n---\n");
    response = assistantMsgs.join("\n---\n");
  }

  // Format 3: entry with direct text/content field and role
  if (!prompt && !response && entry.role) {
    const text = extractMessageText(entry as unknown as RawCursorMessage);
    if (entry.role === "user") prompt = text;
    else if (entry.role === "assistant") response = text;
  }

  if (!prompt && !response) return null;

  const timestamp = entry.timestamp ?? Date.now();
  const id = createHash("sha256")
    .update(`${sourceKey}:${contentFingerprint}:${timestamp}`)
    .digest("hex")
    .slice(0, 16);

  return {
    id: `cursor-${id}`,
    timestamp,
    prompt,
    response,
    context: entry.title,
    metadata: {
      sessionId: entry.sessionId,
      sourceKey,
      messageCount: entry.messages?.length,
    },
    source: "cursor",
  };
}

/**
 * Extract text from various Cursor message formats.
 */
function extractMessageText(msg: RawCursorMessage): string {
  if (typeof msg.text === "string" && msg.text.length > 0) {
    return msg.text;
  }
  if (typeof msg.content === "string" && msg.content.length > 0) {
    return msg.content;
  }
  // Nested message.content structure (e.g., { content: { parts: [...] } })
  if (msg.message?.content) {
    if (typeof msg.message.content === "string") {
      return msg.message.content;
    }
    if (Array.isArray(msg.message.content.parts)) {
      return msg.message.content.parts.filter(
        (p): p is string => typeof p === "string"
      ).join("\n");
    }
  }
  return "";
}

// ── JSONL Extraction ─────────────────────────────────────────────

/**
 * Parse a JSONL/JSON log file for Cursor chat interactions.
 * Supports:
 *   - One JSON object per line (JSONL)
 *   - JSON array at top level
 *   - NDJSON with chat message objects
 */
function extractFromLogFile(
  filePath: string,
  since: number,
  lastOffset: number
): { interactions: Interaction[]; newOffset: number } {
  const interactions: Interaction[] = [];

  try {
    const raw = readFileSync(filePath, "utf-8");
    if (raw.length <= lastOffset) {
      return { interactions, newOffset: lastOffset };
    }

    // Only read new content since last offset
    const newContent = raw.slice(lastOffset);

    // Try JSONL (line-by-line)
    const lines = newContent.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const obj = JSON.parse(trimmed) as CursorChatEntry;
        const interaction = parseChatEntry(obj, filePath);
        if (interaction && interaction.timestamp > since) {
          interactions.push(interaction);
        }
      } catch {
        // Skip malformed lines
      }
    }

    return { interactions, newOffset: raw.length };
  } catch {
    return { interactions, newOffset: lastOffset };
  }
}

// ── Agent Transcripts Extraction (Cursor v3+) ──────────────────

/**
 * Extract conversations from Cursor's agent-transcripts JSONL files.
 * Cursor v3+ stores conversation transcripts at:
 *   ~/.cursor/projects/<project-slug>/agent-transcripts/*.jsonl
 *
 * Format: one JSON object per line, with fields:
 *   { sessionId, messages: [{ role, content/text, timestamp }], ... }
 */
function extractFromAgentTranscripts(
  projectDir: string,
  since: number,
  fileOffsets: Record<string, number>
): { interactions: Interaction[]; newOffsets: Record<string, number> } {
  const interactions: Interaction[] = [];
  const newOffsets: Record<string, number> = {};
  const transcriptsDir = join(projectDir, "agent-transcripts");

  if (!existsSync(transcriptsDir)) return { interactions, newOffsets };

  let files: string[] = [];
  try {
    files = readdirSync(transcriptsDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return { interactions, newOffsets };
  }

  for (const file of files) {
    const filePath = join(transcriptsDir, file);
    const lastOffset = fileOffsets[filePath] ?? 0;

    try {
      const raw = readFileSync(filePath, "utf-8");
      if (raw.length <= lastOffset) {
        newOffsets[filePath] = raw.length;
        continue;
      }

      const newContent = raw.slice(lastOffset);
      const lines = newContent.split("\n");

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const obj = JSON.parse(trimmed);

          // Extract messages
          const messages = obj.messages || obj.conversation || [];
          if (!Array.isArray(messages) || messages.length === 0) continue;

          let prompt = "";
          let response = "";
          const userMsgs: string[] = [];
          const assistantMsgs: string[] = [];

          for (const msg of messages) {
            const role = msg.role || msg.type || "";
            const text = msg.content || msg.text || msg.message || "";
            if (!text) continue;

            if (role === "user" || role === "human") {
              userMsgs.push(typeof text === "string" ? text : JSON.stringify(text));
            } else if (role === "assistant" || role === "ai" || role === "bot") {
              assistantMsgs.push(typeof text === "string" ? text : JSON.stringify(text));
            }
          }

          prompt = userMsgs.join("\n---\n");
          response = assistantMsgs.join("\n---\n");

          if (!prompt || !response) continue;

          const timestamp = obj.timestamp || obj.createdAt || Date.now();
          const sessionId = obj.sessionId || obj.id || obj.conversationId || "";

          const id = createHash("sha256")
            .update(`agent-transcript:${sessionId}:${prompt}:${timestamp}`)
            .digest("hex")
            .slice(0, 16);

          interactions.push({
            id: `cursor-ag-${id}`,
            timestamp,
            prompt,
            response,
            context: obj.title || obj.name,
            metadata: {
              sessionId,
              messageCount: messages.length,
              source: "agent-transcripts",
              file,
            },
            source: "cursor",
          });
        } catch {
          // Skip unparseable lines
        }
      }

      newOffsets[filePath] = raw.length;
    } catch {
      newOffsets[filePath] = lastOffset;
    }
  }

  return { interactions, newOffsets };
}

// ── AI Tracking Extraction (Cursor v3) ─────────────────────────

/**
 * Extract conversation summaries and code context from Cursor's
 * AI tracking database.
 *
 * Located at: ~/.cursor/ai-tracking/ai-code-tracking.db
 *
 * While this doesn't contain full message text, it provides:
 *   - conversation summaries (title, tldr, overview)
 *   - code hashes with request context (which files were changed)
 *   - model used, timestamp, file extension
 */
function extractFromAITracking(
  trackingDbPath: string,
  since: number
): Interaction[] {
  const interactions: Interaction[] = [];

  if (!existsSync(trackingDbPath)) return interactions;

  let db: Database | null = null;
  try {
    db = new Database(trackingDbPath, { readonly: true });

    // Check for conversation_summaries
    const hasSummaries = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_summaries'")
      .get();

    if (hasSummaries) {
      const rows = db
        .query(
          `SELECT conversationId, title, tldr, overview, model, mode, updatedAt
           FROM conversation_summaries
           WHERE updatedAt > ?
           ORDER BY updatedAt DESC
           LIMIT 50`
        )
        .all(since) as Array<{
        conversationId: string;
        title: string | null;
        tldr: string | null;
        overview: string | null;
        model: string | null;
        mode: string | null;
        updatedAt: number;
      }>;

      for (const row of rows) {
        const prompt = row.title || "Conversation";
        const response = [row.tldr, row.overview].filter(Boolean).join("\n");
        if (!response) continue;

        const id = createHash("sha256")
          .update(`ai-tracking:${row.conversationId}:${row.updatedAt}`)
          .digest("hex")
          .slice(0, 16);

        interactions.push({
          id: `cursor-tr-${id}`,
          timestamp: row.updatedAt,
          prompt,
          response,
          context: row.mode || undefined,
          metadata: {
            conversationId: row.conversationId,
            model: row.model,
            source: "ai-tracking",
          },
          source: "cursor",
        });
      }
    }

    // Also extract from ai_code_hashes for code change context
    const hasCodeHashes = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_code_hashes'")
      .get();

    if (hasCodeHashes) {
      const codeRows = db
        .query(
          `SELECT DISTINCT conversationId, model, fileExtension, fileName, timestamp, createdAt
           FROM ai_code_hashes
           WHERE createdAt > ?
           ORDER BY createdAt DESC
           LIMIT 100`
        )
        .all(since) as Array<{
        conversationId: string | null;
        model: string | null;
        fileExtension: string | null;
        fileName: string | null;
        timestamp: number | null;
        createdAt: number;
      }>;

      for (const row of codeRows) {
        if (!row.conversationId || !row.fileName) continue;

        const id = createHash("sha256")
          .update(`code-hash:${row.conversationId}:${row.fileName}:${row.createdAt}`)
          .digest("hex")
          .slice(0, 16);

        interactions.push({
          id: `cursor-ch-${id}`,
          timestamp: row.timestamp || row.createdAt,
          prompt: `AI-generated code in ${row.fileName}`,
          response: `File: ${row.fileName} (${row.fileExtension || "unknown"})`,
          context: row.conversationId,
          metadata: {
            conversationId: row.conversationId,
            model: row.model,
            fileName: row.fileName,
            fileExtension: row.fileExtension,
            source: "ai-code-hashes",
          },
          source: "cursor",
        });
      }
    }
  } catch {
    // DB might be locked
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }

  return interactions;
}

// ── Project Discovery (Cursor v3 ~/.cursor/projects/) ───────────

/**
 * Discover Cursor workspaces from both the old workspaceStorage
 * location AND the new ~/.cursor/projects/ directory.
 */
function discoverCursorProjectsV3(basePath: string): Array<{
  projectDir: string;
  projectSlug: string;
}> {
  const results: Array<{ projectDir: string; projectSlug: string }> = [];
  const projectsDir = join(homedir(), ".cursor", "projects");

  if (!existsSync(projectsDir)) return results;

  let entries: string[] = [];
  try {
    entries = readdirSync(projectsDir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const projectDir = join(projectsDir, entry);
    try {
      const stat = require("node:fs").statSync(projectDir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    // Check if this project has agent-transcripts
    const transcriptsExist = existsSync(join(projectDir, "agent-transcripts"));
    if (transcriptsExist) {
      results.push({ projectDir, projectSlug: entry });
    }
  }

  return results;
}

function getStatePath(): string {
  const stateDir = join(homedir(), ".my-brain");
  mkdirSync(stateDir, { recursive: true });
  return join(stateDir, "cursor-harvester-state.json");
}

function loadState(): CursorState {
  const statePath = getStatePath();
  try {
    if (existsSync(statePath)) {
      const raw = readFileSync(statePath, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        lastPollTimestamp: parsed.lastPollTimestamp ?? 0,
        processedIds: new Set(parsed.processedIds ?? []),
        fileOffsets: parsed.fileOffsets ?? {},
      };
    }
  } catch {
    // Corrupt state — start fresh
  }
  return {
    lastPollTimestamp: 0,
    processedIds: new Set(),
    fileOffsets: {},
  };
}

function saveState(state: CursorState): void {
  const statePath = getStatePath();
  try {
    writeJsonFile(statePath, {
      lastPollTimestamp: state.lastPollTimestamp,
      processedIds: Array.from(state.processedIds).slice(-10_000), // Cap at 10k IDs
      fileOffsets: state.fileOffsets,
    });
  } catch {
    // Best effort — will re-process on next run
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  // Simple sync write — acceptable for small state files
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ── Plugin Implementation ────────────────────────────────────────

interface CursorHarvesterConfig {
  /** Poll interval in milliseconds (default: 30_000 = 30s) */
  pollIntervalMs: number;
  /** Override the base Cursor data path (default: auto-detect) */
  basePath?: string;
  /** Only harvest interactions newer than this many ms (default: 3600000 = 1h on first run) */
  lookbackWindowMs: number;
  /** Emit HARVESTER_NEW_DATA for each interaction (default: true) */
  emitPerInteraction: boolean;
}

const DEFAULT_CONFIG: CursorHarvesterConfig = {
  pollIntervalMs: 30_000,
  lookbackWindowMs: 3_600_000, // 1 hour
  emitPerInteraction: true,
};

export default definePlugin({
  name: PLUGIN_NAME,
  version: "0.2.0",
  description:
    "Data harvester for Cursor IDE — supports SQLite (v0.x), cursorDiskKV, agent-transcripts (v3+), and AI tracking DB",

  setup(hooks: PluginHooks): void {
    const plugin = createCursorHarvester(hooks);
    // Expose harvester methods on the hooks system for external control
    // (daemon calls poll via HARVESTER_POLL, start/stop via lifecycle hooks)
    hooks.hook(HookEvent.DAEMON_START, async () => {
      await plugin.start();
    });
    hooks.hook(HookEvent.DAEMON_STOP, async () => {
      await plugin.stop();
    });
    hooks.hook(HookEvent.HARVESTER_POLL, async () => {
      await plugin.poll();
    });

    // Store reference so the plugin manager can interact with it
    (hooks as unknown as Record<string, unknown>)[PLUGIN_NAME] = plugin;
  },

  async teardown(): Promise<void> {
    // Cleanup handled via DAEMON_STOP hook
  },
});

// ── Harvester Implementation ─────────────────────────────────────

function createCursorHarvester(hooks: PluginHooks): HarvesterPlugin {
  const state = loadState();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  const resolvedConfig: CursorHarvesterConfig = { ...DEFAULT_CONFIG };

  /**
   * Main poll function — discovers workspaces, extracts new interactions
   * from SQLite and JSONL sources, and feeds them into the pipeline.
   */
  async function poll(): Promise<InteractionContext[]> {
    const basePath = resolvedConfig.basePath ?? getCursorBasePath();
    const since = Date.now() - resolvedConfig.lookbackWindowMs;

    if (!existsSync(basePath)) {
      await hooks.callHook(HookEvent.PLUGIN_ERROR, {
        name: PLUGIN_NAME,
        error: `Cursor data directory not found: ${basePath}`,
      });
      return [];
    }

    const workspaces = discoverWorkspaces(basePath);
    const allInteractions: Interaction[] = [];

    for (const ws of workspaces) {
      // Extract from SQLite state databases
      if (ws.dbPath) {
        try {
          const interactions = extractFromStateDb(ws.dbPath, since);
          // Tag with project name if detected
          if (ws.projectName) {
            for (const ix of interactions) {
              ix.metadata = { ...ix.metadata, project: ws.projectName };
            }
          }
          allInteractions.push(...interactions);
          // Also check cursorDiskKV table (newer Cursor format)
          const kvInteractions = extractFromCursorDiskKV(ws.dbPath, since);
          if (ws.projectName) {
            for (const ix of kvInteractions) {
              ix.metadata = { ...ix.metadata, project: ws.projectName };
            }
          }
          allInteractions.push(...kvInteractions);
        } catch (err) {
          await hooks.callHook(HookEvent.PLUGIN_ERROR, {
            name: PLUGIN_NAME,
            error: `Failed to read state DB: ${ws.dbPath}`,
            details: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Extract from JSONL/JSON log files
      if (ws.logPath) {
        const lastOffset = state.fileOffsets[ws.logPath] ?? 0;
        try {
          const { interactions, newOffset } = extractFromLogFile(
            ws.logPath,
            since,
            lastOffset
          );
          state.fileOffsets[ws.logPath] = newOffset;
          allInteractions.push(...interactions);
        } catch (err) {
          await hooks.callHook(HookEvent.PLUGIN_ERROR, {
            name: PLUGIN_NAME,
            error: `Failed to read log file: ${ws.logPath}`,
            details: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // ── Cursor v3+ sources ──────────────────────────────────

    // Extract from agent-transcripts (Cursor v3+)
    try {
      const cursorProjects = discoverCursorProjectsV3(basePath);
      for (const { projectDir, projectSlug } of cursorProjects) {
        const { interactions, newOffsets } = extractFromAgentTranscripts(
          projectDir,
          since,
          state.fileOffsets
        );
        // Merge offsets back into state
        for (const [path, offset] of Object.entries(newOffsets)) {
          state.fileOffsets[path] = offset;
        }
        // Tag with project slug
        for (const ix of interactions) {
          ix.metadata = { ...ix.metadata, project: projectSlug };
        }
        allInteractions.push(...interactions);
      }
    } catch (err) {
      // Non-critical — agent-transcripts might not exist
    }

    // Extract from AI tracking database (Cursor v3+)
    try {
      const trackingDb = join(homedir(), ".cursor", "ai-tracking", "ai-code-tracking.db");
      if (existsSync(trackingDb)) {
        const trackingInteractions = extractFromAITracking(trackingDb, since);
        allInteractions.push(...trackingInteractions);
      }
    } catch (err) {
      // Non-critical
    }

    // Deduplicate: filter out already-processed interactions
    const newInteractions = allInteractions.filter((interaction) => {
      if (state.processedIds.has(interaction.id)) return false;
      state.processedIds.add(interaction.id);
      return true;
    });

    // Sort by timestamp ascending for chronological processing
    newInteractions.sort((a, b) => a.timestamp - b.timestamp);

    // Build InteractionContext for each new interaction and emit events
    const contexts: InteractionContext[] = [];

    for (const interaction of newInteractions) {
      const ctx = buildInteractionContext(interaction);

      // Emit per-interaction event if configured
      if (resolvedConfig.emitPerInteraction) {
        await hooks.callHook(HookEvent.HARVESTER_NEW_DATA, ctx);
      }

      // Feed into main ON_INTERACTION pipeline
      await hooks.callHook(HookEvent.ON_INTERACTION, ctx);

      contexts.push(ctx);
    }

    // Update state
    state.lastPollTimestamp = Date.now();
    saveState(state);

    return contexts;
  }

  function buildInteractionContext(interaction: Interaction): InteractionContext {
    const projectName = (interaction.metadata as any)?.project as string | undefined;
    const fragment: MemoryFragment = {
      id: `frag-${interaction.id}`,
      layer: MemoryLayer.INSTANT,
      content: `Prompt: ${interaction.prompt}\n\nResponse: ${interaction.response}`,
      timestamp: interaction.timestamp,
      source: interaction.source,
      metadata: { ...interaction.metadata, project: projectName },
    };

    const promoted: MemoryFragment[] = [];

    return {
      interaction,
      fragments: [fragment],
      promoteToDeep(frag: MemoryFragment): void {
        promoted.push(frag);
      },
    };
  }

  async function start(): Promise<void> {
    if (running) return;
    running = true;

    // Initial poll
    try {
      await poll();
    } catch (err) {
      await hooks.callHook(HookEvent.PLUGIN_ERROR, {
        name: PLUGIN_NAME,
        error: "Initial poll failed",
        details: err instanceof Error ? err.message : String(err),
      });
    }

    // Schedule periodic polling
    pollTimer = setInterval(async () => {
      if (!running) return;
      try {
        await poll();
      } catch {
        // Errors logged inside poll()
      }
    }, resolvedConfig.pollIntervalMs);
  }

  async function stop(): Promise<void> {
    running = false;
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    saveState(state);
  }

  return {
    name: PLUGIN_NAME,
    start,
    stop,
    poll,
  };
}

// ── Re-exports ───────────────────────────────────────────────────

export type { CursorHarvesterConfig };
export { getCursorBasePath, discoverWorkspaces };

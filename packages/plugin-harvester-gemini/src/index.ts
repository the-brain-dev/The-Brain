/**
 * @the-brain/plugin-harvester-gemini
 *
 * Data harvester that polls Gemini CLI's local conversation logs
 * (~/.gemini/tmp/<project>/logs.json and chat sessions) and feeds new
 * interactions into the the-brain pipeline.
 *
 * Gemini CLI stores conversation data in:
 *   - ~/.gemini/tmp/<project-slug>/logs.json — flat array of message objects
 *     Format: [{sessionId, messageId, type, message, timestamp}, ...]
 *   - ~/.gemini/tmp/<project-slug>/chats/session-*.json — full chat sessions
 *     Format: {sessionId, messages: [{id, timestamp, type, content}, ...]}
 *   - ~/.gemini/tmp/<hash>/ — hash-based session directories (older format)
 *   - ~/.gemini/projects.json — maps project paths to slugs
 *
 * Message types:
 *   - "user": prompt from the developer
 *   - "gemini": AI response (can have multiple consecutive)
 *   - "info": system/info messages (ignored)
 *
 * Content format:
 *   - In logs.json: message is a plain string
 *   - In chat sessions: content is an array of blocks [{text, type}, ...]
 *     Block types: "text", "tool_use", "thinking"
 *
 * Strategy:
 *   1. Read projects.json to discover project slugs
 *   2. For each project, poll logs.json for new entries (incremental by offset)
 *   3. Pair consecutive user→gemini messages
 *   4. Also check chat session files as supplementary source
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { Interaction, InteractionContext, PluginHooks } from "@the-brain/core";
import { HookEvent, MemoryLayer, definePlugin } from "@the-brain/core";

// ── Types ────────────────────────────────────────────────────────

interface GeminiLogEntry {
  sessionId: string;
  messageId: number;
  type: string; // "user" | "gemini" | "info"
  message: string;
  timestamp: string; // ISO 8601
}

interface GeminiChatMessage {
  id: string;
  timestamp: string;
  type: string;
  content: GeminiContentBlock[];
}

type GeminiContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name?: string; input?: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id?: string; content?: string }
  | { type: "thinking"; thinking?: string }
  | { type: string; [key: string]: unknown };

interface GeminiChatSession {
  sessionId: string;
  projectHash?: string;
  startTime: string;
  lastUpdated: string;
  messages: GeminiChatMessage[];
  kind?: string;
}

interface GeminiState {
  lastPollTimestamp: number;
  processedIds: Set<string>;
  /** Per-file JSON array offsets for incremental reading */
  fileOffsets: Record<string, number>;
  /** Per-file messageId watermark */
  messageIdWatermarks: Record<string, number>;
}

// ── Config ───────────────────────────────────────────────────────

interface GeminiHarvesterConfig {
  pollIntervalMs: number;
  maxInteractionsPerPoll: number;
  lookbackWindowMs: number;
  includeInfo: boolean;
}

const DEFAULT_CONFIG: GeminiHarvesterConfig = {
  pollIntervalMs: 30_000,
  maxInteractionsPerPoll: 100,
  lookbackWindowMs: 7 * 24 * 3600 * 1000, // 7 days
  includeInfo: false,
};

// ── Path Discovery ───────────────────────────────────────────────

function getHomeDir(): string {
  return process.env.HOME || homedir();
}

function getGeminiBasePath(): string {
  return join(getHomeDir(), ".gemini");
}

function getTempPath(basePath: string): string {
  return join(basePath, "tmp");
}

function getProjectsJson(basePath: string): string {
  return join(basePath, "projects.json");
}

function getStatePath(): string {
  const dir = join(getHomeDir(), ".the-brain");
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return join(dir, "gemini-harvester-state.json");
}

// ── State Management ─────────────────────────────────────────────

function loadState(): GeminiState {
  const path = getStatePath();
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);
    return {
      lastPollTimestamp: data.lastPollTimestamp ?? 0,
      processedIds: new Set(data.processedIds ?? []),
      fileOffsets: data.fileOffsets ?? {},
      messageIdWatermarks: data.messageIdWatermarks ?? {},
    };
  } catch {
    return {
      lastPollTimestamp: 0,
      processedIds: new Set(),
      fileOffsets: {},
      messageIdWatermarks: {},
    };
  }
}

function saveState(state: GeminiState): void {
  const path = getStatePath();
  try {
    writeFileSync(
      path,
      JSON.stringify(
        {
          lastPollTimestamp: state.lastPollTimestamp,
          processedIds: Array.from(state.processedIds).slice(-10_000),
          fileOffsets: state.fileOffsets,
          messageIdWatermarks: state.messageIdWatermarks,
        },
        null,
        2
      ),
      "utf-8"
    );
  } catch {}
}

// ── Project Discovery ────────────────────────────────────────────

interface DiscoveredProject {
  slug: string;
  tmpDir: string;
  logsPath: string | null;
  chatsDir: string | null;
}

/**
 * Discover Gemini CLI project directories from ~/.gemini/tmp/.
 * Reads projects.json to map slugs, then scans tmp/ for both
 * named and hash-based session directories.
 */
function discoverProjects(basePath: string): DiscoveredProject[] {
  const projects: DiscoveredProject[] = [];
  const tmpDir = getTempPath(basePath);

  if (!existsSync(tmpDir)) return projects;

  // Read project slug mapping
  const slugMap = new Map<string, string>(); // path → slug
  const projectsPath = getProjectsJson(basePath);
  if (existsSync(projectsPath)) {
    try {
      const raw = readFileSync(projectsPath, "utf-8");
      const data = JSON.parse(raw);
      const entries = data.projects || {};
      for (const [projPath, slug] of Object.entries(entries)) {
        slugMap.set(projPath as string, slug as string);
      }
    } catch {}
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(tmpDir);
  } catch {
    return projects;
  }

  for (const entry of entries) {
    const fullPath = join(tmpDir, entry);
    let stat;
    try {
      stat = readdirSync(fullPath, { withFileTypes: true })[0] !== undefined
        ? statSync(fullPath)
        : null;
    } catch {
      continue;
    }
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    // Skip special directories
    if (entry === "bin" || entry === "images") continue;

    const logsPath = join(fullPath, "logs.json");
    const chatsDir = join(fullPath, "chats");

    projects.push({
      slug: entry,
      tmpDir: fullPath,
      logsPath: existsSync(logsPath) ? logsPath : null,
      chatsDir: existsSync(chatsDir) ? chatsDir : null,
    });
  }

  return projects;
}

// ── Content Extraction ───────────────────────────────────────────

/**
 * Extract readable text from Gemini content blocks.
 */
function extractTextFromBlocks(blocks: GeminiContentBlock[]): string {
  if (!Array.isArray(blocks)) return String(blocks ?? "");

  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && (block as any).text) {
      parts.push((block as any).text);
    } else if (block.type === "tool_use") {
      const name = (block as any).name || "unknown";
      parts.push(`[tool:${name}]`);
    } else if (block.type === "thinking") {
      // Skip thinking blocks (internal, not user-facing)
    }
  }
  return parts.join("\n").trim();
}

/**
 * Extract text from a logs.json message (plain string).
 */
function extractTextFromLogMessage(msg: GeminiLogEntry): string {
  if (!msg.message) return "";
  // Strip tool output references that are file paths
  const cleaned = msg.message
    .replace(/@.*\.gemini\/tmp\/[^\s]+\.png/g, "[image]")
    .trim();
  return cleaned;
}

/**
 * Generate a unique hash ID for an interaction.
 */
function hashInteraction(sessionId: string, messageId: number): string {
  return createHash("sha256")
    .update(`gemini:${sessionId}:${messageId}`)
    .digest("hex")
    .slice(0, 16);
}

// ── Logs.json Extraction ─────────────────────────────────────────

/**
 * Extract user→gemini interactions from a logs.json file.
 * Reads only new entries since the last messageId watermark.
 *
 * Strategy: logs.json is a flat array of all messages across all
 * sessions. We pair consecutive user→gemini messages and use
 * messageId watermark for incremental polling.
 */
function extractFromLogsJson(
  filePath: string,
  state: GeminiState,
  config: GeminiHarvesterConfig
): Interaction[] {
  const interactions: Interaction[] = [];

  if (!existsSync(filePath)) return interactions;

  let entries: GeminiLogEntry[] = [];
  try {
    const raw = readFileSync(filePath, "utf-8");
    entries = JSON.parse(raw);
  } catch {
    return interactions;
  }

  if (!Array.isArray(entries)) return interactions;

  const cutoff = Date.now() - config.lookbackWindowMs;
  const watermark = state.messageIdWatermarks[filePath] ?? -1;

  // Pair consecutive user→gemini messages
  let currentUser: GeminiLogEntry | null = null;

  for (const entry of entries) {
    // Skip already-processed entries by messageId
    if (entry.messageId <= watermark) continue;
    // Skip old entries
    const ts = new Date(entry.timestamp).getTime();
    if (ts < cutoff) continue;

    if (entry.type === "user" && entry.message) {
      currentUser = entry;
    } else if (entry.type === "gemini" && currentUser) {
      const prompt = extractTextFromLogMessage(currentUser);
      const response = extractTextFromLogMessage(entry);

      if (prompt && response) {
        const id = hashInteraction(entry.sessionId, entry.messageId);

        if (!state.processedIds.has(id)) {
          interactions.push({
            id: `gemini-${id}`,
            timestamp: new Date(entry.timestamp).getTime(),
            prompt,
            response,
            source: "gemini-cli",
            metadata: {
              sessionId: entry.sessionId,
              messageId: entry.messageId,
            },
          });
          state.processedIds.add(id);
        }
      }
      currentUser = null;
    } else if (entry.type === "gemini" && !currentUser) {
      // Standalone gemini response (multi-turn: assistant continues)
      // We'll pair it with the most recent interaction
    }
  }

  // Update watermark to the last processed messageId
  if (entries.length > 0) {
    state.messageIdWatermarks[filePath] = entries[entries.length - 1].messageId;
  }

  return interactions;
}

// ── Chat Session Extraction ──────────────────────────────────────

/**
 * Extract interactions from a Gemini chat session file.
 * Chat sessions have the full message history with structured content blocks.
 *
 * Format: {sessionId, messages: [{id, timestamp, type, content: [{text, type}]}]}
 */
function extractFromChatSession(
  filePath: string,
  state: GeminiState,
  config: GeminiHarvesterConfig
): Interaction[] {
  const interactions: Interaction[] = [];

  if (!existsSync(filePath)) return interactions;

  let session: GeminiChatSession;
  try {
    const raw = readFileSync(filePath, "utf-8");
    session = JSON.parse(raw);
  } catch {
    return interactions;
  }

  if (!session.messages || !Array.isArray(session.messages)) return interactions;

  const cutoff = Date.now() - config.lookbackWindowMs;

  // Pair consecutive user→assistant messages
  let currentUser: GeminiChatMessage | null = null;

  for (const msg of session.messages) {
    const ts = new Date(msg.timestamp).getTime();
    if (ts < cutoff) continue;

    if (msg.type === "user") {
      currentUser = msg;
    } else if (msg.type === "gemini" && currentUser) {
      const prompt = extractTextFromBlocks(currentUser.content);
      const response = extractTextFromBlocks(msg.content);

      if (prompt && response) {
        const id = createHash("sha256")
          .update(`chat:${session.sessionId}:${msg.id}`)
          .digest("hex")
          .slice(0, 16);

        if (!state.processedIds.has(id)) {
          interactions.push({
            id: `gemini-chat-${id}`,
            timestamp: ts,
            prompt,
            response,
            source: "gemini-cli-chat",
            metadata: {
              sessionId: session.sessionId,
              messageId: msg.id,
              sessionStart: session.startTime,
            },
          });
          state.processedIds.add(id);
        }
      }
      currentUser = null;
    } else if (msg.type === "gemini") {
      // Consecutive assistant messages (tool use follow-ups, etc.)
    }
  }

  return interactions;
}

// ── Plugin ───────────────────────────────────────────────────────

export function createGeminiHarvester(
  hooks: PluginHooks,
  config: Partial<GeminiHarvesterConfig> = {}
) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let state = loadState();
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const harvester = {
    async poll(): Promise<InteractionContext[]> {
      const basePath = getGeminiBasePath();

      if (!existsSync(basePath)) {
        return [];
      }

      const projects = discoverProjects(basePath);
      const allInteractions: Interaction[] = [];

      for (const project of projects) {
        if (allInteractions.length >= cfg.maxInteractionsPerPoll) break;

        // 1. Poll logs.json
        if (project.logsPath) {
          try {
            const interactions = extractFromLogsJson(
              project.logsPath,
              state,
              cfg
            );
            // Tag with project slug
            for (const ix of interactions) {
              ix.metadata = { ...ix.metadata, project: project.slug };
            }
            allInteractions.push(...interactions);
          } catch {
            // Skip problematic files
          }
        }

        // 2. Poll chat session files (supplementary)
        if (project.chatsDir && allInteractions.length < cfg.maxInteractionsPerPoll) {
          try {
            const chatFiles = readdirSync(project.chatsDir).filter((f) =>
              f.startsWith("session-") && f.endsWith(".json")
            );

            for (const chatFile of chatFiles) {
              if (allInteractions.length >= cfg.maxInteractionsPerPoll) break;

              const chatPath = join(project.chatsDir, chatFile);
              const chatOffset = state.fileOffsets[chatPath] ?? 0;

              try {
                // Chat sessions are complete files — check if mtime changed
                const stat = statSync(chatPath);
                if (stat.mtimeMs <= chatOffset) continue;

                const interactions = extractFromChatSession(
                  chatPath,
                  state,
                  cfg
                );
                for (const ix of interactions) {
                  ix.metadata = { ...ix.metadata, project: project.slug };
                }
                allInteractions.push(...interactions);

                state.fileOffsets[chatPath] = stat.mtimeMs;
              } catch {
                // Skip
              }
            }
          } catch {
            // chatsDir might not exist
          }
        }
      }

      // Deduplicate by ID within this batch
      const seen = new Set<string>();
      const uniqueInteractions = allInteractions.filter((i) => {
        if (seen.has(i.id)) return false;
        seen.add(i.id);
        return true;
      });

      // Update state
      state.lastPollTimestamp = Date.now();

      // Emit interactions
      const contexts: InteractionContext[] = [];
      for (const interaction of uniqueInteractions) {
        const ctx: InteractionContext = {
          interaction,
          fragments: [
            {
              id: `gemini-${interaction.id}`,
              layer: MemoryLayer.INSTANT,
              content: `Prompt: ${interaction.prompt}\nResponse: ${interaction.response.slice(0, 500)}`,
              timestamp: interaction.timestamp,
              source: interaction.source,
              metadata: interaction.metadata,
            },
          ],
          promoteToDeep: async (frag: MemoryFragment) => {
            await hooks.callHook(HookEvent.SELECTION_PROMOTE, frag);
          },
        };

        contexts.push(ctx);
        await hooks.callHook(HookEvent.HARVESTER_NEW_DATA, ctx);
        await hooks.callHook(HookEvent.ON_INTERACTION, ctx);
      }

      // Persist state
      saveState(state);

      return contexts;
    },

    start(): void {
      if (running) return;
      running = true;

      // Initial poll
      this.poll().catch(() => {});

      // Periodic polling
      intervalId = setInterval(() => {
        this.poll().catch(() => {});
      }, cfg.pollIntervalMs);
    },

    stop(): void {
      running = false;
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
      saveState(state);
    },

    getState(): GeminiState {
      return {
        ...state,
        processedIds: new Set(state.processedIds),
      };
    },
  };

  return harvester;
}

// ── Plugin Definition ────────────────────────────────────────────

export default definePlugin({
  name: "@the-brain/plugin-harvester-gemini",
  version: "0.1.0",
  description:
    "Polls Gemini CLI's ~/.gemini/tmp/ conversation logs and feeds interactions into the the-brain pipeline",

  setup(hooks: PluginHooks) {
    const harvester = createGeminiHarvester(hooks);

    hooks.hook(HookEvent.DAEMON_START, async () => {
      harvester.start();
    });

    hooks.hook(HookEvent.DAEMON_STOP, async () => {
      harvester.stop();
    });

    hooks.hook(HookEvent.HARVESTER_POLL, async () => {
      await harvester.poll();
    });

    // Store harvester reference for testing
    (hooks as any)._geminiHarvester = harvester;
  },

  teardown() {
    // Cleanup handled by DAEMON_STOP hook
  },
});

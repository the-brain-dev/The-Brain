/**
 * @the-brain-dev/plugin-harvester-claude
 *
 * Data harvester that polls Claude Code's local conversation transcripts
 * (~/.claude/projects/<project>/<sessionId>.jsonl) and feeds new
 * interactions into the the-brain pipeline.
 *
 * Claude Code stores conversation data in:
 *   - ~/.claude/projects/<encoded-path>/<sessionId>.jsonl — full transcripts
 *   - ~/.claude/history.jsonl — prompt-only history (supplementary)
 *
 * Message types in the JSONL:
 *   - user: prompt from the developer
 *   - assistant: AI response (with content text and optional tool use)
 *   - progress: hook/system progress events (ignored)
 *   - system: system messages (ignored)
 *   - file-history-snapshot: file backups (ignored)
 *
 * Key fields per message:
 *   - uuid, parentUuid: message chain linking
 *   - sessionId: cross-directory session identifier
 *   - type: "user" | "assistant" | ...
 *   - message: { role, content: [{type, text}] }
 *   - isMeta: true for system-generated user messages (model switch, local commands)
 *   - isSidechain: true for sub-agent messages
 *   - timestamp: ISO 8601
 *   - cwd: working directory
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type {
  Interaction,
  InteractionContext,
  PluginHooks,
} from "@the-brain-dev/core";
import { HookEvent, MemoryLayer, definePlugin } from "@the-brain-dev/core";

// ── Types ────────────────────────────────────────────────────────

interface ClaudeState {
  lastPollTimestamp: number;
  processedIds: Set<string>;
  /** Per-file read offsets for JSONL incremental reading */
  fileOffsets: Record<string, number>;
}

interface RawClaudeMessage {
  uuid: string;
  parentUuid?: string | null;
  type: string;
  message?: any;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  isMeta?: string | boolean;
  isSidechain?: string | boolean;
  [key: string]: unknown;
}

interface ParsedContent {
  text: string;
  toolUse?: { name: string; input: Record<string, unknown> };
}

// ── Config ───────────────────────────────────────────────────────

interface ClaudeHarvesterConfig {
  /** Polling interval in ms (default: 60000 — Claude Code sessions are longer) */
  pollIntervalMs: number;
  /** Override the Claude base path (default: ~/.claude) */
  basePath?: string;
  /** Whether to include sidechain (sub-agent) messages */
  includeSidechains: boolean;
  /** Whether to include meta messages (system commands) */
  includeMeta: boolean;
  /** Maximum interactions per poll */
  maxInteractionsPerPoll: number;
  /** Lookback window in ms — only process files modified within this window */
  lookbackWindowMs: number;
}

const DEFAULT_CONFIG: ClaudeHarvesterConfig = {
  pollIntervalMs: 60000,
  includeSidechains: true,
  includeMeta: false,
  maxInteractionsPerPoll: 100,
  lookbackWindowMs: 7 * 24 * 3600 * 1000, // 7 days
};

// ── Claude Path Discovery ────────────────────────────────────────

function getHomeDir(): string {
  return process.env.HOME || homedir();
}

function getClaudeBasePath(config: ClaudeHarvesterConfig): string {
  return config.basePath ?? join(getHomeDir(), ".claude");
}

function getStatePath(): string {
  return join(getHomeDir(), ".the-brain", "claude-harvester-state.json");
}

function getProjectsPath(basePath: string): string {
  return join(basePath, "projects");
}

function loadState(basePath?: string): ClaudeState {
  const path = basePath 
    ? join(basePath, "..", ".the-brain", "claude-harvester-state.json")
    : getStatePath();
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);
    return {
      lastPollTimestamp: data.lastPollTimestamp ?? 0,
      processedIds: new Set(data.processedIds ?? []),
      fileOffsets: data.fileOffsets ?? {},
    };
  } catch {
    return {
      lastPollTimestamp: 0,
      processedIds: new Set(),
      fileOffsets: {},
    };
  }
}

function saveState(state: ClaudeState, basePath?: string): void {
  const homeDir = basePath ? join(basePath, "..") : getHomeDir();
  const dir = join(homeDir, ".the-brain");
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const path = basePath 
    ? join(dir, "claude-harvester-state.json")
    : getStatePath();
  writeFileSync(
    path,
    JSON.stringify({
      lastPollTimestamp: state.lastPollTimestamp,
      processedIds: Array.from(state.processedIds).slice(-10000),
      fileOffsets: state.fileOffsets,
    }, null, 2),
    "utf-8"
  );
}

// ── Message Parsing ──────────────────────────────────────────────

/**
 * Claude Code stores the message field as either a Python repr string
 * or a JSON object. This normalizes it.
 */
function parseMessage(raw: any): { role?: string; content: any[] } | null {
  if (!raw) return null;

  // Already an object
  if (typeof raw === "object" && raw !== null) {
    return raw;
  }

  // Python repr string → try JSON first, then Python literal
  if (typeof raw === "string") {
    try {
      // Claude sometimes stores as JSON{...}
      return JSON.parse(raw);
    } catch {
      // Try Python repr (single quotes, True/False/None)
      try {
        const fixed = raw
          .replace(/'/g, '"')  // single → double quotes (simplified)
          .replace(/True/g, "true")
          .replace(/False/g, "false")
          .replace(/None/g, "null");
        return JSON.parse(fixed);
      } catch {
        return null;
      }
    }
  }

  return null;
}

/**
 * Extract readable text from a Claude message content array.
 */
function extractText(content: any[]): string {
  if (!Array.isArray(content)) return String(content ?? "");

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    } else if (block.type === "tool_use") {
      parts.push(`[tool:${block.name || "unknown"}]`);
    } else if (block.type === "thinking") {
      // Skip thinking blocks (internal, not user-facing)
    }
  }
  return parts.join("\n").trim();
}

/**
 * Filter out system-generated messages.
 * @param includeMeta - If true, allow meta messages (system commands). Default false.
 * @param includeSidechains - If true, allow sidechain/sub-agent messages. Default false.
 */
function isRealUserMessage(
  msg: RawClaudeMessage,
  options?: { includeMeta?: boolean; includeSidechains?: boolean },
): boolean {
  if (msg.type !== "user") return false;
  if (!options?.includeMeta && (msg.isMeta === "True" || msg.isMeta === true)) return false;
  if (!options?.includeSidechains && (msg.isSidechain === "True" || msg.isSidechain === true)) return false;

  const parsed = parseMessage(msg.message);
  if (!parsed) return false;

  const text = extractText(parsed.content);
  if (!text) return false;

  // Filter out local command stdout/stderr echoes
  if (text.includes("<local-command-stdout>")) return false;
  if (text.includes("<local-command-stderr>")) return false;
  if (text.includes("<local-command-caveat>")) return false;
  if (text.startsWith("<command-name>")) return false;

  return true;
}

function isRealAssistantMessage(msg: RawClaudeMessage): boolean {
  if (msg.type !== "assistant") return false;
  const parsed = parseMessage(msg.message);
  if (!parsed) return false;
  const text = extractText(parsed.content);
  // Assistant messages with only thinking blocks aren't "real" responses
  if (!text) return false;
  return true;
}

// ── Interaction Extraction ───────────────────────────────────────

/**
 * Generate a unique hash ID for an interaction.
 */
function hashInteraction(prompt: string, response: string): string {
  return createHash("sha256")
    .update(`${prompt}\n${response}`)
    .digest("hex")
    .slice(0, 16);
}

// ── Project Detection ────────────────────────────────────────

/**
 * Match a working directory against registered project contexts.
 * Returns the project name if cwd is inside a project's workDir.
 */
function matchProjectFromCwd(cwd: string | undefined): string | null {
  if (!cwd) return null;
  try {
    const configPath = join(process.env.HOME || homedir(), ".the-brain", "config.json");
    if (!existsSync(configPath)) return null;
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    const contexts = config.contexts || {};
    for (const [name, ctx] of Object.entries(contexts) as [string, any][]) {
      const workDir = ctx.workDir as string | undefined;
      if (workDir && cwd.startsWith(workDir)) {
        return name;
      }
    }
  } catch {}
  return null;
}

/**
 * Read and parse a JSONL file, extracting user→assistant pairs.
 */
function extractFromJSONL(
  filePath: string,
  state: ClaudeState,
  config: ClaudeHarvesterConfig,
): { interactions: Interaction[]; newOffset: number } {
  const interactions: Interaction[] = [];
  let content: string;

  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return { interactions, newOffset: state.fileOffsets[filePath] ?? 0 };
  }

  const startOffset = state.fileOffsets[filePath] ?? 0;
  if (startOffset >= content.length) {
    return { interactions, newOffset: content.length };
  }

  // Read only new content
  const newContent = content.slice(startOffset);
  const lines = newContent.split("\n").filter((l) => l.trim());

  const parsedMessages: RawClaudeMessage[] = [];
  for (const line of lines) {
    try {
      parsedMessages.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  // Pair user→assistant messages
  let currentUser: RawClaudeMessage | null = null;

  for (const msg of parsedMessages) {
    if (isRealUserMessage(msg, { includeMeta: config.includeMeta, includeSidechains: config.includeSidechains })) {
      currentUser = msg;
    } else if (isRealAssistantMessage(msg) && currentUser) {
      const promptParsed = parseMessage(currentUser.message)!;
      const responseParsed = parseMessage(msg.message)!;

      const prompt = extractText(promptParsed.content);
      const response = extractText(responseParsed.content);

      if (prompt && response) {
        const id = hashInteraction(prompt, response);

        if (!state.processedIds.has(id)) {
          interactions.push({
            id,
            timestamp: msg.timestamp
              ? new Date(msg.timestamp).getTime()
              : Date.now(),
            prompt,
            response,
            source: "claude-code",
            metadata: {
              sessionId: msg.sessionId,
              cwd: msg.cwd,
              messageUuid: msg.uuid,
              project: matchProjectFromCwd(msg.cwd),
            },
          });
          state.processedIds.add(id);
        }
      }
      currentUser = null;
    }
  }

  return { interactions, newOffset: content.length };
}

// ── Discovery ────────────────────────────────────────────────────

/**
 * Find all JSONL files in the Claude projects directory.
 */
function discoverSessionFiles(projectsPath: string): string[] {
  const files: string[] = [];

  if (!existsSync(projectsPath)) return files;

  try {
    const projectDirs = readdirSync(projectsPath, { withFileTypes: true });
    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue;
      const projectPath = join(projectsPath, dir.name);

      try {
        const entries = readdirSync(projectPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            files.push(join(projectPath, entry.name));
          }
          // Some sessions are stored as directories with numbered .json files
          if (entry.isDirectory()) {
            try {
              const subEntries = readdirSync(join(projectPath, entry.name));
              for (const sub of subEntries) {
                if (sub.endsWith(".jsonl") || sub.endsWith(".json")) {
                  files.push(join(projectPath, entry.name, sub));
                }
              }
            } catch {}
          }
        }
      } catch {}
    }
  } catch {}

  return files;
}

/**
 * Extract interactions from history.jsonl (prompt-only, supplementary).
 */
function extractFromHistory(
  historyPath: string,
  state: ClaudeState,
  config: ClaudeHarvesterConfig,
): Interaction[] {
  const interactions: Interaction[] = [];

  if (!existsSync(historyPath)) return interactions;

  const cutoff = Date.now() - config.lookbackWindowMs;

  try {
    const content = readFileSync(historyPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      if (interactions.length >= config.maxInteractionsPerPoll) break;
      try {
        const entry = JSON.parse(line);
        const display = entry.display;
        const timestamp = entry.timestamp;
        const project = entry.project;

        // Skip old entries and entries without prompt text
        const ts = typeof timestamp === "number" ? timestamp : 0;
        if (!display || !timestamp || ts < cutoff) continue;

        const id = createHash("sha256")
          .update(`${display}-${timestamp}`)
          .digest("hex")
          .slice(0, 16);

        if (!state.processedIds.has(id)) {
          interactions.push({
            id,
            timestamp: ts,
            prompt: display,
            response: "", // History is prompt-only
            source: "claude-code-history",
            metadata: { project },
          });
          state.processedIds.add(id);
        }
      } catch {}
    }
  } catch {}

  return interactions;
}

// ── Plugin ───────────────────────────────────────────────────────

export function createClaudeHarvester(
  hooks: PluginHooks,
  config: Partial<ClaudeHarvesterConfig> = {},
) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let state = loadState(cfg.basePath);
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const harvester = {
    async poll(): Promise<InteractionContext[]> {
      const basePath = getClaudeBasePath(cfg);
      const projectsPath = getProjectsPath(basePath);
      const historyPath = join(basePath, "history.jsonl");

      const allInteractions: Interaction[] = [];

      // 1. Poll session transcripts from projects/
      const sessionFiles = discoverSessionFiles(projectsPath);

      for (const file of sessionFiles) {
        if (allInteractions.length >= cfg.maxInteractionsPerPoll) break;

        try {
          const { interactions, newOffset } = extractFromJSONL(file, state, cfg);
          state.fileOffsets[file] = newOffset;
          allInteractions.push(...interactions);
        } catch (err) {
          // Skip problematic files
        }
      }

      // 2. Poll history.jsonl (supplementary)
      if (allInteractions.length < cfg.maxInteractionsPerPoll) {
        try {
          const historyInteractions = extractFromHistory(historyPath, state, cfg);
          allInteractions.push(
            ...historyInteractions.slice(0, cfg.maxInteractionsPerPoll - allInteractions.length),
          );
        } catch {}
      }

      // Update state
      state.lastPollTimestamp = Date.now();

      // Deduplicate by ID within this batch
      const seen = new Set<string>();
      const uniqueInteractions = allInteractions.filter((i) => {
        if (seen.has(i.id)) return false;
        seen.add(i.id);
        return true;
      });

      // Emit interactions
      const contexts: InteractionContext[] = [];
      for (const interaction of uniqueInteractions) {
        const ctx: InteractionContext = {
          interaction,
          fragments: [
            {
              id: `claude-${interaction.id}`,
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
      saveState(state, cfg.basePath);

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
      saveState(state, cfg.basePath);
    },

    getState(): ClaudeState {
      return { ...state, processedIds: new Set(state.processedIds) };
    },
  };

  return harvester;
}

// ── Plugin Definition ────────────────────────────────────────────

export default definePlugin({
  name: "@the-brain-dev/plugin-harvester-claude",
  version: "0.1.0",
  description:
    "Polls Claude Code's ~/.claude/projects/ transcripts and feeds interactions into the the-brain pipeline",

  setup(hooks: PluginHooks) {
    const harvester = createClaudeHarvester(hooks);

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
    (hooks as any)._claudeHarvester = harvester;
  },

  teardown() {
    // Cleanup handled by DAEMON_STOP hook
  },
});

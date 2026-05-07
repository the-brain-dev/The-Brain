/**
 * @the-brain/plugin-harvester-hermes
 *
 * Data harvester that polls Hermes Agent's local state.db
 * (~/.hermes/state.db) and feeds new interactions into the
 * the-brain pipeline.
 *
 * Hermes Agent stores conversations in a SQLite database with:
 *   - sessions: id, source, model, created_at
 *   - messages: id, session_id, role, content, timestamp, token_count
 *
 * Message roles:
 *   - user: prompt from the developer
 *   - assistant: AI response
 *   - session_meta: session metadata (skipped)
 *   - tool: tool call records (skipped)
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import type {
  Interaction,
  InteractionContext,
  MemoryFragment,
  PluginHooks,
} from "@the-brain/core";
import { HookEvent, MemoryLayer, definePlugin } from "@the-brain/core";

// ── Types ────────────────────────────────────────────────────────

interface HermesState {
  lastId: number;
  lastAt: number;
  sessions: string[];
  totalIx: number;
  totalSes: number;
}

interface HermesMessage {
  id: number;
  session_id: string;
  role: string;
  content: string;
  timestamp: number;
  token_count: number | null;
}

interface HermesSession {
  id: string;
  source: string;
  model: string;
}

interface HermesHarvesterConfig {
  /** Polling interval in ms (default: 30000) */
  pollIntervalMs: number;
  /** Override the Hermes DB path */
  dbPath?: string;
  /** Override the home directory (for testing) */
  homeDir?: string;
  /** Maximum interactions per poll */
  maxInteractionsPerPoll: number;
}

// ── Config ───────────────────────────────────────────────────────

const DEFAULT_CONFIG: HermesHarvesterConfig = {
  pollIntervalMs: 30000,
  maxInteractionsPerPoll: 100,
};

// ── Path Resolution ──────────────────────────────────────────────

function getHomeDir(config: HermesHarvesterConfig): string {
  return config.homeDir ?? process.env.HOME ?? homedir();
}

function getHermesDbPath(config: HermesHarvesterConfig): string {
  return config.dbPath ?? join(getHomeDir(config), ".hermes", "state.db");
}

function getStatePath(config: HermesHarvesterConfig): string {
  return join(getHomeDir(config), ".the-brain", "hermes-state.json");
}

// ── State Persistence ────────────────────────────────────────────

function loadState(config: HermesHarvesterConfig): HermesState {
  const path = getStatePath(config);
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as HermesState;
  } catch {
    return { lastId: 0, lastAt: 0, sessions: [], totalIx: 0, totalSes: 0 };
  }
}

function saveState(state: HermesState, config: HermesHarvesterConfig): void {
  const path = getStatePath(config);
  const dir = join(path, "..");
  try { mkdirSync(dir, { recursive: true }); } catch {}
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
}

// ── Database Access ──────────────────────────────────────────────

function openHermesDb(config: HermesHarvesterConfig): Database | null {
  const dbPath = getHermesDbPath(config);
  if (!existsSync(dbPath)) return null;
  return new Database(dbPath, { readonly: true });
}

function loadSessions(db: Database): Record<string, HermesSession> {
  const out: Record<string, HermesSession> = {};
  try {
    const rows = db
      .query("SELECT id, source, model FROM sessions")
      .all() as HermesSession[];
    for (const row of rows) {
      out[row.id] = { id: row.id, source: row.source || "unknown", model: row.model || "unknown" };
    }
  } catch {}
  return out;
}

function getNewMessages(
  db: Database,
  lastId: number,
  limit: number,
): HermesMessage[] {
  try {
    return db
      .query(
        "SELECT id, session_id, role, content, timestamp, token_count " +
        "FROM messages WHERE id > ?1 ORDER BY session_id, timestamp ASC LIMIT ?2",
      )
      .all(lastId, limit) as HermesMessage[];
  } catch {
    return [];
  }
}

// ── Interaction Parsing ──────────────────────────────────────────

/**
 * Pair user→assistant messages from the raw message stream.
 */
function pairMessages(
  msgs: HermesMessage[],
): Record<string, { lastUser: HermesMessage | null; pairs: Array<{ u: HermesMessage; a: HermesMessage }> }> {
  const buf: Record<string, { lastUser: HermesMessage | null; pairs: Array<{ u: HermesMessage; a: HermesMessage }> }> = {};

  for (const m of msgs) {
    if (m.role === "session_meta" || m.role === "tool") continue;

    if (!buf[m.session_id]) {
      buf[m.session_id] = { lastUser: null, pairs: [] };
    }

    if (m.role === "user") {
      buf[m.session_id].lastUser = m;
    } else if (m.role === "assistant" && buf[m.session_id].lastUser) {
      buf[m.session_id].pairs.push({ u: buf[m.session_id].lastUser, a: m });
      buf[m.session_id].lastUser = null;
    }
  }

  return buf;
}

/**
 * Generate a unique hash ID for an interaction.
 */
function hashInteraction(prompt: string, response: string): string {
  return createHash("sha256")
    .update(`${prompt.slice(0, 200)}\n${response.slice(0, 200)}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Build Interaction objects from paired messages.
 */
function buildInteractions(
  buf: Record<string, { lastUser: HermesMessage | null; pairs: Array<{ u: HermesMessage; a: HermesMessage }> }>,
  sessions: Record<string, HermesSession>,
  seen: Set<string>,
): { items: Interaction[]; maxId: number } {
  const out: Interaction[] = [];
  let maxId = 0;

  for (const sessionId of Object.keys(buf)) {
    const ses = sessions[sessionId] || { source: "unknown", model: "unknown" };
    const pairs = buf[sessionId].pairs;

    for (const pair of pairs) {
      const uc = pair.u.content || "";
      const ac = pair.a.content || "";
      const id = hashInteraction(uc, ac);

      if (seen.has(id)) continue;
      seen.add(id);

      if (pair.u.id > maxId) maxId = pair.u.id;
      if (pair.a.id > maxId) maxId = pair.a.id;

      out.push({
        id,
        timestamp: Math.round((pair.u.timestamp || Date.now()) * 1000),
        prompt: uc.slice(0, 2000),
        response: ac.slice(0, 2000),
        source: "hermes-agent",
        metadata: {
          channel: ses.source,
          model: ses.model,
          tokenCount: pair.a.token_count || 0,
        },
      });
    }
  }

  return { items: out, maxId };
}

// ── Harvester Factory ────────────────────────────────────────────

export function createHermesHarvester(
  hooks: PluginHooks,
  config: Partial<HermesHarvesterConfig> = {},
) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let state = loadState(cfg);
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const harvester = {
    async poll(): Promise<InteractionContext[]> {
      const db = openHermesDb(cfg);
      if (!db) return [];

      try {
        const dbSessions = loadSessions(db);
        const knownSessions = new Set(state.sessions);
        const newSessions: string[] = [];

        for (const sid of Object.keys(dbSessions)) {
          if (!knownSessions.has(sid)) {
            newSessions.push(sid);
          }
        }

        const msgs = getNewMessages(db, state.lastId, cfg.maxInteractionsPerPoll);
        if (!msgs.length) return [];

        const seen = new Set(state.sessions);
        const { items, maxId } = buildInteractions(
          pairMessages(msgs),
          dbSessions,
          seen,
        );

        if (!items.length) return [];

        // Emit interactions
        const contexts: InteractionContext[] = [];
        for (const interaction of items) {
          const ctx: InteractionContext = {
            interaction,
            fragments: [
              {
                id: `hermes-${interaction.id}`,
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

        // Update state
        state.lastId = maxId;
        state.lastAt = Date.now();
        for (const sid of newSessions) {
          if (!state.sessions.includes(sid)) {
            state.sessions.push(sid);
          }
        }
        state.totalIx += items.length;
        state.totalSes += newSessions.length;
        saveState(state, cfg);

        return contexts;
      } finally {
        db.close();
      }
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
      saveState(state, cfg);
    },

    getState(): HermesState {
      return { ...state };
    },
  };

  return harvester;
}

// ── Plugin Definition ────────────────────────────────────────────

export default definePlugin({
  name: "@the-brain/plugin-harvester-hermes",
  version: "0.1.0",
  description:
    "Polls Hermes Agent's state.db and feeds interactions into the the-brain pipeline",

  setup(hooks: PluginHooks) {
    const harvester = createHermesHarvester(hooks);

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
    (hooks as any)._hermesHarvester = harvester;
  },

  teardown() {
    // Cleanup handled by DAEMON_STOP hook
  },
});

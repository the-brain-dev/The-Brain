/**
 * @the-brain/plugin-harvester-hermes
 *
 * Polls Hermes Agent's SQLite state.db (~/.hermes/state.db),
 * pairs user→assistant messages into Interaction objects,
 * and emits them into the-brain pipeline.
 *
 * Exports:
 *   default — definePlugin for automatic loading
 *   createHermesHarvester() — factory for direct use / tests
 *   HermesHarvesterConfig — config type
 */

import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  definePlugin,
  HookEvent,
  type PluginHooks,
} from "@the-brain/core";

// ── Types ──────────────────────────────────────────────────────────

export interface HermesHarvesterConfig {
  /** Path to the Hermes state.db (default: ~/.hermes/state.db) */
  hermesDbPath?: string;
  /** Home directory override (for testing) */
  homeDir?: string;
  /** Poll interval in ms */
  pollIntervalMs?: number;
  /** Max prompt/response length (default: 2000) */
  maxContentLength?: number;
}

interface HermesDbMessage {
  id: number;
  session_id: string;
  role: string;
  content: string | null;
  timestamp: number | null;
  token_count: number | null;
}

interface HermesDbSession {
  id: string;
  source: string | null;
  model: string | null;
}

interface PairedInteraction {
  id: string;
  timestamp: number;
  prompt: string;
  response: string;
  channel: string;
  model: string;
  tokens: number;
}

// ── Defaults ───────────────────────────────────────────────────────

const SOURCE = "hermes-agent";

interface HarvesterState {
  lastId: number;
  lastAt: number;
  sessions: string[];
  totalIx: number;
  totalSes: number;
}

const DEFAULT_STATE: HarvesterState = {
  lastId: 0,
  lastAt: 0,
  sessions: [],
  totalIx: 0,
  totalSes: 0,
};

// ── Helpers ────────────────────────────────────────────────────────

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function stateFile(homeDir: string): string {
  return join(homeDir, ".the-brain", "hermes-state.json");
}

function dbPath(homeDir: string, custom?: string): string {
  return custom ?? join(homeDir, ".hermes", "state.db");
}

// ── State I/O ──────────────────────────────────────────────────────

async function loadState(homeDir: string): Promise<HarvesterState> {
  try {
    const raw = await readFile(stateFile(homeDir), "utf-8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

async function saveState(homeDir: string, s: HarvesterState): Promise<void> {
  const f = stateFile(homeDir);
  const dir = join(homeDir, ".the-brain");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await writeFile(f, JSON.stringify(s, null, 2));
}

// ── DB Access ──────────────────────────────────────────────────────

function openDb(path: string): Database | null {
  if (!existsSync(path)) return null;
  try {
    return new Database(path, { readonly: true });
  } catch {
    return null;
  }
}

function loadSessions(db: Database): Map<string, HermesDbSession> {
  const map = new Map<string, HermesDbSession>();
  try {
    const rows = db
      .query("SELECT id, source, model FROM sessions")
      .all() as HermesDbSession[];
    for (const r of rows) map.set(r.id, r);
  } catch {
    // empty
  }
  return map;
}

function getNewMessages(
  db: Database,
  lastId: number
): HermesDbMessage[] {
  try {
    return db
      .query(
        "SELECT id, session_id, role, content, timestamp, token_count " +
          "FROM messages WHERE id > ?1 ORDER BY session_id, timestamp ASC LIMIT 500"
      )
      .all(lastId) as HermesDbMessage[];
  } catch {
    return [];
  }
}

// ── Pairing ────────────────────────────────────────────────────────

interface PairBuffer {
  lastUser: HermesDbMessage | null;
  pairs: Array<{ u: HermesDbMessage; a: HermesDbMessage }>;
}

function pairMessages(msgs: HermesDbMessage[]): Map<string, PairBuffer> {
  const buf = new Map<string, PairBuffer>();

  for (const m of msgs) {
    if (m.role === "session_meta" || m.role === "tool") continue;

    let slot = buf.get(m.session_id);
    if (!slot) {
      slot = { lastUser: null, pairs: [] };
      buf.set(m.session_id, slot);
    }

    if (m.role === "user") {
      slot.lastUser = m;
    } else if (m.role === "assistant" && slot.lastUser) {
      slot.pairs.push({ u: slot.lastUser, a: m });
      slot.lastUser = null;
    }
  }

  return buf;
}

function buildInteractions(
  buf: Map<string, PairBuffer>,
  sessions: Map<string, HermesDbSession>,
  seen: Set<string>,
  maxLen: number
): { items: PairedInteraction[]; maxId: number } {
  const items: PairedInteraction[] = [];
  let maxId = 0;

  for (const [sid, slot] of buf) {
    const ses = sessions.get(sid);
    const channel = ses?.source ?? "unknown";
    const model = ses?.model ?? "unknown";

    for (const p of slot.pairs) {
      const uc = p.u.content ?? "";
      const ac = p.a.content ?? "";
      const id = sha256(uc.slice(0, 200) + ac.slice(0, 200) + String(p.u.id));
      if (seen.has(id)) continue;
      seen.add(id);

      if (p.u.id > maxId) maxId = p.u.id;
      if (p.a.id > maxId) maxId = p.a.id;

      items.push({
        id,
        timestamp: Math.round((p.u.timestamp ?? Date.now()) * 1000),
        prompt: uc.slice(0, maxLen),
        response: ac.slice(0, maxLen),
        channel,
        model,
        tokens: p.a.token_count ?? 0,
      });
    }
  }

  return { items, maxId };
}

// ── Emit into pipeline ─────────────────────────────────────────────

async function emitAll(
  hooks: PluginHooks,
  interactions: PairedInteraction[]
): Promise<void> {
  for (const ix of interactions) {
    const ctx = {
      interaction: {
        id: ix.id,
        timestamp: ix.timestamp,
        prompt: ix.prompt,
        response: ix.response,
        source: SOURCE,
        metadata: { channel: ix.channel, model: ix.model, tokenCount: ix.tokens },
      },
      fragments: [
        {
          id: `frag-${ix.id}`,
          layer: "instant" as const,
          content: `Prompt: ${ix.prompt}\n\nResponse: ${ix.response}`,
          timestamp: ix.timestamp,
          source: SOURCE,
          metadata: { channel: ix.channel, model: ix.model },
        },
      ],
      promoteToDeep() {
        // no-op: SPM curator handles promotion
      },
    };

    try {
      await hooks.callHook(HookEvent.HARVESTER_NEW_DATA, ctx);
      await hooks.callHook(HookEvent.ON_INTERACTION, ctx);
    } catch {
      // skip on error
    }
  }
}

// ── Harvester Factory ──────────────────────────────────────────────

export interface InteractionContext {
  interaction: {
    id: string;
    timestamp: number;
    prompt: string;
    response: string;
    source: string;
    metadata?: Record<string, unknown>;
  };
  fragments: Array<{
    id: string;
    layer: string;
    content: string;
    timestamp: number;
    source: string;
    metadata?: Record<string, unknown>;
  }>;
  promoteToDeep: () => void;
}

export interface HermesHarvester {
  name: string;
  start(): void;
  stop(): void;
  poll(): Promise<InteractionContext[]>;
  getState(): HarvesterState;
}

export function createHermesHarvester(
  hooks: PluginHooks,
  config?: HermesHarvesterConfig
): HermesHarvester {
  const homeDir = config?.homeDir ?? homedir();
  const maxLen = config?.maxContentLength ?? 2000;
  const hermesDb = dbPath(homeDir, config?.hermesDbPath);

  let running = false;

  return {
    name: "harvester-hermes",

    start() {
      running = true;
    },

    stop() {
      running = false;
    },

    async poll(): Promise<InteractionContext[]> {
      const db = openDb(hermesDb);
      if (!db) return [];

      try {
        const state = await loadState(homeDir);
        const seen = new Set(state.sessions);
        const sessions = loadSessions(db);

        // Track new sessions
        const newSessions: string[] = [];
        const sessionIdSet = new Set(state.sessions);
        for (const id of sessions.keys()) {
          if (!sessionIdSet.has(id)) {
            newSessions.push(id);
            sessionIdSet.add(id);
          }
        }

        // Dedup interactions by ID hash (separate from session tracking)
        const dedup = new Set(state.sessions);

        const msgs = getNewMessages(db, state.lastId);
        if (msgs.length === 0 && newSessions.length === 0) return [];

        const buf = pairMessages(msgs);
        const { items, maxId } = buildInteractions(buf, sessions, dedup, maxLen);
        if (items.length === 0) return [];

        // Build contexts for return
        const contexts: InteractionContext[] = items.map((ix) => ({
          interaction: {
            id: ix.id,
            timestamp: ix.timestamp,
            prompt: ix.prompt,
            response: ix.response,
            source: SOURCE,
            metadata: { channel: ix.channel, model: ix.model, tokenCount: ix.tokens },
          },
          fragments: [
            {
              id: `frag-${ix.id}`,
              layer: "instant",
              content: `Prompt: ${ix.prompt}\n\nResponse: ${ix.response}`,
              timestamp: ix.timestamp,
              source: SOURCE,
              metadata: { channel: ix.channel, model: ix.model },
            },
          ],
          promoteToDeep() {},
        }));

        // Save state
        const updated: HarvesterState = {
          lastId: maxId > 0 ? maxId : state.lastId,
          lastAt: Date.now(),
          sessions: Array.from(sessionIdSet),
          totalIx: state.totalIx + items.length,
          totalSes: state.totalSes + newSessions.length,
        };
        await saveState(homeDir, updated);

        // Emit into pipeline
        await emitAll(hooks, items);

        return contexts;
      } finally {
        db.close();
      }
    },

    getState(): HarvesterState {
      // Note: returns current in-memory state (may not reflect latest disk write)
      // For perfect accuracy, callers should re-read from disk.
      // This is kept sync for convenience — the state was just saved in poll().
      try {
        const raw = require("node:fs").readFileSync(stateFile(homeDir), "utf-8");
        return { ...DEFAULT_STATE, ...JSON.parse(raw) };
      } catch {
        return { ...DEFAULT_STATE };
      }
    },
  };
}

// ── Plugin Definition ──────────────────────────────────────────────

const PLUGIN_NAME = "plugin-harvester-hermes";

export default definePlugin({
  name: PLUGIN_NAME,
  version: "0.1.0",
  description: "Harvests interactions from Hermes Agent state.db",

  setup(hooks: PluginHooks): void {
    const harvester = createHermesHarvester(hooks);
    (hooks as any)[PLUGIN_NAME] = harvester;

    hooks.hook(HookEvent.DAEMON_START, async () => {
      harvester.start();
    });

    hooks.hook(HookEvent.DAEMON_STOP, async () => {
      harvester.stop();
    });

    hooks.hook(HookEvent.HARVESTER_POLL, async () => {
      const contexts = await harvester.poll();
      if (contexts.length > 0) {
        console.log(
          `[hermes] Harvested ${contexts.length} interaction(s) from ${SOURCE}`
        );
      }
    });
  },

  async teardown(): Promise<void> {
    // cleanup
  },
});

// ── Re-exports ─────────────────────────────────────────────────────

export type { HermesHarvesterConfig, HarvesterState };

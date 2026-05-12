/**
 * @the-brain-dev/plugin-harvester-windsurf
 *
 * Data harvester for Windsurf IDE's Cascade conversation history.
 *
 * Data source: Windsurf stores trajectories as base64-encoded protobuf
 * blobs inside the codeium.windsurf JSON key in state.vscdb:
 *   ~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb
 *
 * Keys: windsurf.state.cachedActiveTrajectory:<workspace_id>
 *
 * Protobuf structure (wire-format):
 *   Top-level: f1=UUID (string), f2=steps container (repeated message)
 *   Step: f1=step_id (varint), f4=step_type, f5=metadata{Timestamp},
 *         f19=user_message, f20=AI_response, f28=tool_result
 *   AI response (f20): f3=thinking, f7=tool_call{f1=id,f2=name,f3=params},
 *                      f8=visible, f12=provider
 *
 * Strategy:
 *   1. Open state.vscdb, read codeium.windsurf JSON
 *   2. Find all cachedActiveTrajectory:* keys → workspace IDs
 *   3. Decode base64 blob, parse wire-format protobuf
 *   4. Pair consecutive user (f19) → AI response (f20) messages
 *   5. Deduplicate by SHA-256 hash of (prompt + response)
 *   6. Detect project from workspace.json in workspaceStorage/
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import type {
  Interaction,
  InteractionContext,
  MemoryFragment,
  PluginHooks,
} from "@the-brain-dev/core";
import { HookEvent, MemoryLayer, definePlugin } from "@the-brain-dev/core";

// ── Types ────────────────────────────────────────────────────────

interface WindsurfState {
  lastPollTimestamp: number;
  /** SHA-256 hash of (prompt\x00response) truncated to 16 hex */
  processedIds: Set<string>;
  /** Per-workspace trajectory blob sizes for change detection */
  trajectorySizes: Record<string, number>;
}

interface ParsedField {
  fn: number;       // field number
  type: "varint" | "bytes" | "fixed64" | "fixed32";
  value?: number;   // for varint / fixed
  start?: number;   // byte offset in buffer (for bytes type)
  end?: number;      // byte offset end
}

interface WindsurfHarvesterConfig {
  pollIntervalMs: number;
  maxInteractionsPerPoll: number;
}

const DEFAULT_CONFIG: WindsurfHarvesterConfig = {
  pollIntervalMs: 30_000,
  maxInteractionsPerPoll: 100,
};

// ── Path Resolution ──────────────────────────────────────────────

function getHomeDir(): string {
  return process.env.HOME || homedir();
}

function getWindsurfBasePath(): string {
  const home = getHomeDir();
  const system = platform();

  let base: string;
  if (system === "darwin") {
    base = join(home, "Library", "Application Support");
  } else if (system === "linux") {
    base = join(home, ".config");
  } else {
    base = join(home, "AppData", "Roaming");
  }

  // Try "Windsurf - Next" first, then "Windsurf"
  const variants = ["Windsurf - Next", "Windsurf"];
  for (const variant of variants) {
    const dbPath = join(base, variant, "User", "globalStorage", "state.vscdb");
    if (existsSync(dbPath)) {
      return join(base, variant);
    }
  }

  return join(base, "Windsurf"); // fallback
}

function getStateDbPath(basePath: string): string {
  return join(basePath, "User", "globalStorage", "state.vscdb");
}

function getWorkspaceStoragePath(basePath: string): string {
  return join(basePath, "User", "workspaceStorage");
}

function getStatePath(): string {
  const dir = join(getHomeDir(), ".the-brain");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
  return join(dir, "windsurf-harvester-state.json");
}

// ── State Management ─────────────────────────────────────────────

function loadState(): WindsurfState {
  const path = getStatePath();
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);
    return {
      lastPollTimestamp: data.lastPollTimestamp ?? 0,
      processedIds: new Set(data.processedIds ?? []),
      trajectorySizes: data.trajectorySizes ?? {},
    };
  } catch {
    return {
      lastPollTimestamp: 0,
      processedIds: new Set(),
      trajectorySizes: {},
    };
  }
}

function saveState(state: WindsurfState): void {
  const path = getStatePath();
  try {
    writeFileSync(
      path,
      JSON.stringify(
        {
          lastPollTimestamp: state.lastPollTimestamp,
          processedIds: Array.from(state.processedIds).slice(-10_000),
          trajectorySizes: state.trajectorySizes,
        },
        null,
        2
      ),
      "utf-8"
    );
  } catch {}
}

// ── Protobuf Wire-Format Decoder ─────────────────────────────────
//
// Exported for testing. These are the core parsing primitives used
// to decode Windsurf's base64-encoded trajectory protobuf blobs.

/**
 * Decode a protobuf varint from the buffer at position `pos`.
 * Returns [value, new_position].
 */
export function decodeVarint(data: Buffer | Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  while (pos < data.length) {
    const b = data[pos];
    result |= (b & 0x7f) << shift;
    pos++;
    if ((b & 0x80) === 0) {
      return [result >>> 0, pos];
    }
    shift += 7;
  }
  return [0, pos];
}

/**
 * Parse protobuf wire-format fields from a byte range.
 * Returns array of parsed fields (shallow — does not recurse into bytes).
 */
export function parseFields(
  data: Buffer | Uint8Array,
  start: number,
  end: number
): ParsedField[] {
  const fields: ParsedField[] = [];
  let p = start;

  while (p < end) {
    const [tag, np] = decodeVarint(data, p);
    if (tag === 0) {
      p = np;
      continue;
    }
    const fn = tag >>> 3;
    const wt = tag & 7;
    p = np;

    if (wt === 0) {
      // Varint
      const [val, vp] = decodeVarint(data, p);
      fields.push({ fn, type: "varint", value: val });
      p = vp;
    } else if (wt === 2) {
      // Length-delimited
      const [sz, sp] = decodeVarint(data, p);
      const bytesStart = sp;
      const bytesEnd = sp + sz;
      if (bytesEnd > end || sz < 0) break;
      fields.push({ fn, type: "bytes", start: bytesStart, end: bytesEnd });
      p = bytesEnd;
    } else if (wt === 1) {
      // Fixed64 (little-endian) — use BigInt to avoid overflow
      const view = new DataView(data.buffer.slice(data.byteOffset + p, data.byteOffset + p + 8));
      const val = Number(view.getBigUint64(0, true));
      fields.push({ fn, type: "fixed64", value: val });
      p += 8;
    } else if (wt === 5) {
      // Fixed32 (little-endian)
      const val = data[p]
        | (data[p + 1] << 8)
        | (data[p + 2] << 16)
        | (data[p + 3] << 24);
      fields.push({ fn, type: "fixed32", value: val >>> 0 });
      p += 4;
    } else {
      break;
    }
  }

  return fields;
}

/**
 * Decode a protobuf Timestamp message {f1=seconds, f2=nanos} → unix ms.
 */
export function decodeTimestamp(
  data: Buffer | Uint8Array,
  start: number,
  end: number
): number | null {
  const fields = parseFields(data, start, end);
  let seconds = 0;
  let nanos = 0;

  for (const f of fields) {
    if (f.fn === 1 && f.type === "varint" && f.value !== undefined) {
      seconds = f.value;
    } else if (f.fn === 2 && f.type === "varint" && f.value !== undefined) {
      nanos = f.value;
    }
  }

  // Sanity check: timestamp in range 2020-2040
  if (seconds > 1577836800 && seconds < 2208988800) {
    return seconds * 1000 + Math.floor(nanos / 1e6);
  }
  return null;
}

/**
 * Try to decode bytes as UTF-8 string.
 */
export function tryDecodeStr(
  data: Buffer | Uint8Array,
  start: number,
  end: number
): string | null {
  try {
    return Buffer.from(data.slice(start, end)).toString("utf-8");
  } catch {
    return null;
  }
}

/**
 * Parse a tool call sub-message from the AI response (f20.f7).
 * Structure: f1=tool_id (string), f2=tool_name (string), f3=params_json (string).
 */
export function parseToolCall(
  data: Buffer | Uint8Array,
  start: number,
  end: number
): { toolId: string; toolName: string; params: unknown } | null {
  const fields = parseFields(data, start, end);
  const tc: { toolId?: string; toolName?: string; params?: unknown } = {};

  for (const f of fields) {
    if (f.type !== "bytes" || f.start === undefined || f.end === undefined)
      continue;

    const text = tryDecodeStr(data, f.start, f.end);
    if (!text) continue;

    if (f.fn === 1) {
      tc.toolId = text;
    } else if (f.fn === 2) {
      tc.toolName = text;
    } else if (f.fn === 3) {
      try {
        tc.params = JSON.parse(text);
      } catch {
        tc.params = text.slice(0, 500);
      }
    }
  }

  if (tc.toolName) {
    return {
      toolId: tc.toolId || "",
      toolName: tc.toolName,
      params: tc.params || {},
    };
  }
  return null;
}

/**
 * Parse a user message (f19) — extract text content from nested fields.
 */
export function parseUserMessage(
  data: Buffer | Uint8Array,
  start: number,
  end: number
): string | null {
  const fields = parseFields(data, start, end);
  for (const f of fields) {
    if (
      f.type === "bytes" &&
      f.start !== undefined &&
      f.end !== undefined
    ) {
      const text = tryDecodeStr(data, f.start, f.end);
      if (text && text.length > 0) {
        return text;
      }
    }
  }
  return null;
}

/**
 * Parse AI response (f20) — extract thinking, visible text, tool calls, provider.
 */
export function parseAiResponse(
  data: Buffer | Uint8Array,
  start: number,
  end: number
): {
  thinking: string | null;
  visible: string | null;
  provider: string | null;
  toolCalls: Array<{ toolId: string; toolName: string; params: unknown }>;
} {
  const result = {
    thinking: null as string | null,
    visible: null as string | null,
    provider: null as string | null,
    toolCalls: [] as Array<{ toolId: string; toolName: string; params: unknown }>,
  };

  const fields = parseFields(data, start, end);

  for (const f of fields) {
    if (f.type !== "bytes" || f.start === undefined || f.end === undefined)
      continue;

    if (f.fn === 3) {
      // thinking
      result.thinking = tryDecodeStr(data, f.start, f.end);
    } else if (f.fn === 7) {
      // tool call
      const tc = parseToolCall(data, f.start, f.end);
      if (tc) result.toolCalls.push(tc);
    } else if (f.fn === 8) {
      // visible response
      result.visible = tryDecodeStr(data, f.start, f.end);
    } else if (f.fn === 12) {
      // provider
      result.provider = tryDecodeStr(data, f.start, f.end);
    }
  }

  return result;
}

// ── Trajectory Extraction ────────────────────────────────────────

/**
 * Extract interaction pairs from a Windsurf trajectory protobuf blob.
 *
 * The trajectory is a JSON-encoded base64 string (from codeium.windsurf state).
 * We decode base64 → bytes, then parse wire-format protobuf.
 *
 * Each step in the trajectory has:
 *   f1=step_id, f4=step_type, f5=timestamp,
 *   f19=user_message, f20=AI_response, f28=tool_result
 *
 * We pair consecutive [user_message → AI_response] steps.
 * Tool results (f28) and standalone AI messages are skipped.
 */
export function extractFromTrajectory(
  base64Blob: string,
  state: WindsurfState,
  workspacePath: string
): Interaction[] {
  const interactions: Interaction[] = [];

  // Decode base64
  let blob: Buffer;
  try {
    blob = Buffer.from(base64Blob, "base64");
  } catch {
    return interactions;
  }

  // Parse top-level: f1=UUID, f2=steps
  const top = parseFields(blob, 0, blob.length);
  let stepsStart = 0;
  let stepsEnd = 0;

  for (const f of top) {
    if (
      f.fn === 2 &&
      f.type === "bytes" &&
      f.start !== undefined &&
      f.end !== undefined
    ) {
      stepsStart = f.start;
      stepsEnd = f.end;
    }
  }

  if (stepsStart === stepsEnd) return interactions;

  // Parse individual steps
  const stepFields = parseFields(blob, stepsStart, stepsEnd);

  // Buffer for pairing: collect consecutive f19→f20 pairs
  let currentUser: {
    text: string;
    timestamp: number;
    stepId: number;
  } | null = null;

  for (const sf of stepFields) {
    if (
      sf.type !== "bytes" ||
      sf.start === undefined ||
      sf.end === undefined
    )
      continue;

    const stepSub = parseFields(blob, sf.start, sf.end);

    let stepId: number | null = null;
    let stepType: number | null = null;
    let timestamp: number | null = null;
    let aiStart: number | null = null;
    let aiEnd: number | null = null;
    let userStart: number | null = null;
    let userEnd: number | null = null;

    for (const ss of stepSub) {
      if (ss.fn === 1 && ss.type === "varint" && ss.value !== undefined) {
        stepId = ss.value;
      } else if (ss.fn === 4 && ss.type === "varint" && ss.value !== undefined) {
        stepType = ss.value;
      } else if (
        ss.fn === 5 &&
        ss.type === "bytes" &&
        ss.start !== undefined &&
        ss.end !== undefined
      ) {
        // Timestamp in metadata message
        timestamp = decodeTimestamp(blob, ss.start, ss.end);
      } else if (
        ss.fn === 19 &&
        ss.type === "bytes" &&
        ss.start !== undefined &&
        ss.end !== undefined
      ) {
        userStart = ss.start;
        userEnd = ss.end;
      } else if (
        ss.fn === 20 &&
        ss.type === "bytes" &&
        ss.start !== undefined &&
        ss.end !== undefined
      ) {
        aiStart = ss.start;
        aiEnd = ss.end;
      }
    }

    // If we encounter a user message, handle it
    if (userStart !== null && userEnd !== null) {
      // Flush any pending pair (standalone user message)
      currentUser = null;

      const userText = parseUserMessage(blob, userStart, userEnd);
      if (userText && stepId !== null) {
        currentUser = {
          text: userText,
          timestamp: timestamp ?? Date.now(),
          stepId,
        };
      }
    }

    // If we encounter an AI response and have a pending user, pair them
    if (aiStart !== null && aiEnd !== null && currentUser) {
      const ai = parseAiResponse(blob, aiStart, aiEnd);

      const prompt = currentUser.text;
      const response = ai.visible || ai.thinking || "";
      const ts = timestamp ?? currentUser.timestamp;

      if (prompt && response) {
        const hash = createHash("sha256")
          .update(prompt + "\x00" + response)
          .digest("hex")
          .slice(0, 16);

        if (!state.processedIds.has(hash)) {
          interactions.push({
            id: `windsurf-${hash}`,
            timestamp: ts,
            prompt,
            response,
            source: "windsurf",
            metadata: {
              stepId: currentUser.stepId,
              stepType,
              provider: ai.provider,
              toolCalls: ai.toolCalls.map((tc) => tc.toolName),
              workspace: workspacePath,
            },
            // Include thinking for richer context
            ...(ai.thinking ? { context: `[thinking] ${ai.thinking.slice(0, 1000)}` } : {}),
          });
          state.processedIds.add(hash);
        }
      }

      currentUser = null;
    }
  }

  return interactions;
}

// ── Project Detection ────────────────────────────────────────────

interface DiscoveredWorkspace {
  id: string;
  path: string;   // resolved project folder path
}

/**
 * Discover Windsurf workspaces from workspaceStorage.
 */
function discoverWorkspaces(wsStoragePath: string): DiscoveredWorkspace[] {
  const workspaces: DiscoveredWorkspace[] = [];

  try {
    const entries = readdirSync(wsStoragePath);

    for (const entry of entries) {
      const wsDir = join(wsStoragePath, entry);
      const wsJson = join(wsDir, "workspace.json");

      if (!existsSync(wsJson)) continue;

      try {
        const raw = readFileSync(wsJson, "utf-8");
        const data = JSON.parse(raw);
        const folder = data.folder || data.workspace || "";

        // Decode file:// URI
        let path = folder;
        if (path.startsWith("file://")) {
          path = decodeURIComponent(path.slice(7));
        }
        // On macOS, strip the leading slash from file:/// -> /
        if (platform() === "darwin" && path.startsWith("/")) {
          // file:/// -> three slashes, decoded gives one leading slash
        }

        if (path) {
          workspaces.push({ id: entry, path });
        }
      } catch {
        // Skip malformed workspace
      }
    }
  } catch {
    // workspaceStorage might not exist
  }

  return workspaces;
}

// ── Plugin Definition ────────────────────────────────────────────

export function createWindsurfHarvester(
  hooks: PluginHooks,
  config: Partial<WindsurfHarvesterConfig> = {}
) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let state = loadState();
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const harvester = {
    async poll(): Promise<InteractionContext[]> {
      const basePath = getWindsurfBasePath();
      const stateDbPath = getStateDbPath(basePath);

      if (!existsSync(stateDbPath)) return [];

      let db: Database;
      try {
        db = new Database(stateDbPath, { readonly: true });
      } catch {
        return [];
      }

      // 1. Read the codeium.windsurf JSON
      let codeiumJson: Record<string, unknown>;
      try {
        const row = db
          .query("SELECT value FROM ItemTable WHERE key = 'codeium.windsurf'")
          .get() as { value: string } | undefined;

        if (!row) {
          db.close();
          return [];
        }
        codeiumJson = JSON.parse(row.value);
      } catch {
        try { db.close(); } catch {}
        return [];
      }

      // 2. Find all cachedActiveTrajectory keys
      const trajectoryKeys = Object.keys(codeiumJson).filter((k) =>
        k.startsWith("windsurf.state.cachedActiveTrajectory:")
      );

      if (trajectoryKeys.length === 0) {
        db.close();
        return [];
      }

      // 3. Discover workspaces for project detection
      const wsStoragePath = getWorkspaceStoragePath(basePath);
      const workspaces = discoverWorkspaces(wsStoragePath);
      const wsMap = new Map<string, string>(); // wsId → folder path
      for (const ws of workspaces) {
        wsMap.set(ws.id, ws.path);
      }

      // 4. Process each workspace's trajectory
      const allInteractions: Interaction[] = [];

      for (const key of trajectoryKeys) {
        if (allInteractions.length >= cfg.maxInteractionsPerPoll) break;

        const wsId = key.split(":").pop() || "";
        const blob = codeiumJson[key] as string;

        if (!blob || typeof blob !== "string") continue;

        // Skip if trajectory hasn't changed size
        const prevSize = state.trajectorySizes[wsId];
        const currSize = blob.length;
        if (prevSize === currSize) continue;

        try {
          const interactions = extractFromTrajectory(
            blob,
            state,
            wsMap.get(wsId) || ""
          );

          // Tag with workspace path for project detection
          const workspacePath = wsMap.get(wsId) || "";
          for (const ix of interactions) {
            ix.metadata = {
              ...((ix.metadata as Record<string, unknown>) || {}),
              project: workspacePath,
            };
          }

          allInteractions.push(...interactions);
          state.trajectorySizes[wsId] = currSize;
        } catch {
          // Skip problematic trajectories
        }
      }

      db.close();

      // 5. Deduplicate within batch
      const seen = new Set<string>();
      const uniqueInteractions = allInteractions.filter((i) => {
        if (seen.has(i.id)) return false;
        seen.add(i.id);
        return true;
      });

      // 6. Update state
      state.lastPollTimestamp = Date.now();

      // 7. Emit interactions
      const contexts: InteractionContext[] = [];
      for (const interaction of uniqueInteractions) {
        const ctx: InteractionContext = {
          interaction,
          fragments: [
            {
              id: `wind-${interaction.id}`,
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

      // 8. Persist state
      saveState(state);

      return contexts;
    },

    start(): void {
      if (running) return;
      running = true;

      this.poll().catch(() => {});

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

    getState(): WindsurfState {
      return {
        ...state,
        processedIds: new Set(state.processedIds),
      };
    },
  };

  return harvester;
}

// ── Plugin Export ────────────────────────────────────────────────

export default definePlugin({
  name: "@the-brain-dev/plugin-harvester-windsurf",
  version: "0.1.0",
  description:
    "Polls Windsurf IDE's state.vscdb for Cascade conversation trajectories and feeds interactions into the the-brain pipeline",

  setup(hooks: PluginHooks) {
    const harvester = createWindsurfHarvester(hooks);

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
    (hooks as Record<string, unknown>)._windsurfHarvester = harvester;
  },

  teardown() {
    // Cleanup handled by DAEMON_STOP hook
  },
});

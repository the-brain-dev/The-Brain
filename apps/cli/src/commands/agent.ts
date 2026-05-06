/**
 * agent command — Lightweight remote client agent.
 *
 * Runs on the developer's machine, polls IDE logs (Cursor, Claude Code),
 * and pushes new interactions to a remote the-brain server.
 *
 * Usage:
 *   the-brain agent
 *   the-brain agent --once          Run one poll cycle and exit
 *   the-brain agent --interval 30   Poll every 30 seconds (default: 60)
 *
 * Environment:
 *   THE_BRAIN_REMOTE_URL    — Remote server URL (required)
 *   THE_BRAIN_AUTH_TOKEN    — Auth token from `the-brain init --remote`
 */

import { consola } from "consola";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import type { Interaction } from "@the-brain/core";

// ── State ──────────────────────────────────────────────────────

interface AgentState {
  lastPollTimestamp: number;
  processedIds: string[];
  /** Per-harvester offset tracking */
  harvesters: Record<string, { lastOffset: number; lastTimestamp: number }>;
}

const STATE_DIR = join(process.env.HOME || "~", ".the-brain");
const STATE_PATH = join(STATE_DIR, "agent-state.json");

function loadState(): AgentState {
  try {
    if (existsSync(STATE_PATH)) {
      return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    }
  } catch {}
  return { lastPollTimestamp: 0, processedIds: [], harvesters: {} };
}

function saveState(state: AgentState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ── ID hashing (consistent with dedup logic) ──────────────────

function hashContent(prompt: string, response: string): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(prompt + "\x00" + response).digest("hex");
}

// ── Cursor Log Parser ─────────────────────────────────────────

function parseCursorLogs(since: number): Interaction[] {
  const interactions: Interaction[] = [];
  const workspaceStorage = join(
    homedir(), "Library", "Application Support", "Cursor",
    "User", "workspaceStorage"
  );

  if (!existsSync(workspaceStorage)) return interactions;

  const workspaces = readdirSync(workspaceStorage, { withFileTypes: true })
    .filter(d => d.isDirectory());

  for (const ws of workspaces) {
    const statePath = join(workspaceStorage, ws.name, "state.vscdb");
    if (!existsSync(statePath)) continue;

    try {
      const db = new Database(statePath);
      // Cursor stores AI chat in the vscode SQLite DB
      const rows = db.query(
        `SELECT key, value FROM ItemTable WHERE key LIKE 'aiChat.%' AND key NOT LIKE '%.metadata'`
      ).all() as Array<{ key: string; value: string }>;

      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.value);
          if (!parsed || !parsed.messages) continue;

          for (const msg of parsed.messages) {
            const ts = msg.timestamp ?? Date.now();
            if (ts <= since) continue;

            const id = hashContent(
              msg.prompt ?? msg.text ?? "",
              msg.response ?? msg.assistantText ?? ""
            );

            if (interactions.some(i => i.id === id)) continue;

            interactions.push({
              id,
              timestamp: ts,
              prompt: msg.prompt ?? msg.text ?? "",
              response: msg.response ?? msg.assistantText ?? "",
              source: "cursor",
              metadata: { workspace: ws.name },
            });
          }
        } catch {}
      }
      db.close();
    } catch {}
  }

  return interactions;
}

// ── Claude Code Log Parser ────────────────────────────────────

function parseClaudeLogs(since: number): Interaction[] {
  const interactions: Interaction[] = [];
  const claudeDir = join(homedir(), ".claude", "projects");

  if (!existsSync(claudeDir)) return interactions;

  try {
    const projects = readdirSync(claudeDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const proj of projects) {
      const projPath = join(claudeDir, proj.name);
      const files = readdirSync(projPath).filter(f => f.endsWith(".jsonl"));

      for (const file of files) {
        const content = readFileSync(join(projPath, file), "utf-8");
        const lines = content.split("\n").filter(Boolean);

        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now();
            if (ts <= since) continue;
            if (msg.type !== "user" && msg.type !== "assistant") continue;

            // Collect user+assistant pairs per session
            if (msg.type === "user") {
              const text = msg.message?.content?.[0]?.text ?? "";
              const id = hashContent(text, "");

              if (!interactions.some(i => i.id === id)) {
                interactions.push({
                  id,
                  timestamp: ts,
                  prompt: text,
                  response: "",
                  source: "claude",
                  metadata: { project: proj.name, sessionId: msg.sessionId },
                });
              }
            }
          } catch {}
        }
      }
    }
  } catch {}

  return interactions;
}

// ── Windsurf Log Parser ──────────────────────────────────────

function parseWindsurfLogs(since: number): Interaction[] {
  const interactions: Interaction[] = [];
  // Windsurf stores conversations in ~/.codeium/windsurf/conversations/
  const windsurfDir = join(homedir(), ".codeium", "windsurf", "conversations");

  if (!existsSync(windsurfDir)) return interactions;

  try {
    const files = readdirSync(windsurfDir).filter(f => f.endsWith(".json"));

    for (const file of files) {
      try {
        const content = readFileSync(join(windsurfDir, file), "utf-8");
        const data = JSON.parse(content);

        // Windsurf format: { id, title, messages: [{ role, content, timestamp }] }
        const messages = data.messages ?? [];
        for (const msg of messages) {
          const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now();
          if (ts <= since) continue;

          const role = msg.role ?? "";
          if (role !== "user" && role !== "assistant") continue;

          const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
          if (!text.trim()) continue;

          const id = hashContent(text.slice(0, 200), "");
          if (interactions.some(i => i.id === id)) continue;

          if (role === "user") {
            interactions.push({
              id,
              timestamp: ts,
              prompt: text,
              response: "",
              source: "windsurf",
              metadata: { conversationId: data.id, title: data.title },
            });
          }
        }
      } catch {}
    }
  } catch {}

  return interactions;
}

// ── HTTP Push ──────────────────────────────────────────────────

async function pushInteractions(
  remoteUrl: string,
  authToken: string,
  interactions: Interaction[],
): Promise<{ pushed: number; errors: number }> {
  let pushed = 0;
  let errors = 0;

  for (const interaction of interactions) {
    try {
      const res = await fetch(`${remoteUrl}/api/ingest-interaction`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          interaction: {
            id: interaction.id,
            timestamp: interaction.timestamp,
            prompt: interaction.prompt,
            response: interaction.response,
            source: interaction.source,
          },
        }),
      });

      if (res.ok) {
        pushed++;
      } else {
        errors++;
        consola.debug(`Push failed (${res.status}): ${interaction.id}`);
      }
    } catch {
      errors++;
    }
  }

  return { pushed, errors };
}

// ── Main Agent Loop ────────────────────────────────────────────

export async function agentCommand(options: {
  once?: boolean;
  interval?: number;
}) {
  const remoteUrl = process.env.THE_BRAIN_REMOTE_URL;
  const authToken = process.env.THE_BRAIN_AUTH_TOKEN;

  if (!remoteUrl || !authToken) {
    consola.error(
      "THE_BRAIN_REMOTE_URL and THE_BRAIN_AUTH_TOKEN environment variables are required.\n" +
      "Set them from the server's `the-brain init --remote` output."
    );
    process.exit(1);
  }

  consola.info(`Agent connecting to ${remoteUrl}`);
  const state = loadState();
  let pollCount = 0;

  const poll = async () => {
    pollCount++;
    const since = state.lastPollTimestamp || Date.now() - 3600_000;

    consola.debug(`Poll #${pollCount} — collecting interactions since ${new Date(since).toISOString()}`);

    // Collect from all sources
    const allInteractions: Interaction[] = [
      ...parseCursorLogs(since),
      ...parseClaudeLogs(since),
      ...parseWindsurfLogs(since),
    ];

    // Deduplicate against processedIds
    const newInteractions = allInteractions.filter(
      i => !state.processedIds.includes(i.id)
    );

    if (newInteractions.length === 0) {
      consola.debug("No new interactions");
      state.lastPollTimestamp = Date.now();
      saveState(state);
      return;
    }

    consola.info(`Found ${newInteractions.length} new interactions, pushing...`);

    // Push to remote
    const { pushed, errors } = await pushInteractions(remoteUrl, authToken, newInteractions);

    // Update state
    state.lastPollTimestamp = Date.now();
    state.processedIds.push(...newInteractions.map(i => i.id));
    // Keep only last 10k IDs
    if (state.processedIds.length > 10_000) {
      state.processedIds = state.processedIds.slice(-5_000);
    }

    saveState(state);
    consola.success(`Pushed ${pushed}/${newInteractions.length} interactions${errors > 0 ? ` (${errors} errors)` : ""}`);
  };

  // Initial poll
  await poll();

  if (options.once) {
    consola.info("One-shot mode — exiting");
    return;
  }

  // Recurring
  const intervalMs = (options.interval ?? 60) * 1000;
  consola.info(`Polling every ${intervalMs / 1000}s. Press Ctrl+C to stop.`);

  const timer = setInterval(poll, intervalMs);

  process.on("SIGINT", () => {
    clearInterval(timer);
    consola.info("Agent stopped");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    clearInterval(timer);
    process.exit(0);
  });

  // Keep alive
  await new Promise<void>(() => {});
}

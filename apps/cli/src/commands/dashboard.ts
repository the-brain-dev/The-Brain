/**
 * dashboard command — Live Terminal UI for my-brain monitoring.
 *
 * Usage:
 *   my-brain dashboard              Live dashboard (default 2s refresh)
 *   my-brain dashboard --project X  Dashboard for specific project
 *   my-brain dashboard --global     Global brain dashboard
 *   my-brain dashboard --interval 5 5-second refresh
 *
 * Features:
 *   - Live daemon status + uptime
 *   - Memory stats per layer (instant/selection/deep)
 *   - Recent memories stream
 *   - Graph visualization (ASCII bar chart of top concepts)
 *   - Harvester activity log
 *   - Keyboard: q=quit, r=refresh now, 1-4=switch tab
 *
 * Uses ANSI escape codes for rendering — zero external dependencies
 * beyond the standard library.
 */

import { BrainDB, MemoryLayer } from "@my-brain/core";
import type { MyBrainConfig } from "@my-brain/core";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import type { Memory } from "@my-brain/core";

// ── ANSI Constants ──────────────────────────────────────────────

const CSI = "\x1b[";
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const CLEAR = `${CSI}2J${CSI}H`;
const RESET = `${CSI}0m`;
const BOLD = `${CSI}1m`;
const DIM = `${CSI}2m`;
const GREEN = `${CSI}32m`;
const YELLOW = `${CSI}33m`;
const BLUE = `${CSI}34m`;
const MAGENTA = `${CSI}35m`;
const CYAN = `${CSI}36m`;
const RED = `${CSI}31m`;
const WHITE = `${CSI}37m`;
const BG_BLUE = `${CSI}44m`;
const BG_GREEN = `${CSI}42m`;

function color(c: string, s: string): string { return `${c}${s}${RESET}`; }
function bold(s: string): string { return `${BOLD}${s}${RESET}`; }
function dim(s: string): string { return `${DIM}${s}${RESET}`; }

// ── Types ───────────────────────────────────────────────────────

interface DashboardState {
  daemonRunning: boolean;
  uptime: string;
  stats: Awaited<ReturnType<BrainDB["getStats"]>>;
  recentMemories: Memory[];
  topNodes: Array<{ label: string; type: string; weight: number }>;
  config: MyBrainConfig | null;
  loraStatus: string;
  wikiPages: number;
  lastRefresh: Date;
}

type Tab = "overview" | "memories" | "graph" | "activity";

// ── Config Paths ────────────────────────────────────────────────

const CONFIG_PATH = join(process.env.HOME || "~", ".my-brain", "config.json");
const PID_FILE = join(process.env.HOME || "~", ".my-brain", "daemon.pid");

// ── Daemon Helpers ──────────────────────────────────────────────

async function checkDaemon(): Promise<boolean> {
  try {
    const raw = await readFile(PID_FILE, "utf-8");
    const pid = parseInt(raw.trim());
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getUptime(): string {
  try {
    const stat = statSync(PID_FILE);
    const ms = Date.now() - stat.mtimeMs;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  } catch {
    return "unknown";
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAge(ts: number): string {
  const ms = Date.now() - ts;
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ── Data Fetching ───────────────────────────────────────────────

async function resolveDbPath(options: { project?: string; global?: boolean }): Promise<string> {
  const defaults = join(process.env.HOME || "~", ".my-brain", "global", "brain.db");
  if (!existsSync(CONFIG_PATH)) return defaults;

  const config: MyBrainConfig = JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
  if (options.project) return config.contexts?.[options.project]?.dbPath || defaults;
  if (options.global) return config.database?.path || defaults;

  const active = config.activeContext || "global";
  if (active !== "global" && config.contexts?.[active]) {
    return config.contexts[active].dbPath;
  }
  return config.database?.path || defaults;
}

async function fetchState(db: BrainDB): Promise<DashboardState> {
  const daemonRunning = await checkDaemon();
  const uptime = daemonRunning ? getUptime() : "—";
  const stats = await db.getStats();

  let config: MyBrainConfig | null = null;
  try {
    config = JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
  } catch {}

  // Recent memories
  let recentMemories: Memory[] = [];
  try {
    recentMemories = await db.getAllMemories(20);
  } catch {}

  // Top graph nodes (by weight)
  let topNodes: Array<{ label: string; type: string; weight: number }> = [];
  try {
    const highWeight = await db.getHighWeightNodes(0.5);
    topNodes = highWeight
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 10)
      .map((n) => ({
        label: n.label.length > 40 ? n.label.slice(0, 37) + "..." : n.label,
        type: n.type,
        weight: n.weight,
      }));
  } catch {}

  // LoRA adapter status
  let loraStatus = "not found";
  const loraPath = join(process.env.HOME || "~", ".my-brain", "lora-checkpoints", "adapter.safetensors");
  if (existsSync(loraPath)) {
    const size = statSync(loraPath).size;
    loraStatus = `${formatSize(size)}`;
  }

  // Wiki pages
  let wikiPages = 0;
  const wikiDir = join(process.env.HOME || "~", ".my-brain", "wiki");
  if (existsSync(wikiDir)) {
    try {
      const { readdir } = await import("node:fs/promises");
      const files = await readdir(wikiDir);
      wikiPages = files.filter((f) => f.endsWith(".md")).length;
    } catch {}
  }

  return {
    daemonRunning,
    uptime,
    stats,
    recentMemories,
    topNodes,
    config,
    loraStatus,
    wikiPages,
    lastRefresh: new Date(),
  };
}

// ── Layout Constants ────────────────────────────────────────────

const BAR_WIDTH = 30;
const MAX_MEMORIES = 12;
const MAX_ACTIVITY = 8;

// ── Rendering Functions ─────────────────────────────────────────

function renderHeader(state: DashboardState, label: string): string {
  const status = state.daemonRunning
    ? color(GREEN, `● RUNNING`)
    : color(RED, `● STOPPED`);
  const uptime = state.daemonRunning ? `  ⏱ ${state.uptime}` : "";
  const title = bold(`my-brain dashboard — ${label}`);

  return `${BG_BLUE}${WHITE} ${title} ${" ".repeat(Math.max(0, process.stdout.columns - title.length - 18))} ${status}${uptime} ${RESET}\n`;
}

function renderStats(state: DashboardState): string {
  const s = state.stats;
  const perLayer = s.perLayer as Record<string, number>;
  const instant = perLayer["instant"] || 0;
  const selection = perLayer["selection"] || 0;
  const deep = perLayer["deep"] || 0;
  const total = instant + selection + deep;

  let lines = `\n${bold("▸ Memory Pipeline")}\n`;
  lines += `${DIM}${"─".repeat(60)}${RESET}\n`;

  // Show layer pipeline
  const barInstant = "█".repeat(Math.min(instant, BAR_WIDTH));
  const barSelection = "█".repeat(Math.min(selection, BAR_WIDTH));
  const barDeep = "█".repeat(Math.min(deep, BAR_WIDTH));

  lines += `  ${color(CYAN, "INSTANT")}    ${String(instant).padStart(5)}  ${dim(barInstant)}\n`;
  lines += `  ${color(YELLOW, "SELECTION")}  ${String(selection).padStart(5)}  ${dim(barSelection)}\n`;
  lines += `  ${color(MAGENTA, "DEEP")}      ${String(deep).padStart(5)}  ${dim(barDeep)}\n`;

  lines += `\n  ${bold("Total")}: ${total} memories  │  ${s.graphNodes} graph nodes  │  ${s.sessions} sessions\n`;

  // Plugin stats
  if (state.config) {
    const activePlugins = state.config.plugins.filter((p) => p.enabled !== false).length;
    lines += `  Plugins: ${activePlugins} active  │  Wiki: ${state.wikiPages} pages  │  LoRA: ${state.loraStatus}\n`;
  }

  return lines;
}

function renderMemoryTable(state: DashboardState): string {
  let lines = `\n${bold("▸ Recent Memories")}\n`;
  lines += `${DIM}${"─".repeat(process.stdout.columns - 2 || 78)}${RESET}\n`;

  if (state.recentMemories.length === 0) {
    lines += `  ${dim("(no memories yet — start harvesting!)")}\n`;
    return lines;
  }

  const cols = process.stdout.columns || 80;
  const previewWidth = Math.max(20, cols - 55);

  lines += `  ${dim("LAYER".padEnd(10))} ${dim("SRC".padEnd(8))} ${dim("PREVIEW")}\n`;

  for (const mem of state.recentMemories.slice(0, MAX_MEMORIES)) {
    const layerColor = mem.layer === "instant" ? CYAN : mem.layer === "selection" ? YELLOW : MAGENTA;
    const layer = color(layerColor, mem.layer.padEnd(10));
    const src = dim((mem.source || "unknown").slice(0, 7).padEnd(8));
    const preview = mem.content
      .replace(/\n/g, " ")
      .slice(0, previewWidth - 3)
      + (mem.content.length > previewWidth - 3 ? "..." : "");

    lines += `  ${layer} ${src} ${preview}\n`;
  }

  return lines;
}

function renderGraphVisualization(state: DashboardState): string {
  let lines = `\n${bold("▸ Knowledge Graph — Top Concepts by Weight")}\n`;
  lines += `${DIM}${"─".repeat(60)}${RESET}\n`;

  if (state.topNodes.length === 0) {
    lines += `  ${dim("(no graph nodes yet)")}\n`;
    return lines;
  }

  for (const node of state.topNodes) {
    const barLen = Math.round(node.weight * BAR_WIDTH);
    const bar = color(
      node.weight > 0.8 ? GREEN : node.weight > 0.6 ? YELLOW : BLUE,
      "█".repeat(barLen) + "░".repeat(BAR_WIDTH - barLen)
    );
    const typeEmoji = node.type === "preference" ? "⚙" : node.type === "correction" ? "✏" : node.type === "pattern" ? "◈" : "●";
    lines += `  ${typeEmoji} ${node.label.padEnd(42)} ${bar} ${(node.weight * 100).toFixed(0)}%\n`;
  }

  return lines;
}

function renderActivityLog(state: DashboardState): string {
  let lines = `\n${bold("▸ Harvester Activity")}\n`;
  lines += `${DIM}${"─".repeat(60)}${RESET}\n`;

  // Show memory sources breakdown
  const perSource = (state.stats as any).memoryPerSource as Array<{ source: string; c: number }> || [];

  if (perSource.length === 0) {
    lines += `  ${dim("(no harvester activity detected)")}\n`;
  } else {
    for (const s of perSource.slice(0, MAX_ACTIVITY)) {
      const barLen = Math.min(s.c, BAR_WIDTH);
      lines += `  ${s.source.padEnd(12)} ${"█".repeat(barLen)} ${s.c}\n`;
    }
  }

  return lines;
}

function renderFooter(state: DashboardState, tab: Tab): string {
  const tabs = ["overview", "memories", "graph", "activity"];
  const tabStr = tabs.map((t) =>
    t === tab ? color(BG_GREEN, ` ${t} `) : dim(` ${t} `)
  ).join("");

  const refresh = dim(`Last refresh: ${state.lastRefresh.toLocaleTimeString()}`);
  const keys = dim("q:quit  r:refresh  1-4:tab");

  return `\n${DIM}${"─".repeat(process.stdout.columns - 2 || 78)}${RESET}\n` +
    `${tabStr}  │  ${refresh}  │  ${keys}\n`;
}

function renderTab(state: DashboardState, tab: Tab): string {
  switch (tab) {
    case "overview":
      return renderStats(state) + renderGraphVisualization(state).split("\n").slice(0, 8).join("\n");
    case "memories":
      return renderMemoryTable(state);
    case "graph":
      return renderGraphVisualization(state);
    case "activity":
      return renderActivityLog(state);
  }
}

async function renderFullScreen(
  state: DashboardState,
  label: string,
  tab: Tab
): Promise<string> {
  const lines: string[] = [];

  lines.push(renderHeader(state, label));
  lines.push(renderStats(state));
  lines.push(renderTab(state, tab));
  lines.push(renderFooter(state, tab));

  return CLEAR + lines.join("");
}

// ── Raw Mode Input ──────────────────────────────────────────────

function enableRawMode() {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
  }
}

function disableRawMode() {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
  }
}

// ── Main Command ────────────────────────────────────────────────

export async function dashboardCommand(options: {
  project?: string;
  global?: boolean;
  interval?: number;
}) {
  const dbPath = await resolveDbPath(options);
  if (!dbPath || !existsSync(dbPath)) {
    console.error("No database found. Run `my-brain init` first.");
    process.exit(1);
  }

  const label = options.project
    ? `project:${options.project}`
    : options.global
      ? "global"
      : "active";

  const interval = (options.interval ?? 2) * 1000;
  const db = new BrainDB(dbPath);

  let tab: Tab = "overview";
  let running = true;

  // Hide cursor and enable raw mode
  process.stdout.write(HIDE_CURSOR);
  enableRawMode();

  // Keyboard handler
  process.stdin.on("data", (chunk: Buffer) => {
    const key = chunk.toString();
    if (key === "q" || key === "\x03") { running = false; }
    else if (key === "r") { /* immediate refresh — handled in loop */ }
    else if (key === "1") { tab = "overview"; }
    else if (key === "2") { tab = "memories"; }
    else if (key === "3") { tab = "graph"; }
    else if (key === "4") { tab = "activity"; }
  });

  // Main render loop
  const render = async () => {
    const state = await fetchState(db);
    const screen = await renderFullScreen(state, label, tab);
    process.stdout.write(screen);
  };

  await render();

  const timer = setInterval(async () => {
    if (!running) {
      clearInterval(timer);
      cleanup();
      return;
    }
    await render();
  }, interval);

  function cleanup() {
    clearInterval(timer);
    disableRawMode();
    process.stdout.write(SHOW_CURSOR);
    process.stdout.write(CLEAR);
    db.close();
    process.exit(0);
  }

  // Wait for quit
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!running) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });

  cleanup();
}

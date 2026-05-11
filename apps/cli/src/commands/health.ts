/**
 * health command — Show daemon health, stats, and monitoring data.
 *
 *   the-brain health              Show active context health summary
 *   the-brain health --project X  Show specific project health
 *   the-brain health --global     Show global brain health
 */
import { consola } from "consola";
import { BrainDB, MemoryLayer, safeParseConfig } from "@the-brain/core";
import type { TheBrainConfig } from "@the-brain/core";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";

const CONFIG_PATH = join(process.env.HOME || "~", ".the-brain", "config.json");
const PID_FILE = join(process.env.HOME || "~", ".the-brain", "daemon.pid");

export async function healthCommand(options: {
  project?: string;
  global?: boolean;
}) {
  const dbPath = await resolveDbPath(options);
  if (!dbPath || !existsSync(dbPath)) {
    consola.warn("No database found. Run `the-brain init` first.");
    return;
  }

  const db = new BrainDB(dbPath);

  try {
    const stats = await db.getStats();
    const daemonRunning = await checkDaemon();
    const uptime = daemonRunning ? getUptime() : null;

    // ── Header ──
    const label = options.project
      ? `Project: ${options.project}`
      : options.global
        ? "Global Brain"
        : "the-brain";
    consola.box(buildHealthBox(label, stats, daemonRunning, uptime));

    // ── Daemon details ──
    if (daemonRunning) {
      consola.info(`Daemon PID: ${await readPid()}`);
      consola.info(`Uptime: ${uptime}`);
    } else {
      consola.info("Daemon: not running");
      consola.info("Start with: the-brain daemon start");
    }

    // ── Active projects ──
    try {
      const raw = await readFile(CONFIG_PATH, "utf-8");
      const result = safeParseConfig(JSON.parse(raw));
      if (result.success) {
        const config = result.data;
        const projectCount = Object.keys(config.contexts || {}).length;
        if (projectCount > 0) {
          consola.info(`\nRegistered projects (${projectCount}):`);
          for (const [name, ctx] of Object.entries(config.contexts)) {
            const active = config.activeContext === name ? " (active)" : "";
            const hasDb = existsSync(ctx.dbPath);
            const dbSize = hasDb ? formatSize(statSync(ctx.dbPath).size) : "none";
            consola.info(`  ${name}${active}: ${dbSize}`);
          }
        }
      }
    } catch (err) {
      console.error("[Health] Failed to read config or list projects:", err);
    }

    // ── Training status ──
    const loraDir = join(process.env.HOME || "~", ".the-brain", "lora-checkpoints");
    if (existsSync(loraDir)) {
      const adapterPath = join(loraDir, "adapter.safetensors");
      if (existsSync(adapterPath)) {
        const size = statSync(adapterPath).size;
        const mtime = statSync(adapterPath).mtime;
        consola.info(`LoRA adapter: ${formatSize(size)} (${formatAge(mtime.getTime())})`);
      }
    }

    // ── Wiki status ──
    const wikiDir = join(process.env.HOME || "~", ".the-brain", "wiki");
    if (existsSync(wikiDir)) {
      try {
        const files = await readdir(wikiDir);
        const mdFiles = files.filter((f) => f.endsWith(".md"));
        consola.info(`Wiki: ${mdFiles.length} pages in ${wikiDir}`);
      } catch (err) {
        console.error("[Health] Failed to read wiki directory:", err);
      }
    }
  } finally {
    db.close();
  }
}

// ── Helpers ─────────────────────────────────────────────────────

async function resolveDbPath(options: { project?: string; global?: boolean }): Promise<string> {
  const defaults = join(process.env.HOME || "~", ".the-brain", "global", "brain.db");

  if (!existsSync(CONFIG_PATH)) return defaults;

  let config: TheBrainConfig;
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const result = safeParseConfig(JSON.parse(raw));
    if (!result.success) return defaults;
    config = result.data;
  } catch (err) {
    console.error("[Health] Failed to load config, using defaults:", err);
    return defaults;
  }

  if (options.project) {
    return config.contexts?.[options.project]?.dbPath || defaults;
  }
  if (options.global) {
    return config.database.path || defaults;
  }

  const active = config.activeContext || "global";
  if (active !== "global" && config.contexts?.[active]) {
    return config.contexts[active].dbPath;
  }
  return config.database.path || defaults;
}

async function checkDaemon(): Promise<boolean> {
  const pid = await readPid();
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(): Promise<number | null> {
  try {
    const raw = await readFile(PID_FILE, "utf-8");
    const pid = parseInt(raw.trim());
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function getUptime(): string {
  try {
    const stat = statSync(PID_FILE);
    const ms = Date.now() - stat.mtimeMs;
    const hours = Math.floor(ms / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    if (hours > 0) return `${hours}h ${mins}m`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
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

function buildHealthBox(
  label: string,
  stats: Awaited<ReturnType<BrainDB["getStats"]>>,
  daemonRunning: boolean,
  uptime: string | null
): string {
  const status = daemonRunning ? "🟢 RUNNING" : "🔴 STOPPED";
  const uptimeLine = uptime ? `  Uptime:           ${uptime}\n` : "";

  // Per-layer breakdown
  const perLayer = stats.perLayer as Record<string, number>;
  const layers = Object.entries(perLayer)
    .map(([l, c]) => `  ${l.padEnd(12)} ${c}`)
    .join("\n");

  return `
  ${label.toUpperCase()}
  ${"─".repeat(40)}
  Status:           ${status}
${uptimeLine}  Total memories:   ${stats.memories}
  Graph nodes:      ${stats.graphNodes}
  Sessions:         ${stats.sessions}

  By layer:
${layers || "  (empty)"}
`;
}

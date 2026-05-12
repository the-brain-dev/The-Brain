/**
 * inspect command — Show the-brain state, stats, and memory health.
 * Multi-project aware: supports --project <name> and --global.
 */
import { consola } from "consola";
import { BrainDB, MemoryLayer, safeParseConfig } from "@the-brain-dev/core";
import type { TheBrainConfig } from "@the-brain-dev/core";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const CONFIG_PATH = join(process.env.HOME || "~", ".the-brain", "config.json");

export async function inspectCommand(options: {
  stats?: boolean;
  memories?: string | boolean;
  graph?: boolean;
  recent?: boolean;
  search?: string;
  top?: string;
  sources?: boolean;
  project?: string;
  global?: boolean;
}) {
  if (options.project && options.global) {
    consola.error("Cannot use --project and --global together. Choose one.");
    return;
  }
  // Resolve target DB path
  const dbPath = await resolveDbPath(options);
  if (!dbPath) return;

  // Check if DB exists
  if (!existsSync(dbPath)) {
    consola.warn("No brain database found at: " + dbPath);
    consola.info("Run 'the-brain daemon start' to begin collecting data.");
    return;
  }

  const db = new BrainDB(dbPath);

  try {
    // --search <query>: Search graph nodes
    if (options.search) {
      await searchGraph(db, options.search);
      return;
    }

    // --top <type>: Show top nodes by type
    if (options.top) {
      await showTop(db, options.top, dbPath);
      return;
    }

    // --sources: Breakdown by source
    if (options.sources) {
      await showSources(db);
      return;
    }

    // Default: show rich stats
    await showStats(db, options.project, options.global);

    // Optional extras
    if (options.graph) await showGraph(db);
    if (options.recent) await showRecent(db);
    if (options.memories) {
      const layer = typeof options.memories === "string"
        ? (options.memories as MemoryLayer)
        : undefined;
      await showMemories(db, layer);
    }
  } finally {
    db.close();
  }
}

async function resolveDbPath(options: { project?: string; global?: boolean }): Promise<string | null> {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = await readFile(CONFIG_PATH, "utf-8");
      const parsed = safeParseConfig(JSON.parse(raw));
      if (!parsed.success) return join(process.env.HOME || "~", ".the-brain", "brain.db");
      const config = parsed.data;

      if (options.project) {
        const ctx = config.contexts?.[options.project];
        if (!ctx) {
          consola.error(`Project "${options.project}" not found.`);
          consola.info("Available: " + Object.keys(config.contexts || {}).join(", "));
          return null;
        }
        consola.info(`Inspecting project: ${ctx.label || ctx.name}`);
        return ctx.dbPath;
      }

      if (options.global) {
        consola.info("Inspecting global brain");
        return config.database.path || join(process.env.HOME || "~", ".the-brain", "global", "brain.db");
      }

      // Use active context
      const active = config.activeContext || "global";
      if (active !== "global" && config.contexts?.[active]) {
        consola.info(`Inspecting project: ${active}`);
        return config.contexts[active].dbPath;
      }
      consola.info("Inspecting global brain");
      return config.database.path || join(process.env.HOME || "~", ".the-brain", "global", "brain.db");
    }
  } catch (err) {
    console.error("[Inspect] Failed to read config:", err);
  }

  // Fallback: legacy DB
  return join(process.env.HOME || "~", ".the-brain", "brain.db");
}

async function showStats(db: BrainDB, project?: string, isGlobal?: boolean) {
  const stats = await db.getStats();
  const label = project ? `Project: ${project}` : isGlobal ? "Global Brain" : "the-brain";
  const useEmoji = process.stdout.isTTY;
  const boxH = "\u2500";

  const typeBar = stats.perGraphType?.length
    ? stats.perGraphType.map((t: any) =>
        "  " + t.type + ": " + t.c + " (avg w=" + t.avg_w + ")"
      ).join("\n")
    : "  (no graph nodes yet)";

  const sourceBar = stats.perSource?.length
    ? stats.perSource.map((s: any) =>
        "  " + s.source + ": " + s.c + " nodes"
      ).join("\n")
    : "";

  consola.box(
    "\n" +
    "  " + label.toUpperCase() + "\n" +
    "  " + boxH.repeat(38) + "\n" +
    "  Total memories: " + String(stats.memories).padEnd(20) + "\n" +
    "  Graph nodes:    " + String(stats.graphNodes).padEnd(20) + "\n" +
    "  Sessions:       " + String(stats.sessions).padEnd(20) + "\n" +
    "\n" +
    "  Graph Nodes by Type:\n" + typeBar + "\n" +
    (sourceBar ? "\n  Sources:\n" + sourceBar + "\n" : "") +
    "\n  Run with --search <term>, --top <type>, or --graph for details.\n"
  );
}

async function searchGraph(db: BrainDB, query: string) {
  consola.info("Searching graph for: \"" + query + "\"\n");
  const nodes = await db.searchGraphNodes(query);

  if (nodes.length === 0) {
    consola.info("  No matching nodes found.");
    return;
  }

  nodes.sort((a, b) => b.weight - a.weight);
  consola.info("  Found " + nodes.length + " matching nodes:\n");

  const typeEmoji: Record<string, string> = {
    concept: "\uD83D\uDCA1",
    correction: "\uD83D\uDD27",
    preference: "\u2B50",
    pattern: "\uD83D\uDD04",
  };

  for (const node of nodes.slice(0, 25)) {
    const emoji = typeEmoji[node.type] || "\u2022";
    const date = new Date(node.timestamp).toLocaleDateString();
    consola.info(
      "  " + emoji + " [" + node.type + "] w=" + node.weight.toFixed(2) + " " + date + "\n" +
      "      " + node.label.slice(0, 80) + (node.label.length > 80 ? "..." : "")
    );
  }

  if (nodes.length > 25) {
    consola.info("  ... and " + (nodes.length - 25) + " more. Be more specific to narrow results.");
  }
}

// ── Graph Node Types ─────────────────────────────────────────

interface GraphNodeRow {
  type?: string;
  weight: number;
  label: string;
  source?: string;
  timestamp?: number;
}

async function showTop(db: BrainDB, type: string, dbPath: string) {
  const validTypes = ["concept", "correction", "preference", "pattern", "all"];
  const filterType = type.toLowerCase();

  if (!validTypes.includes(filterType)) {
    consola.warn("Unknown type: " + type);
    consola.info("Valid types: " + validTypes.join(", "));
    return;
  }

  const sqlite = (await import("bun:sqlite")).Database;
  const d = new sqlite(dbPath);

  let rows: GraphNodeRow[];
  if (filterType === "all") {
    rows = d.query(
      "SELECT type, weight, substr(label, 1, 80) as label, source, timestamp FROM graph_nodes ORDER BY weight DESC LIMIT 15"
    ).all() as GraphNodeRow[];
  } else {
    rows = d.query(
      "SELECT weight, substr(label, 1, 80) as label, source, timestamp FROM graph_nodes WHERE type = ? ORDER BY weight DESC LIMIT 15"
    ).all(filterType) as GraphNodeRow[];
  }

  d.close();

  if (rows.length === 0) {
    consola.info("No " + filterType + " nodes found.");
    return;
  }

  consola.info("Top " + rows.length + " " + filterType + " nodes by weight:\n");

  const typeEmoji: Record<string, string> = {
    concept: "\uD83D\uDCA1",
    correction: "\uD83D\uDD27",
    preference: "\u2B50",
    pattern: "\uD83D\uDD04",
  };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const emoji = typeEmoji[r.type] || "\u2022";
    consola.info(
      "  " + (i + 1) + ". " + emoji + " w=" + r.weight.toFixed(2) + " [" + (r.source || "?") + "]\n" +
      "     \"" + r.label + "\""
    );
  }
}

async function showSources(db: BrainDB) {
  const stats = await db.getStats();

  consola.info("Data Sources Breakdown:\n");

  if (stats.perSource?.length) {
    consola.info("  Graph Nodes by Source:");
    for (const s of stats.perSource) {
      const pct = ((s.c / stats.graphNodes) * 100).toFixed(1);
      consola.info("    " + s.source + ": " + s.c + " nodes (" + pct + "%)");
    }
  }

  if (stats.memoryPerSource?.length) {
    consola.info("\n  Memories by Source:");
    for (const s of stats.memoryPerSource) {
      const pct = ((s.c / stats.memories) * 100).toFixed(1);
      consola.info("    " + s.source + ": " + s.c + " memories (" + pct + "%)");
    }
  }

  if (stats.perLayer && Object.keys(stats.perLayer).length > 0) {
    consola.info("\n  Memories by Layer:");
    for (const [layer, count] of Object.entries(stats.perLayer)) {
      consola.info("    " + layer + ": " + count);
    }
  }
}

async function showGraph(db: BrainDB) {
  const highWeight = await db.getHighWeightNodes(0.6);

  consola.info("Knowledge Graph -- " + highWeight.length + " high-weight nodes (>=0.6):\n");

  if (highWeight.length === 0) {
    consola.info("  No high-weight nodes yet. Keep interacting!");
    return;
  }

  const typeEmoji: Record<string, string> = {
    concept: "\uD83D\uDCA1",
    correction: "\uD83D\uDD27",
    preference: "\u2B50",
    pattern: "\uD83D\uDD04",
  };

  for (const node of highWeight.slice(0, 20)) {
    const emoji = typeEmoji[node.type] || "\u2022";
    consola.info(
      "  " + emoji + " " + node.label.slice(0, 40).padEnd(42) +
      " [" + node.type + "] w=" + node.weight.toFixed(2)
    );
  }
}

async function showRecent(db: BrainDB) {
  const memories = await db.getRecentMemories(24);

  consola.info("Last 24 hours -- " + memories.length + " interactions:\n");

  for (const m of memories.slice(0, 15)) {
    const time = new Date(m.timestamp).toLocaleTimeString();
    const source = m.source.padEnd(12);
    consola.info("  [" + time + "] " + source + " | " + m.content.slice(0, 100));
  }
}

async function showMemories(db: BrainDB, layer?: MemoryLayer) {
  const layers = layer ? [layer] : Object.values(MemoryLayer);
  let total = 0;

  for (const l of layers) {
    const memories = await db.getMemoriesByLayer(l, 10);
    total += memories.length;

    if (memories.length > 0) {
      consola.info(l.toUpperCase() + " Layer -- latest " + memories.length + " memories:\n");
    }

    for (const m of memories) {
      const date = new Date(m.timestamp).toLocaleDateString();
      const score = m.surpriseScore ? " [surprise: " + m.surpriseScore.toFixed(2) + "]" : "";
      consola.info(
        "  [" + date + "] " + m.content.slice(0, 120) + (m.content.length > 120 ? "..." : "") + score
      );
    }
  }

  if (total === 0) {
    consola.info("No memories found. Start the daemon to begin collecting!");
  }
}

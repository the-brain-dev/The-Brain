/**
 * context command — Exports the-brain context for external AI agents (Hermes).
 *
 * Outputs structured JSON with:
 *   - High-weight knowledge graph nodes (cleaned labels)
 *   - Recent activity (last 24h, content-cleaned & deduplicated)
 *   - SPM-surprising patterns from the SELECTION layer
 *   - Active project context and stats summary
 *
 * Uses ContentCleaner to extract signal from raw XML-wrapped Claude Code memories.
 * Deduplicates across layers (instant/selection/deep).
 */
import { BrainDB, MemoryLayer, AuthDB, safeParseConfig } from "@the-brain-dev/core";
import {
  cleanMemoryContent,
  cleanGraphNodeLabel,
  deduplicateContents,
} from "@the-brain-dev/core";
import type { TheBrainConfig, GraphNodeRecord } from "@the-brain-dev/core";
import type { CleanedContent } from "@the-brain-dev/core";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const CONFIG_PATH = join(process.env.HOME || "~", ".the-brain", "config.json");

export interface ContextOutput {
  meta: {
    activeContext: string;
    project: string | null;
    generatedAt: string;
    dbType: "global" | "project";
  };
  stats: {
    totalMemories: number;
    totalGraphNodes: number;
    totalSessions: number;
  };
  graphNodes: {
    highWeight: Array<{
      label: string;
      cleaned: string;
      type: string;
      weight: number;
      source: string;
    }>;
    topConcepts: Array<{
      label: string;
      cleaned: string;
      type: string;
      weight: number;
    }>;
  };
  recentActivity: Array<{
    summary: string;
    action: string;
    project: string | null;
    layer: string;
    source: string;
    surpriseScore: number | null;
  }>;
  spmPatterns: Array<{
    summary: string;
    action: string;
    project: string | null;
    surpriseScore: number;
    source: string;
  }>;
  identity?: {
    userId: string;
    userName: string;
    fragmentCount: number;
    maxFragments: number;
    topPreferences: string[];
  };
}

export async function contextCommand(options: {
  json?: boolean;
  markdown?: boolean;
  project?: string;
  global?: boolean;
  query?: string;
  limit?: number;
  user?: string;
  dbPath?: string;  // Override DB path (for testing)
}) {
  const dbPath = options.dbPath || await resolveDbPath(options);
  if (!dbPath || !existsSync(dbPath)) {
    if (options.json || options.markdown) {
      console.log(JSON.stringify({ error: "no_database", dbPath }));
    } else {
      console.log("No brain database found. Run 'the-brain daemon start' first.");
    }
    return;
  }

  const db = new BrainDB(dbPath);
  const config = await loadConfig();

  try {
    const output: ContextOutput = {
      meta: {
        activeContext: config?.activeContext || "global",
        project: options.project || (config?.activeContext !== "global" ? config?.activeContext : null) || null,
        generatedAt: new Date().toISOString(),
        dbType: options.project ? "project" : options.global ? "global" : "global",
      },
      stats: {} as ContextOutput["stats"],
      graphNodes: { highWeight: [], topConcepts: [] },
      recentActivity: [],
      spmPatterns: [],
    };

    // ── Stats ──────────────────────────────────────────────
    const stats = await db.getStats();
    output.stats = {
      totalMemories: stats.memories,
      totalGraphNodes: stats.graphNodes,
      totalSessions: stats.sessions,
    };

    // ── Graph Nodes (cleaned) ──────────────────────────────
    // Single query: get all nodes ≥0.3, then split into highWeight (≥0.5) and topConcepts
    const allNodes = await db.getHighWeightNodes(0.3);
    const highWeight = allNodes.filter((n) => n.weight >= 0.5);
    output.graphNodes.highWeight = highWeight
      .slice(0, 10)
      .map((n: GraphNodeRecord) => ({
        label: n.label,
        cleaned: cleanGraphNodeLabel(n.label, n.type),
        type: n.type,
        weight: n.weight,
        source: n.source,
      }));
    output.graphNodes.topConcepts = allNodes
      .filter((n: GraphNodeRecord) =>
        n.type === "concept" || n.type === "preference" || n.type === "pattern"
      )
      .slice(0, 8)
      .map((n: GraphNodeRecord) => ({
        label: n.label,
        cleaned: cleanGraphNodeLabel(n.label, n.type),
        type: n.type,
        weight: n.weight,
      }));

    // ── Recent Activity (content-cleaned & deduplicated) ───
    const recentMemories = await db.getRecentMemories(24);
    const cleanedRecent = recentMemories
      .slice(0, 30) // Take more to allow dedup to work well
      .map((m) => {
        const cleaned = cleanMemoryContent(m.content);
        return {
          ...cleaned,
          layer: m.layer,
          surpriseScore: m.surpriseScore ?? null,
          timestamp: m.timestamp,
          source: m.source,
        };
      })
      // Filter out empty summaries and system preambles
      .filter((c) => c.summary !== "(empty)" && !c.summary.includes("skipped"));

    // Deduplicate by cleaned summary
    const seen = new Map<string, typeof cleanedRecent[0]>();
    const typeRank: Record<string, number> = { "user-request": 4, "progress": 3, "observation": 2, "unknown": 1 };
    for (const c of cleanedRecent) {
      const key = c.summary.slice(0, 50);
      const existing = seen.get(key);
      if (!existing || (typeRank[c.type] || 0) > (typeRank[existing.type] || 0)) {
        seen.set(key, c);
      }
    }

    output.recentActivity = Array.from(seen.values())
      .slice(0, 12)
      .map((c) => ({
        summary: c.summary,
        action: c.action,
        project: c.project,
        layer: c.layer,
        source: c.source,
        surpriseScore: c.surpriseScore,
      }));

    // ── SPM Surprising Patterns (cleaned) ──────────────────
    const surprisingMemories = await db.getSurprisingMemories(0.3);
    const cleanedSPM = surprisingMemories
      .slice(0, 15)
      .map((m) => {
        const cleaned = cleanMemoryContent(m.content);
        return {
          summary: cleaned.summary,
          action: cleaned.action,
          project: cleaned.project,
          surpriseScore: m.surpriseScore ?? 0,
          timestamp: m.timestamp,
          source: m.source,
        };
      })
      .filter((c) => c.type !== "unknown" || !c.summary.includes("skipped"));

    // Deduplicate SPM
    const spmSeen = new Map<string, typeof cleanedSPM[0]>();
    for (const c of cleanedSPM) {
      const key = c.summary.slice(0, 50);
      const existing = spmSeen.get(key);
      if (!existing || c.surpriseScore > existing.surpriseScore) {
        spmSeen.set(key, c);
      }
    }

    output.spmPatterns = Array.from(spmSeen.values())
      .slice(0, 8)
      .map((c) => ({
        summary: c.summary,
        action: c.action,
        project: c.project,
        surpriseScore: c.surpriseScore,
        source: c.source,
      }));

    // ── User Identity (if --user specified) ──────────────
    if (options.user) {
      try {
        const identity = await loadUserIdentity(options.user);
        if (identity) {
          output.identity = identity;
        }
      } catch {
        // Identity not available — skip gracefully
      }
    }

    // ── Output Format ──────────────────────────────────────
    if (options.markdown) {
      console.log(formatMarkdown(output));
    } else {
      console.log(JSON.stringify(output, null, 2));
    }
  } finally {
    db.close();
  }
}

function formatMarkdown(ctx: ContextOutput): string {
  const lines: string[] = [];

  lines.push("## 🧠 the-brain Context");
  lines.push(`**Context:** ${ctx.meta.activeContext} (${ctx.meta.dbType})`);
  lines.push(`**Stats:** ${ctx.stats.totalMemories} memories | ${ctx.stats.totalGraphNodes} graph nodes`);
  lines.push("");

  // ── Graph Nodes ──────────────────────────────────────────
  if (ctx.graphNodes.highWeight.length > 0) {
    lines.push("### 📌 Knowledge Graph");
    // Group by type for cleaner reading
    const typeOrder = ["preference", "correction", "pattern", "concept"];
    const grouped: Record<string, typeof ctx.graphNodes.highWeight> = {};
    for (const n of ctx.graphNodes.highWeight) {
      (grouped[n.type] ||= []).push(n);
    }

    for (const type of typeOrder) {
      const nodes = grouped[type];
      if (!nodes || nodes.length === 0) continue;
      const emoji = { concept: "💡", correction: "🔧", preference: "⭐", pattern: "🔄" }[type] || "•";
      for (const n of nodes.slice(0, 3)) {
        // Use cleaned label if it's significantly different
        const displayLabel = n.cleaned.length > 10 && n.cleaned !== n.label
          ? n.cleaned
          : n.label.slice(0, 80);
        lines.push(`- ${emoji} ${displayLabel} (w=${n.weight.toFixed(2)})`);
      }
    }
    lines.push("");
  }

  // ── SPM Patterns ─────────────────────────────────────────
  if (ctx.spmPatterns.length > 0) {
    lines.push("### ⚡ Surprising Patterns");
    for (const p of ctx.spmPatterns.slice(0, 5)) {
      const proj = p.project ? ` [${p.project}]` : "";
      lines.push(`- s=${(p.surpriseScore ?? 0).toFixed(3)}${proj} ${p.summary}`);
    }
    lines.push("");
  }

  // ── Recent Activity ──────────────────────────────────────
  if (ctx.recentActivity.length > 0) {
    lines.push("### 🕐 Recent Activity");
    for (const a of ctx.recentActivity.slice(0, 8)) {
      const proj = a.project ? ` [${a.project}]` : "";
      const layer = a.layer === "deep" ? "🧠" : a.layer === "selection" ? "⚖️" : "⚡";
      lines.push(`- ${layer}${proj} ${a.summary}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

async function resolveDbPath(options: {
  project?: string;
  global?: boolean;
}): Promise<string | null> {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = await readFile(CONFIG_PATH, "utf-8");
      const parsed = safeParseConfig(JSON.parse(raw));
      if (!parsed.success) return join(process.env.HOME || "~", ".the-brain", "brain.db");
      const config = parsed.data;

      if (options.project) {
        const ctx = config.contexts?.[options.project];
        if (!ctx) return null;
        return ctx.dbPath;
      }

      if (options.global) {
        return config.database.path || join(process.env.HOME || "~", ".the-brain", "global", "brain.db");
      }

      const active = config.activeContext || "global";
      if (active !== "global" && config.contexts?.[active]) {
        return config.contexts[active].dbPath;
      }
      return config.database.path || join(process.env.HOME || "~", ".the-brain", "global", "brain.db");
    }
  } catch (err) {
    console.error("[Context] Failed to resolve DB path:", err);
  }

  return join(process.env.HOME || "~", ".the-brain", "brain.db");
}

async function loadConfig(): Promise<TheBrainConfig | null> {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = await readFile(CONFIG_PATH, "utf-8");
      const parsed = safeParseConfig(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    }
  } catch (err) {
    console.error("[Context] Failed to resolve DB path:", err);
  }
  return null;
}

/**
 * Load a user's identity anchor state from disk.
 * Team mode: reads ~/.the-brain/identity/{userId}.json via AuthDB
 * Single-user: reads ~/.the-brain/identity-anchor.json
 */
async function loadUserIdentity(
  userName: string,
): Promise<ContextOutput["identity"] | null> {
  const authDbPath = join(process.env.HOME || "~", ".the-brain", "auth.db");
  const identityDir = join(process.env.HOME || "~", ".the-brain", "identity");

  if (existsSync(authDbPath)) {
    const authDB = new AuthDB(authDbPath);
    const user = await authDB.getUserByName(userName);
    if (user) {
      const statePath = join(identityDir, user.id + ".json");
      if (existsSync(statePath)) {
        const raw = await readFile(statePath, "utf-8");
        const fragments: Array<{ content: string }> = JSON.parse(raw);
        const topPrefs = fragments.slice(0, 5).map((f) => f.content.slice(0, 120));
        authDB.close();
        return {
          userId: user.id,
          userName: user.name,
          fragmentCount: fragments.length,
          maxFragments: 50,
          topPreferences: topPrefs,
        };
      }
    }
    authDB.close();
    return null;
  }

  const singlePath = join(process.env.HOME || "~", ".the-brain", "identity-anchor.json");
  if (existsSync(singlePath)) {
    const raw = await readFile(singlePath, "utf-8");
    const fragments: Array<{ content: string }> = JSON.parse(raw);
    return {
      userId: "default",
      userName: userName,
      fragmentCount: fragments.length,
      maxFragments: 50,
      topPreferences: fragments.slice(0, 5).map((f) => f.content.slice(0, 120)),
    };
  }

  return null;
}

/**
 * @the-brain-dev/plugin-auto-wiki — v2.0.0
 *
 * Karpathy-style LLM Wiki generator for the-brain.
 * Inspired by:
 *   - Karpathy's LLM Wiki pattern (raw → entities → meta)
 *   - pi-llm-wiki (source packets, registry, backlinks, lint)
 *
 * On each trigger (consolidation → weekly schedule):
 *   1. Dump raw memories → raw/memory-dump-YYYY-MM-DD.md
 *   2. Scan graph nodes → create/update entity pages
 *   3. Generate weekly summary
 *   4. Rebuild index.md, registry.json, backlinks.json
 *   5. Append to log.md
 *   6. Lint for orphans & stale pages
 */
import { definePlugin, HookEvent, MemoryLayer } from "@the-brain-dev/core";
import type { BrainDB, Memory, GraphNodeRecord, OutputPlugin, OutputGenerateContext, OutputResult } from "@the-brain-dev/core";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join, relative } from "node:path";
import { existsSync } from "node:fs";

// ── Types ──────────────────────────────────────────────────────

interface AutoWikiConfig {
  outputDir: string;
  schedule: string;          // cron expression, default "0 9 * * 0"
  title: string;             // Wiki title
  maxEntities: number;       // Max entity pages per type
  maxRawMemories: number;    // Max memories per raw dump
  minWeightForEntity: number; // Min graph weight to create entity page
  highWeightThreshold: number;
  mediumWeightThreshold: number;
  projectName?: string;      // For per-project wiki title suffix
}

const DEFAULT_CONFIG: AutoWikiConfig = {
  outputDir: join(process.env.HOME || "~", ".the-brain", "wiki"),
  schedule: "0 9 * * 0",
  title: "🧠 My Brain Wiki",
  maxEntities: 50,
  maxRawMemories: 200,
  minWeightForEntity: 0.3,
  highWeightThreshold: 0.7,
  mediumWeightThreshold: 0.4,
};

interface WikiPage {
  path: string;            // Relative to outputDir
  slug: string;            // File stem
  frontmatter: Record<string, unknown>;
  body: string;
}

// ── Helpers ─────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().split("T")[0];
}

function formatWeek(timestamp: number): string {
  const d = new Date(timestamp);
  const startOfYear = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

function weightToConfidence(weight: number, cfg: AutoWikiConfig): "high" | "medium" | "low" {
  if (weight >= cfg.highWeightThreshold) return "high";
  if (weight >= cfg.mediumWeightThreshold) return "medium";
  return "low";
}

function escapeMd(text: string): string {
  return text.replace(/[<>]/g, "");
}

function frontmatterYaml(fm: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      lines.push(`${k}:`);
      for (const item of v) {
        lines.push(`  - ${JSON.stringify(String(item))}`);
      }
    } else if (typeof v === "object") {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

// ── Wiki Generator ──────────────────────────────────────────────

async function ensureDirs(baseDir: string): Promise<void> {
  await mkdir(join(baseDir, "raw"), { recursive: true });
  await mkdir(join(baseDir, "entities", "patterns"), { recursive: true });
  await mkdir(join(baseDir, "entities", "corrections"), { recursive: true });
  await mkdir(join(baseDir, "entities", "preferences"), { recursive: true });
  await mkdir(join(baseDir, "entities", "concepts"), { recursive: true });
  await mkdir(join(baseDir, "weekly"), { recursive: true });
  await mkdir(join(baseDir, "meta"), { recursive: true });
}

function entityDirForType(type: string, baseDir: string): string {
  const map: Record<string, string> = {
    pattern: "entities/patterns",
    correction: "entities/corrections",
    preference: "entities/preferences",
    concept: "entities/concepts",
  };
  return join(baseDir, map[type] || "entities/concepts");
}

function wikilink(slug: string, label?: string): string {
  // Escape characters that break wikilink syntax: |, ], [
  const safeLabel = label?.replace(/[\|\[\]]/g, "-") ?? slug;
  return label ? `[[entities/${slug}|${safeLabel}]]` : `[[entities/${slug}]]`;
}

// ── SCHEMA.md — one-time bootstrap ──────────────────────────────

async function ensureSchema(baseDir: string, title: string): Promise<void> {
  const schemaPath = join(baseDir, "SCHEMA.md");
  try {
    await access(schemaPath);
    return; // Already exists
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      console.error("[AutoWiki] Failed to check schema path:", err);
      throw err;
    }
    // Create it
  }

  const schema = `# ${title} — Schema

> Auto-generated by the-brain plugin-auto-wiki.
> Last updated: ${formatDate(Date.now())}

## Domain
Personal coding knowledge — patterns, preferences, corrections, and concepts learned by the AI agent.

## Conventions
- **File names:** lowercase, hyphens, no spaces
- **Every page** must have YAML frontmatter
- **Wikilinks** format: \`[[entities/slug|Label]]\`
- **Every page** should link to at least 2 other pages
- **Raw dumps** are immutable — never edit files under \`raw/\`
- **Generated files** under \`meta/\` are auto-updated — never edit manually
- **Log** is append-only via the wiki generator

## Frontmatter Fields
\`\`\`yaml
---
title: Page Title
type: entity | concept | correction | preference | weekly-summary | raw-dump
created: YYYY-MM-DD
updated: YYYY-MM-DD
confidence: high | medium | low
source: cursor | claude | copilot
tags: [tag1, tag2]
connections: [related-page-slug]
---
\`\`\`

## Page Thresholds
- **Create page** when graph weight ≥ ${DEFAULT_CONFIG.minWeightForEntity} AND content exists
- **Update page** when graph node's weight or connections change significantly
- **Archive page** when weight stays below ${DEFAULT_CONFIG.minWeightForEntity} for 30+ days

## Confidence Mapping
- **High** (weight ≥ ${DEFAULT_CONFIG.highWeightThreshold}): Well-established pattern or preference
- **Medium** (weight ≥ ${DEFAULT_CONFIG.mediumWeightThreshold}): Emerging but not yet confirmed
- **Low** (weight < ${DEFAULT_CONFIG.mediumWeightThreshold}): Tentative — may change

## Tags
- code: typescript, python, go, rust, etc.
- domain: ml, backend, frontend, devops, research
- meta: convention, style, architecture, testing, tooling
- agent: cursor, claude, copilot, hermes

`;

  await writeFile(schemaPath, schema, "utf-8");
}

// ── Generate wiki content ───────────────────────────────────────

export function createAutoWikiPlugin(
  db: BrainDB,
  config: Partial<AutoWikiConfig> = {}
) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const SLOT = "auto-wiki"; // For tracking what's been processed

  // ── 1. Raw memory dump ──────────────────────────────────────

  async function generateRawDump(memories: Memory[]): Promise<WikiPage> {
    const now = Date.now();
    const date = formatDate(now);
    const slug = `memory-dump-${date}`;

    let body = `# Raw Memory Dump — ${date}\n\n`;
    body += `> Immutable snapshot of all memories at generation time.\n\n`;
    body += `| # | Layer | Source | Surprise | Content |\n`;
    body += `|---|-------|--------|----------|--------|\n`;

    for (let i = 0; i < Math.min(memories.length, cfg.maxRawMemories); i++) {
      const m = memories[i];
      const content = escapeMd(m.content.slice(0, 120));
      const surprise = m.surpriseScore !== undefined ? m.surpriseScore.toFixed(2) : "-";
      body += `| ${i + 1} | ${m.layer} | ${m.source} | ${surprise} | ${content} |\n`;
    }

    body += `\n---\n*Generated by the-brain plugin-auto-wiki*\n`;

    return {
      path: `raw/${slug}.md`,
      slug,
      frontmatter: {
        title: `Raw Memory Dump — ${date}`,
        type: "raw-dump",
        created: date,
        updated: date,
        source: "the-brain",
        tags: ["raw", "memory-dump"],
        confidence: "high",
      },
      body,
    };
  }

  // ── 2. Entity pages from graph nodes ────────────────────────

  async function generateEntityPage(
    node: GraphNodeRecord,
    nodeSlug: string
  ): Promise<WikiPage> {
    const date = formatDate(node.timestamp);
    const today = formatDate(Date.now());
    const confidence = weightToConfidence(node.weight, cfg);

    // Build wikilinks to connected nodes
    const connectedLabels: string[] = [];
    for (const connId of node.connections) {
      const conn = await db.getGraphNode(connId).catch((err) => {
        console.error("[AutoWiki] Failed to get graph node:", connId, err);
        return undefined;
      });
      if (conn) {
        connectedLabels.push(wikilink(slugify(conn.label), conn.label));
      }
    }

    const typeLabel =
      node.type === "pattern"
        ? "Coding Pattern"
        : node.type === "correction"
          ? "Correction"
          : node.type === "preference"
            ? "Preference"
            : "Concept";

    let body = `## ${escapeMd(node.label)}\n\n`;
    body += `${escapeMd(node.content)}\n\n`;

    body += `### Details\n\n`;
    body += `- **Type:** ${typeLabel}\n`;
    body += `- **Weight:** ${node.weight.toFixed(2)}\n`;
    body += `- **Confidence:** ${confidence}\n`;
    body += `- **Source:** ${node.source}\n`;
    body += `- **Created:** ${date}\n`;

    if (connectedLabels.length > 0) {
      body += `\n### Connections\n\n`;
      for (const link of connectedLabels) {
        body += `- ${link}\n`;
      }
    }

    return {
      path: `entities/${node.type}s/${nodeSlug}.md`,
      slug: nodeSlug,
      frontmatter: {
        title: node.label,
        type: node.type,
        created: date,
        updated: today,
        confidence,
        source: node.source,
        tags: [node.type, node.source],
        connections: node.connections.length > 0 ? node.connections : undefined,
        weight: node.weight.toFixed(2),
      },
      body,
    };
  }

  // ── 3. Weekly summary ───────────────────────────────────────

  async function generateWeeklySummary(
    memories: Memory[],
    nodes: GraphNodeRecord[],
    stats: Awaited<ReturnType<BrainDB["getStats"]>>,
    weekSlug: string
  ): Promise<WikiPage> {
    const today = formatDate(Date.now());
    const byType = new Map<string, GraphNodeRecord[]>();
    for (const n of nodes) {
      const arr = byType.get(n.type) ?? [];
      arr.push(n);
      byType.set(n.type, arr);
    }

    const byLayer: Record<string, Memory[]> = {};
    for (const m of memories) {
      (byLayer[m.layer] ??= []).push(m);
    }

    const surprising = memories.filter((m) => (m.surpriseScore ?? 0) > 0.5);
    const newThisWeek = nodes.filter(
      (n) => Date.now() - n.timestamp < 7 * 86400 * 1000
    );

    let body = `# Weekly Summary — Week ${weekSlug}\n\n`;
    body += `> Generated: ${today}\n\n`;

    // Stats
    body += `## 📊 Stats\n\n`;
    body += `- **Sessions:** ${stats.sessions}\n`;
    body += `- **Total memories:** ${stats.memories}\n`;
    body += `- **Graph nodes:** ${stats.graphNodes}\n`;
    body += `- **New this week:** ${newThisWeek.length} nodes\n`;
    body += `- **Surprising moments:** ${surprising.length}\n\n`;

    // Surprising moments
    if (surprising.length > 0) {
      body += `## 💡 Surprising Interactions\n\n`;
      for (const s of surprising.slice(0, 10)) {
        const content = escapeMd(s.content.slice(0, 300));
        body += `- **${formatDate(s.timestamp)}** (score: ${(s.surpriseScore ?? 0).toFixed(2)}) — ${content}\n`;
      }
      body += "\n";
    }

    // Graph nodes by type
    for (const [type, typeNodes] of byType) {
      body += `## 🕸️ ${type.charAt(0).toUpperCase() + type.slice(1)}s\n\n`;
      for (const n of typeNodes.slice(0, 15)) {
        const link = wikilink(slugify(n.label), n.label);
        body += `- ${link} — weight: ${n.weight.toFixed(2)}, confidence: ${weightToConfidence(n.weight, cfg)}\n`;
        body += `  ${escapeMd(n.content.slice(0, 150))}\n`;
      }
      body += "\n";
    }

    body += `---\n\n*Generated by the-brain — open memory platform for AI*\n`;

    return {
      path: `weekly/week-${weekSlug}.md`,
      slug: `week-${weekSlug}`,
      frontmatter: {
        title: `Weekly Summary — ${weekSlug}`,
        type: "weekly-summary",
        created: today,
        updated: today,
        confidence: "high",
        source: "the-brain",
        tags: ["weekly", "summary"],
        memoryCount: memories.length,
        graphNodeCount: nodes.length,
      },
      body,
    };
  }

  // ── 4. Index & Meta ─────────────────────────────────────────

  async function generateIndex(
    pages: WikiPage[],
    stats: Awaited<ReturnType<BrainDB["getStats"]>>
  ): Promise<string> {
    const now = formatDate(Date.now());

    // Group pages by section
    const sections: Record<string, WikiPage[]> = {};
    for (const p of pages) {
      const section = p.path.startsWith("entities/")
        ? p.path.split("/")[1] // "patterns", "corrections", "preferences", "concepts"
        : p.path.startsWith("raw/")
          ? "raw"
          : p.path.startsWith("weekly/")
            ? "weekly"
            : "other";
      (sections[section] ??= []).push(p);
    }

    let md = `# ${cfg.title}\n\n`;
    md += `> Content catalog. Every wiki page listed with a one-line summary.\n`;
    md += `> Last updated: ${now} | Total pages: ${pages.length}\n\n`;
    md += `## Stats\n\n`;
    md += `- **Sessions:** ${stats.sessions}\n`;
    md += `- **Memories:** ${stats.memories}\n`;
    md += `- **Graph nodes:** ${stats.graphNodes}\n`;
    md += `- **Wiki pages:** ${pages.length}\n\n`;

    const sectionOrder = ["patterns", "corrections", "preferences", "concepts", "weekly", "raw"];
    for (const section of sectionOrder) {
      const sectionPages = sections[section];
      if (!sectionPages || sectionPages.length === 0) continue;
      const label = section.charAt(0).toUpperCase() + section.slice(1);
      md += `## ${label}\n\n`;
      for (const p of sectionPages) {
        const fm = p.frontmatter;
        const slug = p.slug;
        const title = (fm.title as string) || slug;
        const confidence = fm.confidence as string;
        const updated = fm.updated as string;
        const emoji =
          confidence === "high"
            ? "🟢"
            : confidence === "medium"
              ? "🟡"
              : "🔴";
        md += `- ${emoji} __${slug}__ — ${escapeMd(title)} (${updated})\n`;
      }
      md += "\n";
    }

    return md;
  }

  async function generateRegistry(pages: WikiPage[]): Promise<string> {
    const registry: Record<string, unknown> = {};
    for (const p of pages) {
      registry[p.slug] = {
        path: p.path,
        title: p.frontmatter.title,
        type: p.frontmatter.type,
        created: p.frontmatter.created,
        updated: p.frontmatter.updated,
        confidence: p.frontmatter.confidence,
        tags: p.frontmatter.tags,
        connections: p.frontmatter.connections || [],
      };
    }
    return JSON.stringify(registry, null, 2);
  }

  async function generateBacklinks(pages: WikiPage[]): Promise<string> {
    // Build link graph from wikilinks in body
    const linkPattern = /\[\[([^\]]+)\]\]/g;
    const backlinks: Record<string, { slug: string; title: string; pages: string[] }> = {};

    // Initialize all pages
    for (const p of pages) {
      backlinks[p.slug] = { slug: p.slug, title: String(p.frontmatter.title ?? p.slug), pages: [] };
    }

    // Scan each page's body for links
    for (const p of pages) {
      let match;
      while ((match = linkPattern.exec(p.body)) !== null) {
        let target = match[1];
        // Strip alias: [[page|Label]] → page
        if (target.includes("|")) target = target.split("|")[0];
        // Strip entities/ prefix if present
        if (target.startsWith("entities/")) target = target.slice("entities/".length);

        const backlinkEntry = backlinks[target];
        if (backlinkEntry && !backlinkEntry.pages.includes(p.slug)) {
          backlinkEntry.pages.push(p.slug);
        }
      }
    }

    return JSON.stringify(backlinks, null, 2);
  }

  async function generateLogEntry(
    action: string,
    description: string,
    pagesCreated: string[],
    pagesUpdated: string[]
  ): Promise<string> {
    const date = formatDate(Date.now());
    let entry = `## [${date}] ${action} | ${description}\n\n`;
    if (pagesCreated.length > 0) {
      entry += `- **Created:**\n`;
      for (const p of pagesCreated) entry += `  - ${p}\n`;
    }
    if (pagesUpdated.length > 0) {
      entry += `- **Updated:**\n`;
      for (const p of pagesUpdated) entry += `  - ${p}\n`;
    }
    entry += "\n";
    return entry;
  }

  // ── 5. Lint ─────────────────────────────────────────────────

  interface LintResult {
    issues: { severity: "error" | "warning" | "info"; message: string; page?: string }[];
    pagesChecked: number;
  }

  async function lintWiki(pages: WikiPage[]): Promise<LintResult> {
    const issues: LintResult["issues"] = [];
    const linkPattern = /\[\[([^\]]+)\]\]/g;
    const pageSlugs = new Set(pages.map((p) => p.slug));

    for (const p of pages) {
      // Check frontmatter completeness
      const required = ["title", "type", "created", "updated"];
      for (const field of required) {
        if (!p.frontmatter[field]) {
          issues.push({
            severity: "warning",
            message: `Missing frontmatter field: ${field}`,
            page: p.slug,
          });
        }
      }

      // Check broken wikilinks
      let match;
      while ((match = linkPattern.exec(p.body)) !== null) {
        let target = match[1];
        if (target.includes("|")) target = target.split("|")[0];
        if (target.startsWith("entities/")) target = target.slice("entities/".length);
        if (!pageSlugs.has(target)) {
          issues.push({
            severity: "error",
            message: `Broken wikilink to [[${target}]]`,
            page: p.slug,
          });
        }
      }
    }

    // Find orphan pages (no inbound links)
    const backlinks = new Set<string>();
    for (const p of pages) {
      let match;
      while ((match = linkPattern.exec(p.body)) !== null) {
        let target = match[1];
        if (target.includes("|")) target = target.split("|")[0];
        if (target.startsWith("entities/")) target = target.slice("entities/".length);
        backlinks.add(target);
      }
    }
    for (const p of pages) {
      if (p.path.startsWith("entities/") && !backlinks.has(p.slug)) {
        issues.push({
          severity: "info",
          message: `Orphan page — no inbound links`,
          page: p.slug,
        });
      }
    }

    return { issues, pagesChecked: pages.length };
  }

  // ── Main generation ─────────────────────────────────────────

  async function generateWiki(): Promise<{ filepath: string; filename: string }> {
    await ensureDirs(cfg.outputDir);
    await ensureSchema(cfg.outputDir, cfg.title);

    const now = Date.now();
    const date = formatDate(now);
    const filename = `wiki-${date}.md`;
    const filepath = join(cfg.outputDir, filename);

    // Gather data
    const allMemories = await db.getRecentMemories(168); // Last 7 days
    const allNodes = await db.getHighWeightNodes(cfg.minWeightForEntity);
    const stats = await db.getStats();

    // Build all wiki pages
    const pages: WikiPage[] = [];

    // 1. Raw dump
    const rawDump = await generateRawDump(allMemories);
    pages.push(rawDump);

    // 2. Entity pages from graph nodes
    const entitySlugs = new Set<string>();
    const createdPages: string[] = [];
    const updatedPages: string[] = [];

    for (const node of allNodes.slice(0, cfg.maxEntities)) {
      const nodeSlug = slugify(node.label);
      if (entitySlugs.has(nodeSlug)) continue;
      entitySlugs.add(nodeSlug);

      const entityPage = await generateEntityPage(node, nodeSlug);
      pages.push(entityPage);

      // Check if file already exists
      const entityPath = join(cfg.outputDir, entityPage.path);
      try {
        await access(entityPath);
        updatedPages.push(entityPage.path);
      } catch (err: any) {
        if (err?.code !== "ENOENT") {
          console.error("[AutoWiki] Failed to check entity path:", err);
        }
        createdPages.push(entityPage.path);
      }
    }

    // 3. Weekly summary
    const weekSlug = formatWeek(now);
    const weeklyPage = await generateWeeklySummary(allMemories, allNodes, stats, weekSlug);
    pages.push(weeklyPage);

    // 4. Index
    const indexContent = await generateIndex(pages, stats);
    await writeFile(join(cfg.outputDir, "index.md"), indexContent, "utf-8");

    // 5. Registry + Backlinks (meta)
    const registryJson = await generateRegistry(pages);
    await writeFile(join(cfg.outputDir, "meta", "registry.json"), registryJson, "utf-8");
    const backlinksJson = await generateBacklinks(pages);
    await writeFile(join(cfg.outputDir, "meta", "backlinks.json"), backlinksJson, "utf-8");

    // Write all pages
    for (const p of pages) {
      const fullPath = join(cfg.outputDir, p.path);
      await mkdir(join(fullPath, ".."), { recursive: true });
      const content = frontmatterYaml(p.frontmatter) + p.body;
      await writeFile(fullPath, content, "utf-8");
    }

    // Write wiki file (top-level summary)
    const wikiContent = `# ${cfg.title} — ${date}\n\n`;
    const wikiBody = wikiContent +
      `## Pages Generated\n\n- **Raw dump:** ${rawDump.path}\n` +
      `- **Entity pages:** ${entitySlugs.size}\n` +
      `- **Weekly summary:** ${weeklyPage.path}\n` +
      `- **Index:** index.md\n` +
      `- **Registry:** meta/registry.json\n` +
      `- **Backlinks:** meta/backlinks.json\n\n` +
      `## Lint\n\n` +
      `Pages checked: ${pages.length}\n\n` +
      `---\n*Generated by the-brain — open memory platform for AI*\n`;
    await writeFile(filepath, wikiBody, "utf-8");

    // Append to log
    const logPath = join(cfg.outputDir, "log.md");
    let logContent = "# Wiki Log\n\n> Append-only chronological action log.\n\n";
    try {
      logContent = await readFile(logPath, "utf-8");
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        console.error("[AutoWiki] Failed to read log file:", err);
      }
      // First run — write header
    }
    logContent += await generateLogEntry(
      "generate", `Wiki generated — ${date}`,
      [...createdPages, "index.md", `meta/registry.json`, `meta/backlinks.json`],
      updatedPages
    );
    await writeFile(logPath, logContent, "utf-8");

    // Lint
    const lintResult = await lintWiki(pages);
    const lintPath = join(cfg.outputDir, "meta", "lint-report.md");
    let lintMd = `# Lint Report — ${date}\n\n`;
    lintMd += `- **Pages checked:** ${lintResult.pagesChecked}\n`;
    lintMd += `- **Issues found:** ${lintResult.issues.length}\n\n`;
    const errorCount = lintResult.issues.filter((i) => i.severity === "error").length;
    const warningCount = lintResult.issues.filter((i) => i.severity === "warning").length;
    const infoCount = lintResult.issues.filter((i) => i.severity === "info").length;
    lintMd += `- **Errors:** ${errorCount} | **Warnings:** ${warningCount} | **Info:** ${infoCount}\n\n`;
    for (const issue of lintResult.issues) {
      const emoji = issue.severity === "error" ? "🔴" : issue.severity === "warning" ? "🟡" : "💡";
      lintMd += `- ${emoji} [${issue.severity}] ${issue.message}${issue.page ? ` (${issue.page})` : ""}\n`;
    }
    await writeFile(lintPath, lintMd, "utf-8");

    return { filepath, filename };
  }

  // ── Plugin Definition ───────────────────────────────────────

  const plugin = definePlugin({
    name: "@the-brain-dev/plugin-auto-wiki",
    version: "2.0.0",
    description:
      "Karpathy-style LLM Wiki — raw dumps, entity pages from graph nodes, weekly summaries, registry, backlinks, and lint",

    async setup(hooks) {
      // On consolidation complete: generate wiki
      hooks.hook(HookEvent.CONSOLIDATE_COMPLETE, async () => {
        try {
          const { filepath, filename } = await generateWiki();
          await hooks.callHook("wiki:generated", { filepath, filename });
        } catch (err) {
          await hooks.callHook("plugin:error", {
            name: "@the-brain-dev/plugin-auto-wiki",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });

      // Allow manual trigger via hook
      hooks.hook("wiki:generate", async () => {
        return await generateWiki();
      });
    },

    // Expose for direct CLI invocation (the-brain wiki generate)
    async generateWiki(): Promise<{ filepath: string; filename: string }> {
      return await generateWiki();
    },

    /** Implement OutputPlugin interface */
    asOutputPlugin(): OutputPlugin {
      return {
        name: "@the-brain-dev/plugin-auto-wiki",
        async generate(ctx: OutputGenerateContext): Promise<OutputResult> {
          const { filepath, filename } = await generateWiki();
          return {
            summary: `Wiki generated: ${filename}`,
            artifacts: [
              { path: filepath, type: "file", bytes: undefined },
            ],
          };
        },
        getConfig() {
          return {
            outputDir: cfg.outputDir,
            schedule: cfg.schedule,
            title: cfg.title,
            maxEntities: cfg.maxEntities,
          };
        },
      };
    },
  });

  return plugin;
}

export default createAutoWikiPlugin;

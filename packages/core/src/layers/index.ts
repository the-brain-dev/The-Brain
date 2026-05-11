import type {
  PromptContext,
  InteractionContext,
  ConsolidationContext,
  MemoryFragment,
  SurpriseGateResult,
  MemoryLayer as ML,
  Memory,
  GraphNodeRecord,
} from "../types";
import { MemoryLayer } from "../types";

// ── Instant Layer Interface ─────────────────────────────────────
/**
 * Instant Layer (Working Memory) — injects context before each prompt.
 * Plugins implementing this: @the-brain/plugin-graph-memory, any Vector DB RAG.
 */
export interface InstantLayerPlugin {
  readonly layer: MemoryLayer.INSTANT;
  /** Called before every prompt — inject relevant context */
  beforePrompt(ctx: PromptContext): Promise<void>;
}

// ── Selection Layer Interface ──────────────────────────────────
/**
 * Selection Layer (Gatekeeper) — evaluates interactions and decides
 * what gets promoted to Deep Layer.
 * Plugins implementing this: @the-brain/plugin-spm-curator, LLM-as-judge.
 */
export interface SelectionLayerPlugin {
  readonly layer: MemoryLayer.SELECTION;
  /** Evaluate an interaction — return a surprise score */
  evaluate(ctx: InteractionContext): Promise<SurpriseGateResult>;
  /** Promote worthy fragments to Deep Layer */
  promote(ctx: InteractionContext): Promise<MemoryFragment[]>;
}

// ── Deep Layer Interface ────────────────────────────────────────
/**
 * Deep Layer (Long-Term) — consolidates knowledge permanently.
 * Plugins: @the-brain/trainer-local-mlx, dense Vector DB, auto-wiki.
 */
export interface DeepLayerPlugin {
  readonly layer: MemoryLayer.DEEP;
  /** Consolidate curated fragments into permanent storage */
  consolidate(ctx: ConsolidationContext): Promise<void>;
}

// ── Harvester Interface ─────────────────────────────────────────
/**
 * Data Harvester — polls external sources (IDE logs, etc.)
 * and feeds new interactions into the pipeline.
 */
export interface HarvesterPlugin {
  readonly name: string;
  /** Start polling the data source */
  start(): Promise<void>;
  /** Stop polling */
  stop(): Promise<void>;
  /** Manually trigger a poll */
  poll(): Promise<InteractionContext[]>;
}

// ═══════════════════════════════════════════════════════════════
// NEW: Previously hardcoded — now pluggable
// ═══════════════════════════════════════════════════════════════

// ── Content Cleaner Interface ───────────────────────────────────
/**
 * Content Cleaner — transforms raw memory/ingested content into
 * clean, context-worthy summaries. Replaces the hardcoded
 * content-cleaner.ts module.
 *
 * Default: @the-brain/content-cleaner-default (Claude XML / progress)
 * Swap: domain-specific cleaner (legal, medical, academic), LLM-based.
 */
export interface ContentCleanerPlugin {
  readonly name: string;
  /** Clean raw content into a structured summary */
  clean(raw: string): Promise<CleanedContent>;
  /** Clean a graph node label (strip code, keep concepts) */
  cleanGraphLabel(label: string, type: string): Promise<string>;
  /** Deduplicate cleaned contents by signal quality */
  deduplicate(items: CleanedContent[]): Promise<CleanedContent[]>;
}

export interface CleanedContent {
  summary: string;
  action: string;
  project: string | null;
  userRequest: string | null;
  type: "observation" | "user-request" | "progress" | "unknown";
}

// ── Storage Backend Interface ───────────────────────────────────
/**
 * Storage Backend — abstracts database operations behind a
 * common interface. Replaces the hardcoded SQLite/BrainDB.
 *
 * Default: @the-brain/storage-sqlite (Drizzle + bun:sqlite)
 * Swap: Postgres (@the-brain/storage-pg), LibSQL, Vector DB.
 */
export interface StorageBackend {
  /** Initialize tables/schema */
  init(): Promise<void>;

  // Sessions
  createSession(session: { id: string; startedAt: number; endedAt?: number; source: string; interactionCount: number; metadata?: Record<string, unknown> }): Promise<void>;
  getSession(id: string): Promise<Record<string, unknown> | undefined>;
  getRecentSessions(limit?: number): Promise<Record<string, unknown>[]>;

  // Memories
  insertMemory(memory: Memory): Promise<void>;
  insertMemories(memories: Memory[]): Promise<void>;
  getMemoriesByLayer(layer: MemoryLayer, limit?: number): Promise<Memory[]>;
  getSurprisingMemories(threshold?: number): Promise<Memory[]>;
  updateMemory(id: string, updates: Partial<Omit<Memory, "id">>): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  getAllMemories(maxResults?: number): Promise<Memory[]>;
  getRecentMemories(hoursAgo?: number): Promise<Memory[]>;

  // Graph Nodes
  upsertGraphNode(node: Omit<GraphNodeRecord, "id"> & { id?: string }): Promise<GraphNodeRecord>;
  getGraphNode(id: string): Promise<GraphNodeRecord | undefined>;
  getConnectedNodes(nodeId: string): Promise<GraphNodeRecord[]>;
  getHighWeightNodes(minWeight?: number): Promise<GraphNodeRecord[]>;
  searchGraphNodes(query: string): Promise<GraphNodeRecord[]>;

  // Stats & maintenance
  getStats(): Promise<Record<string, unknown>>;
  deleteOldMemories(olderThanDays?: number): Promise<number>;
  close(): Promise<void>;
}

// ── Scheduler Interface ─────────────────────────────────────────
/**
 * Scheduler — manages timed/recurring tasks. Replaces the hardcoded
 * setInterval in daemon.ts.
 *
 * Default: @the-brain/scheduler-interval (simple setInterval)
 * Swap: cron-based (@the-brain/scheduler-croner), distributed (BullMQ).
 */
export interface SchedulerPlugin {
  readonly name: string;
  /** Add a recurring task. Returns a handle for cancellation. */
  schedule(name: string, intervalMs: number, task: () => Promise<void>): SchedulerHandle;
  /** Schedule a one-shot task after delay */
  scheduleOnce(name: string, delayMs: number, task: () => Promise<void>): SchedulerHandle;
  /** Cancel a scheduled task */
  cancel(handle: SchedulerHandle): void;
  /** List active tasks */
  list(): Array<{ name: string; handle: SchedulerHandle }>;
  /** Shutdown all tasks */
  shutdown(): Promise<void>;
}

export interface SchedulerHandle {
  readonly id: string;
  readonly name: string;
}

// ── Output Plugin Interface ─────────────────────────────────────
/**
 * Output Plugin — transforms consolidated knowledge into an
 * exportable format. Generalizes the auto-wiki plugin to support
 * any output target.
 *
 * Default: @the-brain/plugin-auto-wiki (Markdown wiki + registry)
 * Swap: @the-brain/output-notion, @the-brain/output-json-export,
 *       @the-brain/output-obsidian, @the-brain/output-slack-digest.
 */
export interface OutputPlugin {
  readonly name: string;
  /** Generate output from a consolidation event */
  generate(ctx: OutputGenerateContext): Promise<OutputResult>;
  /** Get this plugin's config schema for CLI/tooling */
  getConfig?(): Record<string, unknown>;
}

export interface OutputGenerateContext {
  /** Consolidated memories */
  memories: Memory[];
  /** Relevant graph nodes */
  graphNodes: GraphNodeRecord[];
  /** Session statistics */
  stats: Record<string, unknown>;
  /** Plugin-specific config */
  config?: Record<string, unknown>;
}

export interface OutputResult {
  /** Human-readable description of what was generated */
  summary: string;
  /** List of output artifacts (files, URLs, etc.) */
  artifacts: Array<{
    path: string;
    type: "file" | "url" | "database";
    bytes?: number;
  }>;
}
// ── Layer Router ────────────────────────────────────────────────
/**
 * Routes data through the 3-layer cognitive architecture.
 * This is what the daemon calls on every tick.
 */
export class LayerRouter {
  private instantPlugins: InstantLayerPlugin[] = [];
  private selectionPlugins: SelectionLayerPlugin[] = [];
  private deepPlugins: DeepLayerPlugin[] = [];

  registerInstant(plugin: InstantLayerPlugin): void {
    this.instantPlugins.push(plugin);
  }

  registerSelection(plugin: SelectionLayerPlugin): void {
    this.selectionPlugins.push(plugin);
  }

  registerDeep(plugin: DeepLayerPlugin): void {
    this.deepPlugins.push(plugin);
  }

  /** Run Instant Layer — inject context before prompt */
  async runInstant(ctx: PromptContext): Promise<PromptContext> {
    for (const plugin of this.instantPlugins) {
      await plugin.beforePrompt(ctx);
    }
    return ctx;
  }

  /** Run Selection Layer — evaluate and filter interactions */
  async runSelection(ctx: InteractionContext): Promise<{
    results: SurpriseGateResult[];
    promoted: MemoryFragment[];
  }> {
    const results: SurpriseGateResult[] = [];
    const promoted: MemoryFragment[] = [];

    for (const plugin of this.selectionPlugins) {
      const result = await plugin.evaluate(ctx);
      results.push(result);

      if (result.isSurprising) {
        const fragments = await plugin.promote(ctx);
        promoted.push(...fragments);
      }
    }

    return { results, promoted };
  }

  /** Run Deep Layer — consolidate curated knowledge */
  async runDeep(ctx: ConsolidationContext): Promise<void> {
    for (const plugin of this.deepPlugins) {
      await plugin.consolidate(ctx);
    }
  }

  /** Get stats about loaded plugins per layer */
  getStats() {
    return {
      instant: this.instantPlugins.length,
      selection: this.selectionPlugins.length,
      deep: this.deepPlugins.length,
    };
  }
}

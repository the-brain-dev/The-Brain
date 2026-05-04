import type {
  PromptContext,
  InteractionContext,
  ConsolidationContext,
  MemoryFragment,
  SurpriseGateResult,
  MemoryLayer as ML,
} from "../types";
import { MemoryLayer } from "../types";

// ── Instant Layer Interface ─────────────────────────────────────
/**
 * Instant Layer (Working Memory) — injects context before each prompt.
 * Plugins implementing this: @my-brain/plugin-graph-memory, any Vector DB RAG.
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
 * Plugins implementing this: @my-brain/plugin-spm-curator, LLM-as-judge.
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
 * Plugins: @my-brain/trainer-local-mlx, dense Vector DB, auto-wiki.
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

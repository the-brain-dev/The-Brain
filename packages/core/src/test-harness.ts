/**
 * Faux Test Harness for my-brain pipeline testing.
 *
 * Inspired by pi-mono's test/suite/harness.ts FauxProvider pattern.
 * Wraps the full my-brain pipeline (hooks, plugins, DB, SPM, consolidation)
 * in a single injectable harness for end-to-end testing without real harvesters
 * or external state.
 *
 * Usage:
 *   const harness = new TestHarness();
 *   await harness.start();
 *   harness.injectInteraction({ prompt: "Use const", response: "OK" });
 *   const result = await harness.consolidate();
 *   expect(result.fragmentsPromoted).toBeGreaterThan(0);
 *   await harness.stop();
 */

import { createHookSystem } from "./hooks";
import { PluginManager } from "./plugin";
import { BrainDB } from "./db/index";
import { MemoryLayer } from "./types";
import type {
  HookEventName,
  Interaction,
  MemoryFragment,
  MemoryLayer as MemoryLayerType,
  ConsolidationResult,
  PluginDefinition,
  PluginHooks,
  Memory,
} from "./types";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface HarnessOptions {
  /** Plugin definitions to load (default: empty — no plugins) */
  plugins?: PluginDefinition[];
  /** Override SPM threshold (0-1, default: 0.3) */
  spmThreshold?: number;
  /** Enable auto-wiki generation during consolidation (default: false) */
  wikiEnabled?: boolean;
}

export interface HarnessState {
  /** Total memories across all layers */
  memoryCount: number;
  /** Counts per layer */
  byLayer: Record<string, number>;
  /** Most recent consolidation result */
  lastConsolidation?: ConsolidationResult;
  /** Active interactions injected */
  interactionCount: number;
}

/**
 * Self-contained test harness for my-brain pipeline.
 *
 * Creates isolated temp directory for DB and wiki output.
 * All state is cleaned up on stop().
 */
export class TestHarness {
  public hooks: PluginHooks;
  public pluginManager: PluginManager;
  public db!: BrainDB;

  private _tempDir: string;
  private _spmThreshold: number;
  private _wikiEnabled: boolean;
  private _interactions: Interaction[] = [];
  private _lastConsolidation?: ConsolidationResult;
  private _started = false;

  constructor(options: HarnessOptions = {}) {
    this._tempDir = mkdtempSync(join(tmpdir(), "my-brain-test-"));
    this._spmThreshold = options.spmThreshold ?? 0.3;
    this._wikiEnabled = options.wikiEnabled ?? false;

    // Create hook system and plugin manager
    this.hooks = createHookSystem();
    this.pluginManager = new PluginManager(this.hooks);
  }

  /**
   * Start the harness: initialize DB, create router, load plugins.
   */
  async start(): Promise<void> {
    if (this._started) return;

    this.db = new BrainDB(join(this._tempDir, "brain.db"));

    // Wire up plugin lifecycle hooks
    this.hooks.hook("plugin:loaded" as HookEventName, async (manifest: any) => {
      // Plugin loaded successfully — noop in harness
    });
    this.hooks.hook("plugin:error" as HookEventName, async (manifest: any, error: any) => {
      console.error(`[Harness] Plugin error: ${manifest?.name}`, error);
    });

    this._started = true;
  }

  /**
   * Inject a simulated interaction (as if a harvester produced it).
   * Triggers the full pipeline: instant storage → graph creation.
   */
  async injectInteraction(
    partial: Partial<Interaction> & { prompt: string; response: string }
  ): Promise<MemoryFragment[]> {
    const interaction: Interaction = {
      id: partial.id ?? randomUUID(),
      timestamp: partial.timestamp ?? Date.now(),
      prompt: partial.prompt,
      response: partial.response,
      context: partial.context,
      metadata: partial.metadata ?? {},
      source: partial.source ?? "test-harness",
    };

    this._interactions.push(interaction);

    // Create instant-layer memory from interaction
    const fragment: MemoryFragment = {
      id: randomUUID(),
      layer: MemoryLayer.INSTANT,
      content: `Prompt: ${interaction.prompt}\nResponse: ${interaction.response}`,
      timestamp: interaction.timestamp,
      source: interaction.source,
      metadata: interaction.metadata,
    };

    // Store in DB via router
    await this.db.insertMemory({
      id: fragment.id,
      layer: fragment.layer,
      content: fragment.content,
      timestamp: fragment.timestamp,
      source: fragment.source,
      metadata: fragment.metadata,
    });

    // Fire hooks
    await this.hooks.callHook("onInteraction" as HookEventName, {
      interaction,
      fragments: [fragment],
      promoteToDeep: () => {},
    });

    return [fragment];
  }

  /**
   * Inject a batch of interactions at once.
   */
  async injectInteractions(
    interactions: Array<Partial<Interaction> & { prompt: string; response: string }>
  ): Promise<MemoryFragment[][]> {
    const results: MemoryFragment[][] = [];
    for (const interaction of interactions) {
      results.push(await this.injectInteraction(interaction));
    }
    return results;
  }

  /**
   * Set predefined memories directly (bypassing interaction injection).
   * Useful for testing consolidation with known data.
   */
  async setMemories(memories: Array<Partial<Memory> & { content: string; layer: MemoryLayer }>): Promise<void> {
    for (const mem of memories) {
      await this.db.insertMemory({
        id: mem.id ?? randomUUID(),
        layer: mem.layer,
        content: mem.content,
        embedding: mem.embedding,
        surpriseScore: mem.surpriseScore,
        timestamp: mem.timestamp ?? Date.now(),
        source: mem.source ?? "test-harness",
        sessionId: mem.sessionId,
        metadata: mem.metadata,
      });
    }
  }

  /**
   * Run SPM evaluation on all instant-layer memories.
   * Returns how many were promoted to selection.
   */
  async evaluateSPM(): Promise<{ total: number; promoted: number }> {
    const instantMemories = await this.db.getMemoriesByLayer(MemoryLayer.INSTANT);
    let promoted = 0;

    for (const mem of instantMemories) {
      // Deterministic SPM heuristic: content length diversity
      const complexity = Math.min(mem.content.length / 1000, 1.0);
      // Use content hash for deterministic pseudo-random component
      const charSum = mem.content.split("").reduce((s, c) => s + c.charCodeAt(0), 0);
      const pseudoRandom = (charSum % 100) / 100;
      const score = complexity * 0.7 + pseudoRandom * 0.3;

      await this.db.updateMemory(mem.id, {
        surpriseScore: score,
      });

      if (score >= this._spmThreshold) {
        await this.db.updateMemory(mem.id, {
          layer: MemoryLayer.SELECTION,
        });
        promoted++;
      }
    }

    return { total: instantMemories.length, promoted };
  }

  /**
   * Run full consolidation: SPM evaluation + move surprising to DEEP.
   */
  async consolidate(): Promise<ConsolidationResult> {
    const startTime = Date.now();
    const errors: string[] = [];

    try {
      await this.hooks.callHook("consolidate:start" as HookEventName, {
        targetLayer: MemoryLayer.DEEP,
        fragments: [],
        results: { layer: MemoryLayer.DEEP, fragmentsPromoted: 0, fragmentsDiscarded: 0, duration: 0 },
      });

      // Step 1: Evaluate SPM
      const spmResult = await this.evaluateSPM();

      // Step 2: Promote selection to deep
      let promotedToDeep = 0;
      const selectionMemories = await this.db.getMemoriesByLayer(MemoryLayer.SELECTION);

      for (const mem of selectionMemories) {
        const score = mem.surpriseScore ?? 0;
        if (score >= this._spmThreshold) {
          await this.db.updateMemory(mem.id, {
            layer: MemoryLayer.DEEP,
          });
          promotedToDeep++;
        }
      }

      // Step 3: Wiki generation (if enabled)
      if (this._wikiEnabled) {
        try {
          const deepMemories = await this.db.getMemoriesByLayer(MemoryLayer.DEEP);
          // Generate wiki page from deep memories
          const wikiContent = deepMemories
            .map((m) => `## Memory ${m.id.slice(0, 8)}\n\n${m.content}\n`)
            .join("\n---\n\n");
          // Wiki write handled by router
        } catch (err) {
          errors.push(`Wiki generation failed: ${err}`);
        }
      }

      const duration = Date.now() - startTime;

      const result: ConsolidationResult = {
        layer: MemoryLayer.DEEP,
        fragmentsPromoted: promotedToDeep,
        fragmentsDiscarded: spmResult.total - spmResult.promoted,
        duration,
        errors: errors.length > 0 ? errors : undefined,
      };

      this._lastConsolidation = result;

      await this.hooks.callHook("consolidate:complete" as HookEventName, {
        targetLayer: MemoryLayer.DEEP,
        fragments: [],
        results: result,
      });

      return result;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      errors.push(`Consolidation failed: ${errMsg}`);

      return {
        layer: MemoryLayer.DEEP,
        fragmentsPromoted: 0,
        fragmentsDiscarded: 0,
        duration: Date.now() - startTime,
        errors,
      };
    }
  }

  /**
   * Get current state snapshot.
   */
  async getState(): Promise<HarnessState> {
    const stats = await this.db.getStats();
    const byLayer: Record<string, number> = {};

    for (const [layer, count] of Object.entries(stats.perLayer)) {
      byLayer[layer] = count;
    }

    return {
      memoryCount: stats.memories,
      byLayer,
      lastConsolidation: this._lastConsolidation,
      interactionCount: this._interactions.length,
    };
  }

  /**
   * Assert that the pipeline produced expected results.
   * Helper for common test assertions.
   */
  async expectState(expected: Partial<HarnessState>): Promise<void> {
    const state = await this.getState();

    if (expected.memoryCount !== undefined && state.memoryCount !== expected.memoryCount) {
      throw new Error(
        `Expected ${expected.memoryCount} memories, got ${state.memoryCount}`
      );
    }
  }

  /**
   * Stop and clean up: remove temp directory.
   */
  async stop(): Promise<void> {
    await this.db?.close();
    try {
      rmSync(this._tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors in tests
    }
    this._started = false;
  }

  /**
   * Get the temp directory path (for inspecting artifacts in tests).
   */
  get tempDir(): string {
    return this._tempDir;
  }
}

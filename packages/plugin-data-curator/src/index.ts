/**
 * @the-brain-dev/plugin-data-curator
 *
 * Quality-gated data curation pipeline for training data.
 * Full Option D: Heuristics → LLM Judge → LLM Rewriter.
 *
 * Architecture:
 *   1. Heuristics gate (regex) — fast, cheap, catches ~70% garbage
 *   2. LLM Judge — OpenAI-compatible backend scores 1-10, rejects < threshold
 *   3. LLM Rewriter — salvages borderline interactions (score 4-7)
 *
 * Hooks into SELECTION_EVALUATE, running BEFORE the SPM surprise gate.
 * Only quality-passing interactions proceed to surprise scoring.
 */

import {
  definePlugin,
  HookEvent,
  type InteractionContext,
  type MemoryFragment,
  type LLMBackend,
} from "@the-brain-dev/core";
import { evaluateHeuristics, type HeuristicReport } from "./heuristics";
import { judgeInteraction, type QualityJudgment } from "./judge";
import { rewriteInteraction, type RewrittenExample } from "./rewriter";

// ── Configuration ──────────────────────────────────────────────────────────

export interface DataCuratorConfig {
  /** Minimum overall score (1-10) from LLM Judge to pass without rewrite */
  judgeThreshold: number;

  /** Score range (inclusive) where rewriting is attempted */
  rewriteRange: { min: number; max: number };

  /** Maximum concurrent LLM calls */
  maxConcurrent: number;

  /** LLM backend used for Judge and Rewriter (OpenAI-compatible) */
  backend: LLMBackend;

  /** Skip LLM entirely — heuristics only */
  heuristicsOnly: boolean;

  /** Skip Rewriter — reject low-score instead of rewriting */
  noRewrite: boolean;

  /** Optional locale-specific off-topic patterns (user-configurable, NOT hardcoded) */
  offTopicPatterns?: RegExp[];
}

const DEFAULT_BACKEND: LLMBackend = {
  provider: "ollama",
  baseUrl: "http://localhost:11434/v1",
  defaultModel: process.env.THE_BRAIN_CURATOR_MODEL || "qwen2.5:3b",
  fallbackModels: ["qwen2.5:1.5b"],
  timeoutMs: 30_000,
};

const DEFAULT_CONFIG: DataCuratorConfig = {
  judgeThreshold: 6,
  rewriteRange: { min: 4, max: 6 },
  maxConcurrent: 2,
  backend: DEFAULT_BACKEND,
  heuristicsOnly: false,
  noRewrite: false,
};

// ── Plugin ─────────────────────────────────────────────────────────────────

export function createDataCurator(configOverrides: Partial<DataCuratorConfig> = {}) {
  const config = { ...DEFAULT_CONFIG, ...configOverrides };
  const instance = new DataCuratorPlugin(config);

  const definition = definePlugin({
    name: "@the-brain-dev/plugin-data-curator",
    version: "0.1.0",
    description:
      "Quality-gated data curation — heuristics + LLM Judge + LLM Rewriter for training data",

    setup(hooks) {
      // Register as quality gate BEFORE SPM evaluate
      hooks.hook(HookEvent.SELECTION_EVALUATE, async (ctx: InteractionContext) => {
        const result = await instance.evaluate(ctx);
        // Publish quality report for observability
        await hooks.callHook("data-curator:evaluated", instance.lastReport, ctx);
      });

      // Absorb interaction for heuristics baseline
      hooks.hook(HookEvent.ON_INTERACTION, async (ctx: InteractionContext) => {
        instance.stats.totalInteractions++;
      });

      hooks.hook("data-curator:getInstance", () => instance);
    },

    teardown() {
      instance.reset();
    },
  });

  return { definition, instance };
}

// ── Quality Report ─────────────────────────────────────────────────────────

export interface QualityReport {
  passed: boolean;
  stage: "heuristics" | "judge" | "rewriter";
  heuristicReport?: HeuristicReport;
  judgment?: QualityJudgment;
  rewritten?: RewrittenExample;
  rejectReason?: string;
}

// ── Plugin Class ───────────────────────────────────────────────────────────

export class DataCuratorPlugin {
  readonly config: DataCuratorConfig;

  /** Stats for introspection */
  stats = {
    totalInteractions: 0,
    rejectedByHeuristics: 0,
    rejectedByJudge: 0,
    passedClean: 0,
    rewritten: 0,
    llmFailures: 0,
  };

  /** Most recent quality report (for hooks/observability) */
  lastReport?: QualityReport;

  constructor(config: DataCuratorConfig) {
    this.config = config;
  }

  /**
   * Main evaluation entry point.
   * Called by the plugin hook system before SPM evaluation.
   *
   * Mutates ctx.fragments — failed fragments are removed so
   * downstream plugins (SPM) don't see them.
   */
  async evaluate(ctx: InteractionContext): Promise<void> {
    const { interaction, fragments } = ctx;

    if (fragments.length === 0) return;

    const prompt = interaction.prompt ?? "";
    const response = interaction.response ?? "";

    // ── Stage 1: Heuristics ──────────────────────────────────────────
    const heuristicReport = evaluateHeuristics(prompt, response, this.config.offTopicPatterns);

    if (!heuristicReport.passed) {
      this.stats.rejectedByHeuristics++;
      this.lastReport = {
        passed: false,
        stage: "heuristics",
        heuristicReport,
        rejectReason: heuristicReport.rejectReason,
      };
      // Remove all fragments — nothing to promote
      ctx.fragments.length = 0;
      return;
    }

    // Heuristics-only mode — pass through
    if (this.config.heuristicsOnly) {
      this.stats.passedClean++;
      this.lastReport = {
        passed: true,
        stage: "heuristics",
        heuristicReport,
      };
      return;
    }

    // ── Stage 2: LLM Judge ───────────────────────────────────────────
    const judgment = await judgeInteraction(
      prompt,
      response,
      this.config.backend,
    );

    if (!judgment) {
      // LLM unavailable — fall back to heuristics pass
      this.stats.llmFailures++;
      this.stats.passedClean++;
      this.lastReport = {
        passed: true,
        stage: "heuristics",
        heuristicReport,
        rejectReason: "LLM unavailable, heuristics pass",
      };
      return;
    }

    // Score too low — reject outright
    if (judgment.overall < this.config.rewriteRange.min) {
      this.stats.rejectedByJudge++;
      this.lastReport = {
        passed: false,
        stage: "judge",
        heuristicReport,
        judgment,
        rejectReason: `judge score ${judgment.overall} < ${this.config.rewriteRange.min}`,
      };
      ctx.fragments.length = 0;
      return;
    }

    // Excellent — pass clean
    if (judgment.overall > this.config.rewriteRange.max) {
      this.stats.passedClean++;
      this.lastReport = {
        passed: true,
        stage: "judge",
        heuristicReport,
        judgment,
      };
      return;
    }

    // ── Stage 3: Rewriter (score in rewrite range) ────────────────────
    if (this.config.noRewrite) {
      // Rewriting disabled — reject instead
      this.stats.rejectedByJudge++;
      this.lastReport = {
        passed: false,
        stage: "judge",
        heuristicReport,
        judgment,
        rejectReason: `borderline score ${judgment.overall}, rewriting disabled`,
      };
      ctx.fragments.length = 0;
      return;
    }

    const rewritten = await rewriteInteraction(
      prompt,
      response,
      this.config.backend,
    );

    if (!rewritten) {
      // Rewriting failed or unsalvageable
      this.stats.llmFailures++;
      this.lastReport = {
        passed: false,
        stage: "rewriter",
        heuristicReport,
        judgment,
        rejectReason: "rewriting failed or unsalvageable",
      };
      ctx.fragments.length = 0;
      return;
    }

    // Replace fragments with rewritten content
    this.stats.rewritten++;
    const now = Date.now();
    const rewrittenFragments: MemoryFragment[] = fragments.map((f, i) => ({
      ...f,
      id: `${f.id}-curated`,
      content: JSON.stringify({
        instruction: rewritten.instruction,
        response: rewritten.response,
      }),
      metadata: {
        ...(f.metadata ?? {}),
        curated: true,
        originalPrompt: prompt.slice(0, 500),
        originalResponse: response.slice(0, 1000),
        judgeScore: judgment.overall,
        curatorVersion: "0.1.0",
      },
      timestamp: now,
    }));

    ctx.fragments.length = 0;
    ctx.fragments.push(...rewrittenFragments);

    this.lastReport = {
      passed: true,
      stage: "rewriter",
      heuristicReport,
      judgment,
      rewritten,
    };
  }

  reset(): void {
    this.stats = {
      totalInteractions: 0,
      rejectedByHeuristics: 0,
      rejectedByJudge: 0,
      passedClean: 0,
      rewritten: 0,
      llmFailures: 0,
    };
    this.lastReport = undefined;
  }
}

// ── Default Export ─────────────────────────────────────────────────────────

export default createDataCurator().definition;

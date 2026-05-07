/**
 * @the-brain/plugin-harvester-lm-eval
 *
 * Data harvester that polls a configurable directory for lm-evaluation-harness
 * JSON result files and feeds benchmark results into the the-brain pipeline.
 *
 * Each run becomes an Interaction where:
 *   - prompt = summary of the evaluation run (model + tasks)
 *   - response = detailed scores
 *   - metadata = structured scores, fingerprints, anomalies
 *
 * This enables the-brain to:
 *   1. Track per-model per-benchmark performance over time
 *   2. Detect anomalous regressions (SPM surprise filter)
 *   3. Build causal graphs of harness edits → score changes
 *   4. Serve as cognitive layer for meta-harnesses (AHE, Meta-Harness)
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type {
  Interaction,
  InteractionContext,
  PluginHooks,
} from "@the-brain/core";
import { HookEvent, MemoryLayer, definePlugin } from "@the-brain/core";
import {
  parseEvalResults,
  summarizeRun,
  type ParsedEvalRun,
} from "./parser";
import {
  loadFingerprints,
  saveFingerprints,
  updateFingerprints,
  scanForAnomalies,
  summarizeAnomalies,
  type BenchmarkFingerprint,
} from "./fingerprint";

// ── Types ────────────────────────────────────────────────────────

interface LmEvalState {
  lastPollTimestamp: number;
  /** Set of runHashes already processed */
  processedHashes: string[];
  /** Per-model per-benchmark fingerprints */
  fingerprints?: Record<string, BenchmarkFingerprint>;
}

const STATE_FILE = join(
  process.env.HOME || homedir(),
  ".the-brain",
  "lm-eval-harvester-state.json",
);

const DEFAULT_WATCH_DIR = join(
  process.env.HOME || homedir(),
  ".the-brain",
  "eval-results",
);

// ── State persistence ────────────────────────────────────────────

function loadState(): LmEvalState {
  try {
    if (existsSync(STATE_FILE)) {
      const raw = readFileSync(STATE_FILE, "utf-8");
      const state = JSON.parse(raw) as LmEvalState;
      // Ensure arrays
      if (!Array.isArray(state.processedHashes)) {
        state.processedHashes = [];
      }
      return state;
    }
  } catch {
    // Corrupted state — start fresh
  }
  return {
    lastPollTimestamp: 0,
    processedHashes: [],
    fingerprints: {},
  };
}

function saveState(state: LmEvalState): void {
  const dir = join(process.env.HOME || homedir(), ".the-brain");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ── File discovery ───────────────────────────────────────────────

function findNewResultFiles(
  watchDir: string,
  lastTimestamp: number,
): string[] {
  if (!existsSync(watchDir)) return [];

  const files: { path: string; mtime: number }[] = [];
  for (const entry of readdirSync(watchDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".json")) continue;
    // Skip harvester state file if it's in the same dir
    if (entry.name === "lm-eval-harvester-state.json") continue;

    const fullPath = join(watchDir, entry.name);
    try {
      const stat = readFileSync(fullPath, "utf-8");
      // Quick check: is this an lm-eval results file?
      if (!stat.includes('"results"')) continue;

      // Use file content hash as timestamp proxy (simpler than mtime)
      const hash = createHash("sha256").update(stat).digest("hex").slice(0, 16);
      files.push({ path: fullPath, mtime: parseInt(hash, 16) });
    } catch {
      continue;
    }
  }

  return files
    .filter((f) => f.mtime > lastTimestamp || lastTimestamp === 0)
    .sort((a, b) => a.mtime - b.mtime)
    .map((f) => f.path);
}

// ── Interaction building ─────────────────────────────────────────

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function buildInteraction(
  run: ParsedEvalRun,
  anomalySummary: string,
): Interaction {
  const summary = summarizeRun(run);
  const prompt = `Evaluation run: ${run.model} on ${run.tasks.map((t) => t.task).join(", ")}`;
  const response = `${summary}\n\n${anomalySummary}`;

  return {
    id: sha256(prompt + response),
    timestamp: run.parsedAt,
    prompt,
    response,
    source: "lm-eval",
    metadata: {
      model: run.model,
      tasks: run.tasks.map((t) => ({
        name: t.task,
        scores: t.scores.map((s) => ({
          metric: s.metric,
          value: s.value,
          stderr: s.stderr,
        })),
        taskHash: t.taskHash,
      })),
      totalTime: run.totalTime,
      numFewshot: run.numFewshot,
      batchSize: run.batchSize,
      runHash: run.runHash,
      sourceFile: basename(run.sourceFile),
    },
  };
}

// ── Plugin ───────────────────────────────────────────────────────

export default definePlugin({
  name: "@the-brain/plugin-harvester-lm-eval",
  version: "0.1.0",
  description:
    "Harvests lm-evaluation-harness benchmark results — feeds eval data into the-brain memory pipeline",
  async setup(hooks: PluginHooks) {
    const watchDir = process.env.LM_EVAL_WATCH_DIR || DEFAULT_WATCH_DIR;
    let state = loadState();

    // Ensure watch directory exists
    if (!existsSync(watchDir)) {
      mkdirSync(watchDir, { recursive: true });
    }

    hooks.hook(HookEvent.HARVESTER_POLL, async () => {
      state = loadState(); // Re-read state in case it was updated externally

      // Load fingerprints from state (or initialize empty)
      const fingerprints = loadFingerprints(
        state.fingerprints ? { fingerprints: state.fingerprints } : null,
      );

      // Find new result files
      const newFiles = findNewResultFiles(watchDir, state.lastPollTimestamp);
      if (newFiles.length === 0) return;

      for (const file of newFiles) {
        try {
          const raw = readFileSync(file, "utf-8");
          const run = parseEvalResults(raw, file);

          // Skip already processed runs
          if (state.processedHashes.includes(run.runHash)) continue;

          // Update fingerprints
          const updatedFingerprints = updateFingerprints(fingerprints, run);

          // Scan for anomalies
          const diagnoses = scanForAnomalies(updatedFingerprints, run);
          const anomalySummary = summarizeAnomalies(diagnoses);

          // Build interaction
          const interaction = buildInteraction(run, anomalySummary);

          // Emit to pipeline
          const ctx: InteractionContext = {
            interaction,
            fragments: diagnoses
              .filter((d) => d.isAnomalous)
              .map((d) => ({
                id: sha256(
                  `${run.runHash}-${d.fingerprint.benchmark}-${d.fingerprint.metric}`,
                ),
                layer: "instant" as MemoryLayer,
                content: `Anomaly: ${d.fingerprint.modelName}/${d.fingerprint.benchmark}/${d.fingerprint.metric} z=${d.zScore.toFixed(2)}`,
                timestamp: run.parsedAt,
                source: "lm-eval",
              })),
            promoteToDeep: () => {
              // Anomalous runs auto-promote to deep layer
            },
          };

          await hooks.callHook(HookEvent.HARVESTER_NEW_DATA, ctx);
          await hooks.callHook(HookEvent.ON_INTERACTION, ctx);

          // Update state
          state.processedHashes.push(run.runHash);
          // Keep only last 1000 hashes
          if (state.processedHashes.length > 1000) {
            state.processedHashes = state.processedHashes.slice(-1000);
          }
          state.fingerprints = saveFingerprints(updatedFingerprints);

          // Update last poll timestamp (use run hash as higher-is-newer proxy)
          const hashNum = parseInt(run.runHash.slice(0, 8), 16);
          if (hashNum > state.lastPollTimestamp) {
            state.lastPollTimestamp = hashNum;
          }
        } catch (err) {
          // Skip corrupted/unparseable files silently
          // The harvester will try again next poll cycle
        }
      }

      // Persist state
      saveState(state);
    });
  },
});

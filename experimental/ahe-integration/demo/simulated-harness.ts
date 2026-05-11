/**
 * Standalone Demo — the-brain as Cognitive Layer for Meta-Harnesses
 *
 * Simulates a 5-cycle AHE-like harness evolution loop with
 * the-brain providing predictive memory and anomaly detection.
 *
 * No external dependencies — uses HarnessFingerprintStore directly.
 *
 * Usage: bun run experimental/ahe-integration/demo/simulated-harness.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessFingerprintStore } from "../../../packages/plugin-identity-anchor/src/fingerprint-store";
import { parseEvalResults } from "../../../packages/plugin-harvester-lm-eval/src/parser";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");
const RESULTS_DIR = join(FIXTURES, "lm-eval-results");
const CYCLES_DIR = join(FIXTURES, "evolution-cycles");

// ── Colors ─────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

function header(text: string) {
  console.log(`\n${C.bold}${C.cyan}${text}${C.reset}`);
}

function success(text: string) {
  console.log(`  ${C.green}✅ ${text}${C.reset}`);
}

function warn(text: string) {
  console.log(`  ${C.yellow}⚠️  ${text}${C.reset}`);
}

function danger(text: string) {
  console.log(`  ${C.red}🚨 ${text}${C.reset}`);
}

function info(text: string) {
  console.log(`  ${C.dim}${text}${C.reset}`);
}

function separator() {
  console.log(`${C.dim}${"─".repeat(50)}${C.reset}`);
}

// ── Cycle data ─────────────────────────────────────────────────

interface CycleData {
  cycle: number;
  harness: string;
  description: string;
  edit_id: string | null;
  edit_component: string | null;
  prediction: string | null;
  result_file: string;
}

function loadCycle(cycleNum: number): CycleData {
  const raw = readFileSync(join(CYCLES_DIR, `cycle-0${cycleNum}.json`), "utf-8");
  return JSON.parse(raw);
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  console.log(`${C.bold}${C.magenta}
╔══════════════════════════════════════════════════════════╗
║  🧠 the-brain + Meta-Harness — Standalone Demo          ║
║  Cognitive Layer for Harness Evolution                   ║
╚══════════════════════════════════════════════════════════╝
${C.reset}`);

  console.log(`${C.dim}Simulating 5-cycle AHE harness evolution loop with the-brain as cognitive memory layer.${C.reset}\n`);

  // Use a temp store path so we don't pollute the real store
  const storePath = join(__dirname, ".demo-fingerprints.json");
  const store = new HarnessFingerprintStore(storePath);
  store.clear();

  const surprises: Array<{ cycle: number; edit: string; component: string; z: number }> = [];

  // ── Cycle 1: Cold Start ─────────────────────────────────────
  header("Cycle 1/5 — Cold Start (Seed Harness)");
  {
    const cycle = loadCycle(1);
    info(`Harness: ${cycle.harness} — ${cycle.description}`);
    info("No predictions — first run, building baselines.");

    const run = parseEvalResults(
      readFileSync(join(RESULTS_DIR, cycle.result_file), "utf-8"),
      cycle.result_file,
    );

    // Record scores
    for (const task of run.tasks) {
      for (const score of task.scores) {
        store.update(run.model, task.task, score.metric, score.value);
      }
    }

    info(`Recorded ${run.tasks.length} tasks — fingerprints created.`);
    for (const task of run.tasks) {
      for (const score of task.scores) {
        const fp = store.get(run.model, task.task, score.metric)!;
        info(`  ${task.task}/${score.metric}: μ=${fp.mean.toFixed(4)} n=${fp.n}`);
      }
    }
    info("⏳ Cold start — predictions will improve after cycle 3.");
  }

  // ── Cycle 2: Add Caching — Regression ───────────────────────
  header("Cycle 2/5 — Add Middleware Caching");
  {
    const cycle = loadCycle(2);
    info(`Harness: ${cycle.harness}`);
    info(`Edit: ${cycle.edit_id} (${cycle.edit_component})`);
    info(`Prediction: "${cycle.prediction}"`);

    // Predict before eval
    const predictions = store.predictAll("claude-sonnet-4", "mmlu");
    if (predictions.length > 0) {
      for (const p of predictions) {
        info(`  Predict ${p.metric}: ${p.predictedRange[0].toFixed(4)}–${p.predictedRange[1].toFixed(4)} (${(p.confidence * 100).toFixed(0)}% conf, COLD)`);
      }
    }

    const run = parseEvalResults(
      readFileSync(join(RESULTS_DIR, cycle.result_file), "utf-8"),
      cycle.result_file,
    );

    // Record + assess (assess BEFORE updating fingerprints)
    const accScore = run.tasks.find((t) => t.task === "mmlu")!.scores.find((s) => s.metric === "acc")!.value;
    const preAssessments = store.assessAll(run.model, "mmlu", { acc: accScore });

    for (const task of run.tasks) {
      for (const score of task.scores) {
        store.update(run.model, task.task, score.metric, score.value);
      }
    }

    for (const a of preAssessments) {
      if (a.isAnomalous) {
        warn(`${a.prediction.metric}: ${a.observed.toFixed(4)} vs ${a.prediction.predictedRange[0].toFixed(4)}–${a.prediction.predictedRange[1].toFixed(4)} (z=${a.zScore.toFixed(2)})`);
        surprises.push({ cycle: 2, edit: cycle.edit_id!, component: cycle.edit_component!, z: a.zScore });
      } else if (a.zScore > 1.5) {
        warn(`mmlu/acc: ${a.observed.toFixed(4)} vs ${a.prediction.predictedRange[0].toFixed(4)}–${a.prediction.predictedRange[1].toFixed(4)} (z=${a.zScore.toFixed(2)}, cold start — suppressed)`);
        surprises.push({ cycle: 2, edit: cycle.edit_id!, component: cycle.edit_component!, z: a.zScore });
      } else {
        success(`mmlu/acc: ${a.observed.toFixed(4)} — within range (z=${a.zScore.toFixed(2)}, cold start)`);
      }
    }
  }

  // ── Cycle 3: Fix Caching — Recovery ─────────────────────────
  header("Cycle 3/5 — Fix Cache Bug");
  {
    const cycle = loadCycle(3);
    info(`Harness: ${cycle.harness}`);
    info(`Edit: ${cycle.edit_id} (${cycle.edit_component})`);

    const predictions = store.predictAll("claude-sonnet-4", "mmlu");
    for (const p of predictions) {
      const status = p.isColdStart ? "WARMING" : "WARM";
      info(`  Predict ${p.metric}: ${p.predictedRange[0].toFixed(4)}–${p.predictedRange[1].toFixed(4)} (${(p.confidence * 100).toFixed(0)}% conf, ${status})`);
    }

    const run = parseEvalResults(
      readFileSync(join(RESULTS_DIR, cycle.result_file), "utf-8"),
      cycle.result_file,
    );

    const accScore = run.tasks.find((t) => t.task === "mmlu")!.scores.find((s) => s.metric === "acc")!.value;
    const preAssessments = store.assessAll(run.model, "mmlu", { acc: accScore });

    for (const task of run.tasks) {
      for (const score of task.scores) {
        store.update(run.model, task.task, score.metric, score.value);
      }
    }

    for (const a of preAssessments) {
      if (a.isAnomalous) {
        warn(`${a.prediction.metric}: anomalous`);
      } else {
        success(`mmlu/acc: ${a.observed.toFixed(4)} — recovered! (z=${a.zScore.toFixed(2)}, confidence: ${(a.prediction.confidence * 100).toFixed(0)}%)`);
      }
    }
  }

  // ── Cycle 4: Tool Registry — SURPRISE ───────────────────────
  header("Cycle 4/5 — Refactor Tool Registry");
  {
    const cycle = loadCycle(4);
    info(`Harness: ${cycle.harness}`);
    info(`Edit: ${cycle.edit_id} (${cycle.edit_component})`);
    info(`Prediction: "${cycle.prediction}"`);

    const predictions = store.predictAll("claude-sonnet-4", "mmlu");
    for (const p of predictions) {
      info(`  Predict ${p.metric}: ${p.predictedRange[0].toFixed(4)}–${p.predictedRange[1].toFixed(4)} (${(p.confidence * 100).toFixed(0)}% conf, WARM)`);
    }

    const run = parseEvalResults(
      readFileSync(join(RESULTS_DIR, cycle.result_file), "utf-8"),
      cycle.result_file,
    );

    const accScore = run.tasks.find((t) => t.task === "mmlu")!.scores.find((s) => s.metric === "acc")!.value;
    const preAssessments = store.assessAll(run.model, "mmlu", { acc: accScore });

    for (const task of run.tasks) {
      for (const score of task.scores) {
        store.update(run.model, task.task, score.metric, score.value);
      }
    }

    let hadAnomaly = false;
    for (const a of preAssessments) {
      if (a.isAnomalous) {
        danger(`SURPRISE! ${a.prediction.metric}: ${a.observed.toFixed(4)} vs ${a.prediction.predictedRange[0].toFixed(4)}–${a.prediction.predictedRange[1].toFixed(4)} (z=${a.zScore.toFixed(2)}, surprise=${a.surpriseScore.toFixed(2)})`);
        surprises.push({ cycle: 4, edit: cycle.edit_id!, component: cycle.edit_component!, z: a.zScore });
        hadAnomaly = true;
      }
    }
    if (!hadAnomaly) success("All metrics normal.");
  }

  // ── Cycle 5: Rollback — Recovery ────────────────────────────
  header("Cycle 5/5 — Rollback Tool Registry");
  {
    const cycle = loadCycle(5);
    info(`Harness: ${cycle.harness}`);
    info(`Edit: ${cycle.edit_id} (${cycle.edit_component})`);

    const predictions = store.predictAll("claude-sonnet-4", "mmlu");
    for (const p of predictions) {
      info(`  Predict ${p.metric}: ${p.predictedRange[0].toFixed(4)}–${p.predictedRange[1].toFixed(4)} (${(p.confidence * 100).toFixed(0)}% conf, WARM)`);
    }

    const run = parseEvalResults(
      readFileSync(join(RESULTS_DIR, cycle.result_file), "utf-8"),
      cycle.result_file,
    );

    const accScore = run.tasks.find((t) => t.task === "mmlu")!.scores.find((s) => s.metric === "acc")!.value;
    const preAssessments = store.assessAll(run.model, "mmlu", { acc: accScore });

    for (const task of run.tasks) {
      for (const score of task.scores) {
        store.update(run.model, task.task, score.metric, score.value);
      }
    }

    for (const a of preAssessments) {
      if (a.isAnomalous) {
        warn("Unexpected anomaly after rollback.");
      } else {
        success(`mmlu/acc: ${a.observed.toFixed(4)} — recovered! (z=${a.zScore.toFixed(2)})`);
      }
    }
  }

  // ── Load comparison model ───────────────────────────────────
  header("Loading Comparison Model");
  {
    const compRun = parseEvalResults(
      readFileSync(join(RESULTS_DIR, "comparison-opus-mmlu.json"), "utf-8"),
      "comparison-opus-mmlu.json",
    );
    for (const task of compRun.tasks) {
      for (const score of task.scores) {
        store.update(compRun.model, task.task, score.metric, score.value);
      }
    }
    info("claude-opus-4 baseline loaded.");
  }

  // ── Final Report ────────────────────────────────────────────
  header("═ Final Report ═");
  separator();

  // Fingerprint summary
  const fps = store.getAll();
  const claudeFps = fps.filter((f) => f.modelName === "claude-sonnet-4");
  const opusFps = fps.filter((f) => f.modelName === "claude-opus-4");

  console.log(`\n${C.bold}Fingerprint Stability:${C.reset}`);
  for (const fp of claudeFps.filter((f) => f.benchmark === "mmlu")) {
    const stable = fp.n >= 3 ? "✅ STABLE" : "⏳ WARMING";
    console.log(`  ${fp.benchmark}/${fp.metric}: μ=${fp.mean.toFixed(4)} σ=${fp.std.toFixed(4)} n=${fp.n} ${stable}`);
  }

  console.log(`\n${C.bold}Surprises Detected:${C.reset} ${surprises.length}`);
  for (const s of surprises) {
    const cycleTag = s.cycle === 2 ? `${C.yellow}WARN${C.reset}` : `${C.red}CRITICAL${C.reset}`;
    console.log(`  Cycle ${s.cycle} [${cycleTag}] ${s.edit} (${s.component}): z=${s.z.toFixed(2)}`);
  }

  console.log(`\n${C.bold}Regression Graph:${C.reset}`);
  if (surprises.length >= 2) {
    const bothInfra = surprises.every((s) => s.component === "middleware" || s.component === "tools");
    const msg = bothInfra
      ? "both touched infrastructure (middleware + tools)"
      : `edits across ${[...new Set(surprises.map((s) => s.component))].join(", ")}`;
    console.log(`  ${C.yellow}Pattern detected:${C.reset} ${surprises.length} edits ${msg}`);
    console.log(`  → Tool↔cache interaction path may be causing regressions.`);
    console.log(`  → Investigate: does middleware caching break tool resolution?`);
  } else if (surprises.length === 1) {
    console.log(`  ${C.dim}1 surprise detected — need more cycles for pattern analysis.${C.reset}`);
  } else {
    console.log(`  ${C.dim}No regression patterns yet.${C.reset}`);
  }

  console.log(`\n${C.bold}Model Comparison (mmlu/acc):${C.reset}`);
  const claudeAcc = claudeFps.find((f) => f.benchmark === "mmlu" && f.metric === "acc");
  const opusAcc = opusFps.find((f) => f.benchmark === "mmlu" && f.metric === "acc");
  if (claudeAcc && opusAcc) {
    const better = claudeAcc.mean > opusAcc.mean ? "claude-sonnet-4" : "claude-opus-4";
    const delta = Math.abs(claudeAcc.mean - opusAcc.mean);
    console.log(`  claude-sonnet-4: μ=${claudeAcc.mean.toFixed(4)}±${claudeAcc.std.toFixed(4)} n=${claudeAcc.n} ${better === "claude-sonnet-4" ? "🥇" : ""}`);
    console.log(`  claude-opus-4:   μ=${opusAcc.mean.toFixed(4)}±${opusAcc.std.toFixed(4)} n=${opusAcc.n} ${better === "claude-opus-4" ? "🥇" : ""}`);
    console.log(`  Delta: ${delta.toFixed(4)}`);
  }

  // Drift check
  console.log(`\n${C.bold}Drift Detection:${C.reset}`);
  const drift = store.detectDrift("claude-sonnet-4", "mmlu", 3);
  if (drift.drifting) {
    warn(`Model may be drifting — avg z-score: ${drift.avgZScore.toFixed(2)} on metrics: ${drift.metrics.join(", ")}`);
  } else {
    success(`No systematic drift detected (avg z: ${drift.avgZScore.toFixed(2)})`);
  }

  separator();
  console.log(`\n${C.green}Demo complete.${C.reset}`);
  console.log(`${C.dim}Fingerprint store saved to: ${storePath}${C.reset}\n`);

  // Clean up demo store
  store.save();
}

main().catch(console.error);

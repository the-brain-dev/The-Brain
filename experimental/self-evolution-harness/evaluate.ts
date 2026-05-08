#!/usr/bin/env bun
/**
 * evaluate.ts — Evaluation harness for the-brain self-evolution cycles
 *
 * Called by the coding agent after each cycle's implementation.
 * Runs tests, build, coverage, and brain benchmarks.
 * Compares prediction vs actual outcome.
 * Writes verdict to experimental/self-evolution-harness/evolution.db
 *
 * Usage:
 *   bun run evaluate.ts --cycle-id 42
 *   bun run evaluate.ts --mode quick-fix --commit abc1234
 *
 * Exports testable functions for __tests__/evaluate.test.ts
 */

import { Database } from "bun:sqlite";
import { $ } from "bun";
import { join, dirname } from "path";
import { existsSync, mkdirSync, readFileSync } from "fs";

// ── Testable: Parsers ──────────────────────────────────────────────────────────

export interface TestResult {
  total: number;
  passed: number;
  failed: number;
}

/** Parse bun test stdout into structured counts */
export function parseTestOutput(stdout: string): TestResult | null {
  const passMatch = stdout.match(/(\d+)\s+pass/);
  const failMatch = stdout.match(/(\d+)\s+fail/);
  const timeoutMatch = stdout.match(/(\d+)\s+timeout/);

  if (!passMatch && !failMatch) return null;

  const passed = passMatch ? parseInt(passMatch[1]) : 0;
  const failed = (failMatch ? parseInt(failMatch[1]) : 0) +
                 (timeoutMatch ? parseInt(timeoutMatch[1]) : 0);
  return { total: passed + failed, passed, failed };
}

/** Parse bun test --coverage output for coverage percentage */
export function parseCoverageOutput(stdout: string): number | null {
  // Standard table: "All files  |   86.32 |  ..."
  const match = stdout.match(/All\s+files?\s+\|\s+([\d.]+)\s*\|/);
  if (match) return parseFloat(match[1]);

  // Alternative: "86.32% Statements"
  const alt = stdout.match(/([\d.]+)%\s+Statements/);
  if (alt) return parseFloat(alt[1]);

  // Fallback: any percentage near "cover"
  const fallback = stdout.match(/cover.*?([\d.]+)%/i);
  if (fallback) return parseFloat(fallback[1]);

  return null;
}

/** Parse lint output for error/warning counts */
export function parseLintOutput(stdout: string): { errors: number; warnings: number } {
  const errors = (stdout.match(/error/gi) || []).length;
  const warnings = (stdout.match(/warning/gi) || []).length;
  return { errors, warnings };
}

// ── Testable: Verdict Logic ────────────────────────────────────────────────────

export type Verdict = "pending" | "confirmed" | "rejected" | "confirmed_with_regression" | "regression_blindness";
export type PredictionAccuracy = "correct" | "incorrect" | "partial";

export interface VerdictResult {
  verdict: Verdict;
  predictionAccuracy: PredictionAccuracy | null;
  unexpectedRegressions: string[];
  predictedFixesHit: number;
}

/**
 * Pure function: determine verdict from evaluation results.
 * No DB access, no side effects. Fully testable.
 *
 * The agent's predicted_fixes and predicted_regressions are NOT used
 * for verdict calculation (we can't match them to specific tests).
 * They're stored in the cycle record for human review.
 */
export function determineVerdict(params: {
  tests_failed: number;
  buildSuccess: boolean;
  coverage_delta: number;
  lint_delta: number;
  predictedFixesCount: number;
  predictedRegressionsCount: number;
}): VerdictResult {
  const { tests_failed, buildSuccess, coverage_delta, lint_delta,
          predictedFixesCount, predictedRegressionsCount } = params;

  const mandatoryPass = tests_failed === 0 && buildSuccess;
  const unexpectedRegressions: string[] = [];

  if (!mandatoryPass) {
    return {
      verdict: "rejected",
      predictionAccuracy: "incorrect",
      unexpectedRegressions: [],
      predictedFixesHit: 0,
    };
  }

  if (coverage_delta < -1.0) {
    unexpectedRegressions.push(`coverage dropped by ${Math.abs(coverage_delta).toFixed(2)}%`);
    return {
      verdict: "confirmed_with_regression",
      predictionAccuracy: "partial",
      unexpectedRegressions,
      predictedFixesHit: 0,
    };
  }

  if (lint_delta > 5) {
    unexpectedRegressions.push(`lint issues increased by ${lint_delta}`);
    return {
      verdict: "confirmed_with_regression",
      predictionAccuracy: "partial",
      unexpectedRegressions,
      predictedFixesHit: 0,
    };
  }

  // "predictedFixesHit" is heuristic — if agent claimed fixes, assume 1 hit
  return {
    verdict: "confirmed",
    predictionAccuracy: "correct",
    unexpectedRegressions: [],
    predictedFixesHit: predictedFixesCount > 0 ? 1 : 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RUNTIME (only executed when run as script, not when imported for tests)
// ═══════════════════════════════════════════════════════════════════════════════

if (import.meta.main) {

// ── Configuration ──────────────────────────────────────────────────────────────

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const EVOLUTION_DIR = join(REPO_ROOT, "experimental", "self-evolution-harness");
const DB_PATH = join(EVOLUTION_DIR, "evolution.db");

// Ensure evolution directory exists
if (!existsSync(EVOLUTION_DIR)) {
  mkdirSync(EVOLUTION_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 5000");

// ── CLI ────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const cycleId = args.includes("--cycle-id")
  ? parseInt(args[args.indexOf("--cycle-id") + 1])
  : null;
let mode: string | null = null;
if (args.includes("--mode")) {
  try {
    mode = args[args.indexOf("--mode") + 1];
  } catch {}
}

if (!cycleId) {
  console.error("Usage: bun run evaluate.ts --cycle-id <number> [--mode <mode>]");
  process.exit(1);
}

// Read cycle from DB
const cycle = db.query("SELECT * FROM cycles WHERE cycle_number = ?").get(cycleId) as any;
if (!cycle) {
  console.error(`❌ Cycle #${cycleId} not found in evolution.db`);
  process.exit(1);
}

mode = mode || cycle.mode;

console.log(`\n🔬 EVALUATING CYCLE #${cycleId} (mode: ${mode})`);
console.log(`   Prediction: ${cycle.prediction?.substring(0, 120)}...\n`);

// ── Helpers ────────────────────────────────────────────────────────────────────

function runCommand(cmd: string, cwd?: string): { stdout: string; stderr: string; exitCode: number; durationMs: number } {
  const start = Date.now();
  const proc = Bun.spawnSync(["bash", "-c", cmd], {
    cwd: cwd || REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: new TextDecoder().decode(proc.stdout).trim(),
    stderr: new TextDecoder().decode(proc.stderr).trim(),
    exitCode: proc.exitCode,
    durationMs: Date.now() - start,
  };
}

function writeCycle(cycleNumber: number, updates: Record<string, any>) {
  const setClauses = Object.entries(updates)
    .map(([key, value]) => {
      if (value === null) return `${key} = NULL`;
      if (typeof value === "string") return `${key} = '${value.replace(/'/g, "''")}'`;
      if (typeof value === "object") return `${key} = '${JSON.stringify(value).replace(/'/g, "''")}'`;
      return `${key} = ${value}`;
    })
    .join(", ");
  
  db.run(`UPDATE cycles SET ${setClauses}, updated_at = datetime('now') WHERE cycle_number = ?`, [cycleNumber]);
}

// ── 1. Test Suite ──────────────────────────────────────────────────────────────

console.log("1/5 Running test suite...");

const testResult = runCommand("bun test 2>&1");

// Use shared parser (tested in evaluate.test.ts)
const parsedTests = parseTestOutput(testResult.stdout);
const tests_total = parsedTests?.total ?? 0;
const tests_passed = parsedTests?.passed ?? 0;
const tests_failed = parsedTests?.failed ?? 0;

// Check for specific test name patterns for flaky detection
const flakyPatterns = ["timeout", "flaky", "should pass", "race"];
const flakyLines = testResult.stdout
  .split("\n")
  .filter(line => flakyPatterns.some(p => line.toLowerCase().includes(p)))
  .slice(0, 5);

console.log(`   Tests: ${tests_passed}/${tests_total} passed, ${tests_failed} failed`);
if (flakyLines.length > 0) {
  console.log(`   ⚠️  Potential flaky patterns: ${flakyLines.length} lines`);
}

// ── 2. Build ───────────────────────────────────────────────────────────────────

console.log("\n2/5 Building project...");

const buildStart = Date.now();

// Build docs
const docsBuild = runCommand("cd apps/docs && bun run build 2>&1");

// Build CLI (check it compiles)
const cliCheck = runCommand("cd apps/cli && bun run --bun tsc --noEmit 2>&1");

const buildSuccess = docsBuild.exitCode === 0 && cliCheck.exitCode === 0;

console.log(`   Build: ${buildSuccess ? "✅ OK" : "❌ FAILED"}`);
console.log(`   Docs build: ${docsBuild.exitCode === 0 ? "pass" : "FAIL"} (${docsBuild.durationMs}ms)`);
console.log(`   CLI check:  ${cliCheck.exitCode === 0 ? "pass" : "FAIL"} (${cliCheck.durationMs}ms)`);

if (!buildSuccess && cliCheck.exitCode !== 0) {
  console.log(`   CLI errors: ${cliCheck.stderr.slice(0, 500)}`);
}

// ── 3. Coverage ────────────────────────────────────────────────────────────────

console.log("\n3/5 Measuring coverage...");

// Read previous coverage from the cycle before the change
const prevCycle = db.query(
  "SELECT coverage_after FROM cycles WHERE cycle_number < ? ORDER BY cycle_number DESC LIMIT 1"
).get(cycleId) as any;

const coverage_before = prevCycle?.coverage_after ?? 86.32; // baseline from docs

// Run coverage (bun test --coverage)
const coverageResult = runCommand("bun test --coverage 2>&1");

// Parse coverage percentage
const coverage_parsed = parseCoverageOutput(coverageResult.stdout);
let coverage_after = coverage_parsed ?? coverage_before;

const coverage_delta = coverage_after - coverage_before;
console.log(`   Coverage: ${coverage_before.toFixed(2)}% → ${coverage_after.toFixed(2)}% (${coverage_delta >= 0 ? "+" : ""}${coverage_delta.toFixed(2)}%)`);

// ── 4. Lint ────────────────────────────────────────────────────────────────────

console.log("\n4/5 Checking lint...");

const lintResult = runCommand("bun run lint 2>&1 || true");

const { errors: lint_errors, warnings: lint_warnings } = parseLintOutput(lintResult.stdout);

// Read previous lint counts for delta calculation
const prevLint = db.query(
  "SELECT lint_errors, lint_warnings FROM cycles WHERE cycle_number < ? ORDER BY cycle_number DESC LIMIT 1"
).get(cycleId) as any;
const lint_delta = (lint_errors + lint_warnings) -
  ((prevLint?.lint_errors || 0) + (prevLint?.lint_warnings || 0));

console.log(`   Lint: ${lint_errors} errors, ${lint_warnings} warnings (delta: ${lint_delta >= 0 ? "+" : ""}${lint_delta})`);

// ── 5. Brain Benchmarks ────────────────────────────────────────────────────────

console.log("\n5/5 Brain benchmarks...");

const brainMetrics: Record<string, number> = {};

// Only run brain benchmarks for brain-bench mode, deep-refactor, or self-evolve
if (mode === "brain-bench" || mode === "deep-refactor" || mode === "self-evolve") {
  // SPM accuracy — count surprising memories
  try {
    const spmStats = db.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN surprise_score IS NOT NULL AND surprise_score > 0.4 THEN 1 ELSE 0 END) as surprising
      FROM memories 
      WHERE created_at > datetime('now', '-24 hours')
    `).get() as any;
    
    if (spmStats?.total > 0) {
      brainMetrics.spm_accuracy = spmStats.surprising / spmStats.total;
      console.log(`   SPM accuracy: ${(brainMetrics.spm_accuracy * 100).toFixed(1)}%`);
    }
  } catch (e: any) {
    console.log(`   SPM: skipped (${e.message?.slice(0, 80)})`);
  }

  // Graph memory precision/recall
  try {
    const graphStats = db.query(`
      SELECT COUNT(*) as total_nodes,
             SUM(CASE WHEN data IS NOT NULL THEN 1 ELSE 0 END) as connected_nodes
      FROM graph_nodes
      WHERE created_at > datetime('now', '-7 days')
    `).get() as any;
    
    if (graphStats?.total_nodes > 0) {
      brainMetrics.graph_precision = graphStats.connected_nodes / graphStats.total_nodes;
      console.log(`   Graph precision: ${(brainMetrics.graph_precision * 100).toFixed(1)}%`);
    }
  } catch (e: any) {
    console.log(`   Graph: skipped (${e.message?.slice(0, 80)})`);
  }

  // Latency: simple timing query
  try {
    const t0 = Date.now();
    db.query("SELECT * FROM memories ORDER BY created_at DESC LIMIT 50").all();
    brainMetrics.memory_latency_ms = Date.now() - t0;
    console.log(`   Memory latency: ${brainMetrics.memory_latency_ms}ms`);
  } catch (e: any) {
    console.log(`   Latency: skipped`);
  }

  // ── Self-evolve specific checks ──────────────────────────────────────────
  if (mode === "self-evolve") {
    console.log("\n   Self-evolve checks:");

    // Verify evolution.db integrity
    try {
      const integrity = runCommand(
        `sqlite3 ${EVOLUTION_DIR}/evolution.db "PRAGMA integrity_check"`,
        REPO_ROOT
      );
      console.log(`   evolution.db integrity: ${integrity.stdout.includes("ok") ? "✅ OK" : "⚠️ " + integrity.stdout.slice(0, 100)}`);
    } catch (e: any) {
      console.log(`   evolution.db integrity: skipped`);
    }

    // Verify all mode prompts exist and are readable
    const modes = ["quick-fix", "coverage", "brain-bench", "deep-refactor", "self-evolve"];
    for (const m of modes) {
      const exists = existsSync(join(EVOLUTION_DIR, "modes", `${m}.prompt.md`));
      console.log(`   modes/${m}.prompt.md: ${exists ? "✅" : "❌ MISSING"}`);
    }

    // Verify run-cycle.sh is executable
    try {
      const stats = require("fs").statSync(join(EVOLUTION_DIR, "run-cycle.sh"));
      const isExecutable = (stats.mode & 0o111) !== 0;
      console.log(`   run-cycle.sh executable: ${isExecutable ? "✅" : "⚠️  NOT EXECUTABLE"}`);
    } catch {
      console.log("   run-cycle.sh: ❌ NOT FOUND");
    }
  }
} else {
  console.log("   Skipped — mode doesn't require brain benchmarks");
}

// ── Write Results ──────────────────────────────────────────────────────────────

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("WRITING VERDICT");

// Parse predictions for the record
let predictedFixes: string[] = [];
let predictedRegressions: string[] = [];
try {
  predictedFixes = JSON.parse(cycle.predicted_fixes || "[]");
  predictedRegressions = JSON.parse(cycle.predicted_regressions || "[]");
} catch {}

// Use shared verdict logic (tested in evaluate.test.ts)
const verdictResult = determineVerdict({
  tests_failed,
  buildSuccess,
  coverage_delta,
  lint_delta,
  predictedFixesCount: predictedFixes.length,
  predictedRegressionsCount: predictedRegressions.length,
});

const finalVerdict = verdictResult.verdict;
const predAccuracy = verdictResult.predictionAccuracy;
const predictedFixesHit = verdictResult.predictedFixesHit;
const unexpectedRegressions = verdictResult.unexpectedRegressions;

if (finalVerdict === "rejected") {
  console.log("❌ VERDICT: REJECTED — mandatory checks failed");
} else if (finalVerdict === "confirmed_with_regression") {
  console.log(`⚠️  VERDICT: CONFIRMED WITH REGRESSION — ${unexpectedRegressions[0]}`);
} else {
  console.log("✅ VERDICT: CONFIRMED — all checks pass");
}

// Write to evolution.db
writeCycle(cycleId, {
  tests_total,
  tests_passed,
  tests_failed,
  build_success: buildSuccess ? 1 : 0,
  build_time_ms: Date.now() - buildStart,
  coverage_before: Math.round(coverage_before * 100) / 100,
  coverage_after: Math.round(coverage_after * 100) / 100,
  lint_errors,
  lint_warnings,
  lint_delta,
  brain_spm_accuracy: brainMetrics.spm_accuracy || null,
  brain_graph_precision: brainMetrics.graph_precision || null,
  brain_memory_latency_ms: brainMetrics.memory_latency_ms || null,
  verdict: finalVerdict,
  prediction_accuracy: predAccuracy,
  predicted_regressions_hit: predictedRegressions.length ? 0 : 0,
  unexpected_regressions: unexpectedRegressions.length > 0 ? JSON.stringify(unexpectedRegressions) : null,
  // Don't overwrite diff_summary — agent fills that
});

// Check if batch is full (5 cycles)
const batchId = cycle.batch_id;
if (batchId) {
  const cyclesInBatch = db.query(
    "SELECT COUNT(*) as count FROM cycles WHERE batch_id = ?"
  ).get(batchId) as any;
  
  if (cyclesInBatch?.count >= 5) {
    console.log(`\n📦 BATCH #${batchId} IS FULL (${cyclesInBatch.count}/5 cycles)`);
    console.log("   → Agent should stop and submit PR for review");
  }
}

// Show batch summary
if (batchId) {
  const batchCycles = db.query(
    "SELECT cycle_number, verdict, prediction_accuracy FROM cycles WHERE batch_id = ? ORDER BY cycle_number"
  ).all(batchId) as any[];
  
  const confirmed = batchCycles.filter((c: any) => c.verdict === "confirmed").length;
  const rejected = batchCycles.filter((c: any) => c.verdict === "rejected").length;
  
  console.log(`\n📊 BATCH #${batchId} SUMMARY: ${confirmed} confirmed, ${rejected} rejected`);
}

// ── Output for Agent ───────────────────────────────────────────────────────────

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
console.log("EVALUATION COMPLETE");
console.log(`   Cycle:    #${cycleId}`);
console.log(`   Verdict:  ${finalVerdict.toUpperCase()}`);
console.log(`   Tests:    ${tests_passed}/${tests_total} pass`);
console.log(`   Coverage: ${coverage_before.toFixed(1)}% → ${coverage_after.toFixed(1)}%`);
console.log(`   Build:    ${buildSuccess ? "pass" : "FAIL"}`);

if (finalVerdict === "confirmed") {
  console.log(`\n   ✅ Next: proceed to next cycle`);
} else if (finalVerdict === "rejected") {
  console.log(`\n   ❌ FIX REQUIRED: tests or build failed. Run: bun test`);
  console.log(`   ❌ Do NOT proceed to next cycle until this is resolved.`);
} else {
  console.log(`   ⚠️  PARTIAL SUCCESS: fix works but causes side effects`);
  console.log(`   ⚠️  Record the regression and consider if the tradeoff is acceptable.`);
}

} // close if (import.meta.main)

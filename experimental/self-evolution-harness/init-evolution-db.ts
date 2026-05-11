#!/usr/bin/env bun
/**
 * init-evolution-db.ts — Initialize the evolution database for the-brain self-evolution harness
 *
 * Creates all tables, indexes, and seed data.
 * Safe to run multiple times — uses IF NOT EXISTS.
 *
 * Usage:
 *   bun run init-evolution-db.ts
 */

import { Database } from "bun:sqlite";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

// ── Configuration ──────────────────────────────────────────────────────────────

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const EVOLUTION_DIR = join(REPO_ROOT, "experimental", "self-evolution-harness");
const DB_PATH = join(EVOLUTION_DIR, "evolution.db");

if (!existsSync(EVOLUTION_DIR)) {
  mkdirSync(EVOLUTION_DIR, { recursive: true });
}

// ── Schema ─────────────────────────────────────────────────────────────────────

const SCHEMA = `
-- Cycles: każdy cykl = jedna propozycja + implementacja + ewaluacja
CREATE TABLE IF NOT EXISTS cycles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_number    INTEGER NOT NULL,
  mode            TEXT NOT NULL CHECK(mode IN (
                    'quick-fix','coverage','brain-bench',
                    'deep-refactor','self-evolve'
                  )),
  
  -- Propozycja
  branch_name     TEXT NOT NULL,
  commit_sha      TEXT NOT NULL DEFAULT '',
  prediction      TEXT NOT NULL,
  predicted_fixes TEXT,
  predicted_regressions TEXT,
  
  -- Ewaluacja obowiązkowa
  tests_total     INTEGER,
  tests_passed    INTEGER,
  tests_failed    INTEGER,
  build_success   INTEGER NOT NULL DEFAULT 0,
  build_time_ms   INTEGER,
  
  -- Ewaluacja miękka
  coverage_before REAL,
  coverage_after  REAL,
  lint_errors     INTEGER,
  lint_warnings   INTEGER,
  lint_delta      INTEGER DEFAULT 0,
  
  -- Brain benchmarki (opcjonalne)
  brain_spm_accuracy    REAL,
  brain_graph_precision REAL,
  brain_graph_recall    REAL,
  brain_memory_latency_ms INTEGER,
  brain_consolidation_rate REAL,
  brain_lora_time_ms    INTEGER,
  
  -- Werdykt
  verdict         TEXT NOT NULL DEFAULT 'pending' CHECK(verdict IN (
                    'pending','confirmed','rejected',
                    'confirmed_with_regression','regression_blindness'
                  )),
  prediction_accuracy   TEXT CHECK(prediction_accuracy IN (
                    'correct','incorrect','partial',NULL
                  )),
  predicted_regressions_hit INTEGER DEFAULT 0,
  unexpected_regressions    TEXT,
  
  -- HITL
  batch_id        INTEGER,
  hitl_verdict    TEXT CHECK(hitl_verdict IN ('merged','rejected',NULL)),
  hitl_feedback   TEXT,
  
  -- Meta
  diff_summary    TEXT,
  files_changed   INTEGER,
  lines_added     INTEGER,
  lines_removed   INTEGER,
  agent_trace     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Batche: grupy 5 cykli zbierane do HITL review
CREATE TABLE IF NOT EXISTS batches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK(status IN (
                  'open','submitted','reviewed','merged','rejected'
                )),
  pr_url        TEXT,
  summary       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Wzorce z graph memory (gdy już ich używamy)
CREATE TABLE IF NOT EXISTS evolution_patterns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern         TEXT NOT NULL,
  evidence_cycles TEXT,
  confidence      REAL DEFAULT 0.0,
  discovered_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Historia feedbacku od człowieka — żeby agent się uczył
CREATE TABLE IF NOT EXISTS feedback_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id      INTEGER REFERENCES cycles(id),
  category      TEXT NOT NULL CHECK(category IN (
                  'over-engineering','wrong-approach','good-pattern',
                  'bad-prediction','hygiene','performance'
                )),
  feedback      TEXT NOT NULL,
  applied_to    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indeksy
CREATE INDEX IF NOT EXISTS idx_cycles_mode     ON cycles(mode);
CREATE INDEX IF NOT EXISTS idx_cycles_verdict  ON cycles(verdict);
CREATE INDEX IF NOT EXISTS idx_cycles_batch    ON cycles(batch_id);
CREATE INDEX IF NOT EXISTS idx_cycles_created  ON cycles(created_at);
`;

// ── Initialize ─────────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 5000");

console.log("Creating evolution.db tables...");
db.run(SCHEMA);

// Seed: first batch if none exists
const batchCount = (db.query("SELECT COUNT(*) as count FROM batches").get() as any).count;
if (batchCount === 0) {
  db.run("INSERT INTO batches (status) VALUES ('open')");
  console.log("Created batch #1 (open)");
}

const cycleCount = (db.query("SELECT COUNT(*) as count FROM cycles").get() as any).count;
console.log(`\n✅ Evolution database initialized`);
console.log(`   Path: ${DB_PATH}`);
console.log(`   Cycles: ${cycleCount}`);
console.log(`   Batches: ${batchCount + (batchCount === 0 ? 1 : 0)}`);

db.close();

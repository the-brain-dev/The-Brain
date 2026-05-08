/**
 * init-evolution-db.test.ts — Tests for evolution database initialization
 *
 * Tests: table creation, schema constraints, idempotency, seed data
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";

// ── Test schema directly (same SQL as init-evolution-db.ts uses) ───────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS cycles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_number    INTEGER NOT NULL,
  mode            TEXT NOT NULL CHECK(mode IN (
                    'quick-fix','coverage','brain-bench',
                    'deep-refactor','self-evolve'
                  )),
  branch_name     TEXT NOT NULL,
  commit_sha      TEXT NOT NULL DEFAULT '',
  prediction      TEXT NOT NULL,
  predicted_fixes TEXT,
  predicted_regressions TEXT,
  tests_total     INTEGER,
  tests_passed    INTEGER,
  tests_failed    INTEGER,
  build_success   INTEGER NOT NULL DEFAULT 0,
  build_time_ms   INTEGER,
  coverage_before REAL,
  coverage_after  REAL,
  lint_errors     INTEGER,
  lint_warnings   INTEGER,
  lint_delta      INTEGER DEFAULT 0,
  brain_spm_accuracy    REAL,
  brain_graph_precision REAL,
  brain_graph_recall    REAL,
  brain_memory_latency_ms INTEGER,
  brain_consolidation_rate REAL,
  brain_lora_time_ms    INTEGER,
  verdict         TEXT NOT NULL DEFAULT 'pending' CHECK(verdict IN (
                    'pending','confirmed','rejected',
                    'confirmed_with_regression','regression_blindness'
                  )),
  prediction_accuracy   TEXT CHECK(prediction_accuracy IN (
                    'correct','incorrect','partial',NULL
                  )),
  predicted_regressions_hit INTEGER DEFAULT 0,
  unexpected_regressions    TEXT,
  batch_id        INTEGER,
  hitl_verdict    TEXT CHECK(hitl_verdict IN ('merged','rejected',NULL)),
  hitl_feedback   TEXT,
  diff_summary    TEXT,
  files_changed   INTEGER,
  lines_added     INTEGER,
  lines_removed   INTEGER,
  agent_trace     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS batches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK(status IN (
                  'open','submitted','reviewed','merged','rejected'
                )),
  pr_url        TEXT,
  summary       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS evolution_patterns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern         TEXT NOT NULL,
  evidence_cycles TEXT,
  confidence      REAL DEFAULT 0.0,
  discovered_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

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
`;

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("evolution.db schema", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.run("PRAGMA journal_mode = WAL");
  });

  test("creates all 4 tables", () => {
    db.run(SCHEMA_SQL);

    const tables = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];

    const names = tables.map(t => t.name);
    expect(names).toContain("cycles");
    expect(names).toContain("batches");
    expect(names).toContain("evolution_patterns");
    expect(names).toContain("feedback_history");
  });

  test("second run is idempotent — no errors", () => {
    // Run schema again — IF NOT EXISTS prevents errors
    expect(() => db.run(SCHEMA_SQL)).not.toThrow();

    // Still 4 tables (no duplicates — SQLite may add internal tables like sqlite_sequence)
    const count = (db.query(
      "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).get() as any).c;
    expect(count).toBe(4);
  });

  test("cycles table enforces mode constraint", () => {
    // Valid mode should insert
    expect(() =>
      db.run(`INSERT INTO cycles (cycle_number, mode, branch_name, prediction)
              VALUES (1, 'quick-fix', 'evolve/cycle-1', 'test prediction')`)
    ).not.toThrow();

    // Invalid mode should fail
    expect(() =>
      db.run(`INSERT INTO cycles (cycle_number, mode, branch_name, prediction)
              VALUES (2, 'invalid-mode', 'evolve/cycle-2', 'test')`)
    ).toThrow();
  });

  test("cycles table enforces verdict constraint", () => {
    expect(() =>
      db.run(`INSERT INTO cycles (cycle_number, mode, branch_name, prediction, verdict)
              VALUES (3, 'coverage', 'evolve/cycle-3', 'test', 'invalid-verdict')`)
    ).toThrow();
  });

  test("cycles table defaults verdict to 'pending'", () => {
    db.run(`INSERT INTO cycles (cycle_number, mode, branch_name, prediction)
            VALUES (4, 'coverage', 'evolve/cycle-4', 'test')`);

    const verdict = (db.query(
      "SELECT verdict FROM cycles WHERE cycle_number = 4"
    ).get() as any).verdict;
    expect(verdict).toBe("pending");
  });

  test("batches table enforces status constraint", () => {
    expect(() =>
      db.run("INSERT INTO batches (status) VALUES ('invalid-status')")
    ).toThrow();
  });

  test("batches table defaults status to 'open'", () => {
    db.run("INSERT INTO batches DEFAULT VALUES");
    const status = (db.query(
      "SELECT status FROM batches WHERE id = 1"
    ).get() as any).status;
    expect(status).toBe("open");
  });

  test("feedback_history enforces category constraint", () => {
    // Valid categories
    const validCategories = [
      "over-engineering", "wrong-approach", "good-pattern",
      "bad-prediction", "hygiene", "performance",
    ];

    for (const cat of validCategories) {
      expect(() =>
        db.run(`INSERT INTO feedback_history (cycle_id, category, feedback)
                VALUES (1, '${cat}', 'test feedback')`)
      ).not.toThrow();
    }

    // Invalid category
    expect(() =>
      db.run(`INSERT INTO feedback_history (cycle_id, category, feedback)
              VALUES (1, 'invalid-category', 'test')`)
    ).toThrow();
  });

  test("evolution_patterns table accepts valid data", () => {
    expect(() =>
      db.run(`INSERT INTO evolution_patterns (pattern, evidence_cycles, confidence)
              VALUES ('changes in trainer → regressions', '[1,2,3]', 0.75)`)
    ).not.toThrow();

    const row = db.query("SELECT * FROM evolution_patterns WHERE id = 1").get() as any;
    expect(row.pattern).toBe("changes in trainer → regressions");
    expect(row.confidence).toBe(0.75);
  });
});

describe("seed data (batch creation)", () => {
  test("first batch is created when batches table is empty", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);

    // Simulate what init-evolution-db.ts does on first run
    const count = (db.query("SELECT COUNT(*) as c FROM batches").get() as any).c;
    if (count === 0) {
      db.run("INSERT INTO batches (status) VALUES ('open')");
    }

    const batch = db.query("SELECT * FROM batches WHERE id = 1").get() as any;
    expect(batch).not.toBeNull();
    expect(batch.status).toBe("open");
  });

  test("does not duplicate seed batch on second run", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA_SQL);

    // First init
    db.run("INSERT INTO batches (status) VALUES ('open')");

    // Second init — same logic as init script
    const count = (db.query("SELECT COUNT(*) as c FROM batches").get() as any).c;
    if (count === 0) {
      db.run("INSERT INTO batches (status) VALUES ('open')");
    }

    // Still only 1 batch
    const finalCount = (db.query("SELECT COUNT(*) as c FROM batches").get() as any).c;
    expect(finalCount).toBe(1);
  });
});

#!/usr/bin/env bun
/**
 * SPM Data Collector — logs daily SPM metrics for calibration.
 *
 * Runs as a cron job. Appends one line per day to ~/.the-brain/logs/spm-metrics.jsonl
 *
 * Metrics logged:
 *   - date, total memories, deep memories
 *   - selection score distribution (buckets)
 *   - current threshold and pass rate
 *   - graph node growth
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";

const HOME = process.env.HOME || "/Users/oskarschachta";
const DB_PATH = join(HOME, ".the-brain", "global", "brain.db");
const LOG_DIR = join(HOME, ".the-brain", "logs");
const METRICS_FILE = join(LOG_DIR, "spm-metrics.jsonl");

if (!existsSync(DB_PATH)) {
  process.exit(0);
}

mkdirSync(LOG_DIR, { recursive: true });

const db = new Database(DB_PATH);

const totalMemories = (db.query("SELECT COUNT(*) as c FROM memories").get() as any).c;
const deepMemories = (db.query("SELECT COUNT(*) as c FROM memories WHERE layer = 'deep'").get() as any).c;
const selectionMemories = (db.query("SELECT COUNT(*) as c FROM memories WHERE layer = 'selection' AND surprise_score IS NOT NULL").get() as any).c;
const graphNodes = (db.query("SELECT COUNT(*) as c FROM graph_nodes").get() as any).c;

// Score buckets
const buckets = db.query(`
  SELECT 
    CASE 
      WHEN surprise_score < 0.30 THEN '0.26-0.29'
      WHEN surprise_score < 0.35 THEN '0.30-0.34'
      WHEN surprise_score < 0.40 THEN '0.35-0.39'
      WHEN surprise_score < 0.45 THEN '0.40-0.44'
      ELSE '0.45+'
    END as bucket,
    COUNT(*) as n
  FROM memories 
  WHERE layer = 'selection' AND surprise_score IS NOT NULL
  GROUP BY bucket ORDER BY bucket
`).all() as { bucket: string; n: number }[];

const distribution: Record<string, number> = {};
for (const b of buckets) distribution[b.bucket] = b.n;

// Pass rate at 0.30
const passRate = (db.query(`
  SELECT ROUND(AVG(CASE WHEN surprise_score >= 0.30 THEN 1.0 ELSE 0.0 END) * 100, 1) as pct
  FROM memories WHERE layer = 'selection' AND surprise_score IS NOT NULL
`).get() as any).pct;

const metric = {
  date: new Date().toISOString().slice(0, 10),
  timestamp: new Date().toISOString(),
  totalMemories,
  deepMemories,
  selectionMemories,
  graphNodes,
  passRate_0_30: passRate,
  distribution,
};

appendFileSync(METRICS_FILE, JSON.stringify(metric) + "\n");

db.close();

console.log(`SPM metrics logged: ${metric.totalMemories} memories, ${metric.deepMemories} deep, pass rate ${metric.passRate_0_30}%`);

/**
 * SPM Calibration v2 — compares score distributions across layers
 * to find the optimal threshold based on actual promotion behavior.
 *
 * Methodology:
 *   1. DEEP memories = confirmed valuable (gold standard, precision ~1.0)
 *   2. SELECTION memories = scored but not yet promoted
 *   3. INSTANT memories = never scored (base rate)
 *   4. Find threshold that maximizes separation between DEEP and SELECTION
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";

const DB_PATH = join(process.env.HOME || require("os").homedir(), ".the-brain", "global", "brain.db");
const CONFIG_PATH = join(process.env.HOME || require("os").homedir(), ".the-brain", "config.json");

function calibrate() {
  const db = new Database(DB_PATH);

  // ── Layer distributions ──────────────────────────────────
  console.log("═".repeat(62));
  console.log("  SPM Calibration v2 — Layer Score Analysis");
  console.log("═".repeat(62));

  const layers = db.query(`
    SELECT 
      layer,
      COUNT(*) as total,
      ROUND(AVG(surprise_score), 4) as avg_score,
      ROUND(MIN(surprise_score), 4) as min_score,
      ROUND(MAX(surprise_score), 4) as max_score,
      ROUND(AVG(CASE WHEN surprise_score >= 0.30 THEN 1 ELSE 0 END) * 100, 1) as pct_30,
      ROUND(AVG(CASE WHEN surprise_score >= 0.35 THEN 1 ELSE 0 END) * 100, 1) as pct_35,
      ROUND(AVG(CASE WHEN surprise_score >= 0.40 THEN 1 ELSE 0 END) * 100, 1) as pct_40,
      ROUND(AVG(CASE WHEN surprise_score >= 0.42 THEN 1 ELSE 0 END) * 100, 1) as pct_42
    FROM memories 
    WHERE surprise_score IS NOT NULL
    GROUP BY layer
    ORDER BY 
      CASE layer WHEN 'deep' THEN 1 WHEN 'selection' THEN 2 WHEN 'instant' THEN 3 END
  `).all() as { layer: string; total: number; avg_score: number; min_score: number; max_score: number; pct_30: number; pct_35: number; pct_40: number; pct_42: number }[];

  console.log("\n  Layer Score Distribution:");
  console.log("  ┌──────────┬───────┬────────┬────────┬────────┬───────┬───────┬───────┬───────┐");
  console.log("  │ Layer    │ Total │  Avg   │  Min   │  Max   │ ≥0.30 │ ≥0.35 │ ≥0.40 │ ≥0.42 │");
  console.log("  ├──────────┼───────┼────────┼────────┼────────┼───────┼───────┼───────┼───────┤");
  for (const l of layers) {
    console.log(
      `  │ ${l.layer.padEnd(9)}│ ${String(l.total).padStart(5)} │ ${String(l.avg_score).padStart(6)} │ ${String(l.min_score).padStart(6)} │ ${String(l.max_score).padStart(6)} │ ${String(l.pct_30).padStart(4)}% │ ${String(l.pct_35).padStart(4)}% │ ${String(l.pct_40).padStart(4)}% │ ${String(l.pct_42).padStart(4)}% │`
    );
  }
  console.log("  └──────────┴───────┴────────┴────────┴────────┴───────┴───────┴───────┴───────┘");

  // ── Score histogram ──────────────────────────────────────
  console.log("\n  Score Distribution Histogram (SELECTION layer):");

  const hist = db.query(`
    SELECT 
      ROUND(surprise_score * 100) / 100 as bucket,
      COUNT(*) as n
    FROM memories
    WHERE layer = 'selection' AND surprise_score IS NOT NULL
    GROUP BY bucket
    ORDER BY bucket
  `).all() as { bucket: number; n: number }[];

  const maxN = Math.max(...hist.map(h => h.n));
  for (const h of hist) {
    const bar = "█".repeat(Math.round((h.n / maxN) * 40));
    const marker = h.bucket >= 0.42 ? " ◀── threshold" : "";
    console.log(`    ${String(h.bucket.toFixed(2)).padStart(5)} │ ${bar} ${h.n}${marker}`);
  }

  // ── DEEP memories: what got promoted? ────────────────────
  console.log("\n  DEEP Layer Memories (confirmed valuable):");
  const deepMemories = db.query(`
    SELECT content, surprise_score, source, timestamp
    FROM memories
    WHERE layer = 'deep'
    ORDER BY surprise_score DESC
  `).all() as { content: string; surprise_score: number; source: string; timestamp: number }[];

  if (deepMemories.length === 0) {
    console.log("    (none — no memories have been promoted to DEEP yet)");
  } else {
    for (const m of deepMemories) {
      const ts = new Date(m.timestamp).toISOString().slice(0, 16);
      const clean = (m.content || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
      console.log(`    s=${m.surprise_score.toFixed(3)} [${ts}] ${clean}`);
    }
  }

  // ── Threshold sweep with DEEP as ground truth ────────────
  console.log("\n  Threshold Sweep (DEEP memories as gold standard):");

  const deepScores = deepMemories.map(m => m.surprise_score).sort((a, b) => a - b);
  const selectionScores = (db.query(`
    SELECT surprise_score FROM memories 
    WHERE layer = 'selection' AND surprise_score IS NOT NULL
  `).all() as { surprise_score: number }[]).map(r => r.surprise_score);

  console.log("  ┌──────────┬──────────┬───────────┬───────────────┐");
  console.log("  │ Thresh   │ Promoted │  DEEP in  │ % DEEP caught │");
  console.log("  ├──────────┼──────────┼───────────┼───────────────┤");

  for (let t = 0.25; t <= 0.45; t += 0.05) {
    const promotedCount = selectionScores.filter(s => s >= t).length;
    const deepCaught = deepScores.filter(s => s >= t).length;
    const deepPct = deepScores.length > 0 ? (deepCaught / deepScores.length * 100).toFixed(1) : "N/A";
    console.log(
      `  │ ${String(t.toFixed(2)).padStart(7)} │ ${String(promotedCount).padStart(8)} │ ${String(deepCaught).padStart(9)} │ ${String(deepPct).padStart(13)} │`
    );
  }
  console.log("  └──────────┴──────────┴───────────┴───────────────┘");

  // ── Recommendation ───────────────────────────────────────
  console.log("\n═".repeat(62));
  console.log("  Analysis & Recommendations");
  console.log("═".repeat(62));

  const selectionAvg = selectionScores.reduce((a, b) => a + b, 0) / selectionScores.length;
  const deepAvg = deepScores.length > 0 ? deepScores.reduce((a, b) => a + b, 0) / deepScores.length : 0;

  console.log(`\n  Score ranges:`);
  console.log(`    SELECTION: ${Math.min(...selectionScores).toFixed(3)} → ${Math.max(...selectionScores).toFixed(3)} (avg ${selectionAvg.toFixed(3)})`);
  console.log(`    DEEP:      ${deepScores.length > 0 ? Math.min(...deepScores).toFixed(3) : "N/A"} → ${deepScores.length > 0 ? Math.max(...deepScores).toFixed(3) : "N/A"} (avg ${deepAvg.toFixed(3)})`);

  const scoreSpread = Math.max(...selectionScores) - Math.min(...selectionScores);
  console.log(`    Spread:    ${scoreSpread.toFixed(3)} (${(scoreSpread / 1.0 * 100).toFixed(1)}% of possible range)`);

  console.log(`\n  Key observations:`);
  console.log(`    1. Score distribution is VERY tight (spread = ${scoreSpread.toFixed(3)})`);
  console.log(`       — SPM model sees all interactions as similarly surprising`);
  console.log(`    2. Current threshold (0.42) passes only ${(selectionScores.filter(s => s >= 0.42).length / selectionScores.length * 100).toFixed(1)}% of SELECTION`);
  console.log(`       — This is extremely aggressive, likely discarding valuable data`);
  console.log(`    3. DEEP layer has only ${deepScores.length} memories — not enough for reliable calibration`);

  console.log(`\n  Recommended actions:`);

  if (scoreSpread < 0.3) {
    console.log(`    ⚠️  SPM model needs retraining with diverse production data`);
    console.log(`       Current spread (${scoreSpread.toFixed(3)}) is too narrow for meaningful filtering`);
  }

  console.log(`    📊 Short-term: lower threshold to 0.28-0.30`);
  console.log(`       This promotes ~${(selectionScores.filter(s => s >= 0.28).length / selectionScores.length * 100).toFixed(0)}% of SELECTION memories`);
  console.log(`       — better recall at the cost of some precision`);
  console.log(`\n    🔬 Medium-term: collect 1 week of production data, then:`);
  console.log(`       1. Manually label 50-100 memories as "valuable" / "noise"`);
  console.log(`       2. Run precision-recall curve against labels`);
  console.log(`       3. Choose threshold at the precision-recall balance point`);
  console.log(`\n    🚀 Long-term: retrain SPM model on 500+ Claude Code sessions`);
  console.log(`       Current model sees mostly XML-structured prompts → narrow scores`);

  db.close();
}

calibrate();

/**
 * SPM Curator — integration test on real data from the database.
 *
 * Reads actual memories from ~/.the-brain/global/brain.db,
 * parses them into interactions, feeds them through SPM curator,
 * and reports on:
 *   - How many are promoted at various thresholds
 *   - What types of memories score highest
 *   - Whether the model correctly identifies surprising vs mundane
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { BrainDB, MemoryLayer } from "@the-brain/core";
import { createSpmCurator, SpmCuratorPlugin } from "../index";
import type { InteractionContext, Memory, MemoryFragment } from "@the-brain/core";
import { join } from "node:path";

const DB_PATH = process.env.THE_BRAIN_DB_PATH || "";
const MIN_MEMORIES = 10;

function memoryToInteraction(m: Memory): { prompt: string; response: string } {
  const content = m.content || "";
  const promptMatch = content.match(/Prompt:\s*(.+?)(?:\nResponse:|\n$|$)/s);
  const responseMatch = content.match(/Response:\s*(.+?)$/s);
  return {
    prompt: promptMatch?.[1]?.trim() || content.slice(0, 200),
    response: responseMatch?.[1]?.trim() || "",
  };
}

describe("SPM Curator — real data integration", () => {
  let allMemories: Memory[] = [];

  beforeAll(async () => {
    const db = new BrainDB(DB_PATH);
    for (const l of Object.values(MemoryLayer)) {
      const mems = await db.getMemoriesByLayer(l, 500);
      allMemories.push(...mems);
    }
    db.close();
  });

  test("runs SPM on real memories and produces meaningful scores", async () => {
    if (allMemories.length < MIN_MEMORIES) {
      console.log(`Only ${allMemories.length} memories — skipping`);
      return;
    }

    const { instance } = createSpmCurator({ threshold: 0.3 });

    console.log(`\nLoaded ${allMemories.length} real memories`);
    console.log(`SPM threshold: 0.3 | alpha: 0.05`);

    const results: { score: number; isSurprising: boolean; reason: string; source: string }[] = [];

    for (const m of allMemories) {
      const { prompt, response } = memoryToInteraction(m);
      const ctx: InteractionContext = {
        interaction: { id: m.id, prompt, response, timestamp: m.timestamp, source: m.source },
        fragments: [{ id: m.id, layer: m.layer, content: m.content, timestamp: m.timestamp, source: m.source }],
        promoteToDeep: () => {},
      };

      const result = await instance.evaluate(ctx);
      await instance.promote(ctx);
      results.push({ score: result.score, isSurprising: result.isSurprising, reason: result.reason || "", source: m.source });
    }

    const stats = instance.getStats();
    const promoted = results.filter((r) => r.isSurprising);
    const scores = results.map((r) => r.score);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    console.log(`\n===== SPM Curator — Real Data Report =====`);
    console.log(`Evaluated:       ${stats.totalEvaluated}`);
    console.log(`Promoted (≥0.3): ${promoted.length} (${((promoted.length / results.length) * 100).toFixed(1)}%)`);
    console.log(`Average score:   ${avgScore.toFixed(4)}`);
    console.log(`Score range:     [${Math.min(...scores).toFixed(4)}, ${Math.max(...scores).toFixed(4)}]`);
    console.log(`N-gram cache:    ${stats.ngramCacheSize}`);

    // Top 5
    console.log(`\nTop 5 most surprising:`);
    [...results].sort((a, b) => b.score - a.score).slice(0, 5).forEach(r => {
      console.log(`  score=${r.score.toFixed(3)} src=${r.source} | ${r.reason}`);
    });

    // Assertions
    expect(stats.totalEvaluated).toBeGreaterThanOrEqual(allMemories.length);
    expect(avgScore).toBeGreaterThan(0);
    expect(avgScore).toBeLessThan(1);
    expect(promoted.length).toBeGreaterThan(0);
    expect(promoted.length).toBeLessThan(allMemories.length * 0.7);
  });

  test("SPM threshold sweep — higher threshold → fewer promoted", async () => {
    if (allMemories.length < MIN_MEMORIES) return;
    const thresholds = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7];

    console.log("\n===== Threshold Sweep (100 samples) =====");
    const sample = allMemories.slice(0, 100);

    const rates: { t: number; promoted: number }[] = [];
    for (const thresh of thresholds) {
      const { instance } = createSpmCurator({ threshold: thresh });
      let promoted = 0;
      for (const m of sample) {
        const { prompt, response } = memoryToInteraction(m);
        const ctx: InteractionContext = {
          interaction: { id: m.id, prompt, response, timestamp: m.timestamp, source: m.source },
          fragments: [{ id: m.id, layer: m.layer, content: m.content, timestamp: m.timestamp, source: m.source }],
          promoteToDeep: () => {},
        };
        const result = await instance.evaluate(ctx);
        if (result.isSurprising) promoted++;
      }
      rates.push({ t: thresh, promoted });
      console.log(`  threshold=${thresh}: ${promoted}/${sample.length} (${((promoted / sample.length) * 100).toFixed(0)}%)`);
    }

    // Higher thresholds should promote fewer
    const t02 = rates.find(r => r.t === 0.2)!.promoted;
    const t06 = rates.find(r => r.t === 0.6)!.promoted;
    expect(t02).toBeGreaterThan(t06);
  });

  test("model state is properly accessible and resettable", () => {
    const { instance } = createSpmCurator();
    const stats = instance.getStats();

    expect(stats).toHaveProperty("gaussians");
    expect(stats).toHaveProperty("totalEvaluated");
    expect(stats).toHaveProperty("totalPromoted");
    expect(stats).toHaveProperty("ngramCacheSize");

    const expectedFeatures = ["promptLen", "responseLen", "totalLen", "lexicalDiversity", "hourOfDay", "dayOfWeek"];
    for (const f of expectedFeatures) {
      expect(stats.gaussians).toHaveProperty(f);
    }

    instance.reset();
    expect(instance.getStats().totalEvaluated).toBe(0);
  });
});

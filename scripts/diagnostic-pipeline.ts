// Diagnostic: run the full pipeline in foreground and inspect results.
// bun run scripts/diagnostic-pipeline.ts
import { BrainDB, createHookSystem, PluginManager, HookEvent } from "@my-brain/core";
import { createGraphMemoryPlugin } from "@my-brain/plugin-graph-memory";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";

async function main() {
  const dbPath = "/tmp/diag-" + Date.now() + ".db";
  const db = new BrainDB(dbPath);
  const hooks = createHookSystem();
  const pm = new PluginManager(hooks);

  // Load Graph Memory
  const graphMemory = createGraphMemoryPlugin(db, { recentInteractionLimit: 100, minKeywordLength: 2 });
  await pm.load(graphMemory);

  // Load Claude harvester
  const claudeMod = await import("@my-brain/plugin-harvester-claude");
  const claudePlugin = claudeMod.default || claudeMod;
  await pm.load(claudePlugin);

  // Load Cursor harvester
  const cursorMod = await import("@my-brain/plugin-harvester-cursor");
  const cursorPlugin = cursorMod.default || cursorMod;
  await pm.load(cursorPlugin);

  // Fire DAEMON_START so harvesters set up their polling
  // Then fire HARVESTER_POLL manually
  console.log("Firing HARVESTER_POLL...");
  await hooks.callHook(HookEvent.HARVESTER_POLL);

  // Give a moment for async processing
  await new Promise(r => setTimeout(r, 500));

  // Inspect DB
  const sqlite = new Database(dbPath);

  const memCount = sqlite.query("SELECT COUNT(*) as cnt FROM memories").get();
  console.log("\nMemories inserted:", memCount.cnt);

  const sessCount = sqlite.query("SELECT COUNT(*) as cnt FROM sessions").get();
  console.log("Sessions created:", sessCount.cnt);

  const graphCount = sqlite.query("SELECT COUNT(*) as cnt FROM graph_nodes").get();
  console.log("Graph nodes:", graphCount.cnt);

  if (graphCount.cnt > 0) {
    console.log("\n=== Graph nodes by type ===");
    const rows = sqlite.query("SELECT type, COUNT(*) as cnt, ROUND(AVG(weight), 2) as avg_w FROM graph_nodes GROUP BY type ORDER BY cnt DESC").all();
    for (const row of rows) {
      console.log("  " + row.type + ": " + row.cnt + " nodes (avg weight: " + row.avg_w + ")");
    }

    console.log("\n=== Top 10 graph nodes ===");
    const top = sqlite.query("SELECT type, weight, substr(label, 1, 60) as label, source FROM graph_nodes ORDER BY weight DESC LIMIT 10").all();
    for (const r of top) {
      console.log("  [" + r.type + "] w=" + r.weight + " src=" + r.source + ' "' + r.label + '"');
    }
  } else {
    console.log("\nNo graph nodes created. Checking harvester output...");
    // Check if the claude harvester found any sessions
    const stateFile = "/tmp/diag-state.json";
    const fs = await import("node:fs");
    
    // Try to find the issue by checking if the harvester found any interactions
    console.log("Checking harvester state files...");
    const home = process.env.HOME;
    const statePath = home + "/.my-brain/claude-harvester-state.json";
    try {
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      console.log("Claude state processedIds:", state.processedIds.length);
      console.log("Claude state fileOffsets:", Object.keys(state.fileOffsets).length);
    } catch { console.log("No claude state found"); }
  }

  sqlite.close();
  db.close();
  unlinkSync(dbPath);
  console.log("\nDone.");
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });

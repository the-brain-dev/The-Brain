// Verify pattern dedup: bun run apps/cli/src/verify-dedup.ts
import { BrainDB, createHookSystem, PluginManager, HookEvent } from "@my-brain/core";
import { createGraphMemoryPlugin } from "@my-brain/plugin-graph-memory";

async function main() {
  const db = new BrainDB("/tmp/dedup-test.db");
  const hooks = createHookSystem();
  const pm = new PluginManager(hooks);
  await pm.load(createGraphMemoryPlugin(db, { recentInteractionLimit: 50, minKeywordLength: 2 }));

  // Fire 3 interactions mentioning "typescript" — should create only 1 pattern node
  for (let i = 0; i < 3; i++) {
    await hooks.callHook(HookEvent.AFTER_RESPONSE, {
      id: "test-" + i, timestamp: Date.now(),
      prompt: "Fix #" + i + " in TypeScript code",
      response: "Actually, use `unknown` instead of `any` for type safety.",
      source: "test",
      metadata: {},
    });
  }

  const { Database } = await import("bun:sqlite");
  const d = new Database("/tmp/dedup-test.db");
  const patterns = d.query("SELECT COUNT(*) as c FROM graph_nodes WHERE type='pattern'").get() as any;
  const all = d.query("SELECT type, COUNT(*) as c FROM graph_nodes GROUP BY type").all() as any[];
  d.close(); db.close(); require("fs").unlinkSync("/tmp/dedup-test.db");

  console.log("Pattern nodes:", patterns.c, "(expected: ~2-3 unique patterns, not 3x duplicates)");
  for (const r of all) console.log("  " + r.type + ": " + r.c);
  if (patterns.c <= 3) console.log("✅ Dedup working");
  else console.log("❌ Still too many duplicates: " + patterns.c);
}
main().catch(e => { console.error(e); process.exit(1); });

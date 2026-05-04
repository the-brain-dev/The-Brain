// Full pipeline test: harvest, curate, MLX train
// bun run apps/cli/src/full-pipeline.ts
import { BrainDB, createHookSystem, PluginManager, HookEvent, MemoryLayer } from "@my-brain/core";
import { createGraphMemoryPlugin } from "@my-brain/plugin-graph-memory";
import { createSpmCurator } from "@my-brain/plugin-spm-curator";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

async function main() {
  const home = process.env.HOME || "/Users/oskarschachta";
  const dbPath = home + "/.my-brain/brain.db";
  const loraDir = home + "/.my-brain/lora-checkpoints";

  // Ensure directories exist
  mkdirSync(home + "/.my-brain", { recursive: true });
  mkdirSync(loraDir, { recursive: true });

  // Init DB and pipeline
  const db = new BrainDB(dbPath);
  const hooks = createHookSystem();
  const pm = new PluginManager(hooks);

  // Load Graph Memory
  await pm.load(createGraphMemoryPlugin(db, { minKeywordLength: 2, recentInteractionLimit: 200 }));

  // Load SPM Curator
  const spm = createSpmCurator();
  await pm.load(spm.definition);

  // Harvester handler
  let count = 0;
  hooks.hook(HookEvent.HARVESTER_NEW_DATA, async (ctx: any) => {
    count++;
    await db.insertMemory({
      id: "int-" + ctx.interaction.id,
      layer: MemoryLayer.INSTANT,
      content: "Prompt: " + ctx.interaction.prompt + "\nResponse: " + ctx.interaction.response.slice(0, 500),
      timestamp: ctx.interaction.timestamp,
      source: ctx.interaction.source,
    });
    await hooks.callHook(HookEvent.AFTER_RESPONSE, {
      id: ctx.interaction.id,
      timestamp: ctx.interaction.timestamp,
      prompt: ctx.interaction.prompt,
      response: ctx.interaction.response,
      source: ctx.interaction.source,
      metadata: ctx.interaction.metadata,
    });
  });

  // Load Claude Harvester
  const claudeMod = await import("@my-brain/plugin-harvester-claude");
  await pm.load(claudeMod.default || claudeMod);

  // Harvest
  console.log("Harvesting Claude Code data...");
  console.time("harvest");
  await hooks.callHook(HookEvent.HARVESTER_POLL);
  await new Promise(r => setTimeout(r, 500));
  console.timeEnd("harvest");
  console.log("Interactions harvested:", count);

  // Get stats
  const stats = await db.getStats();
  console.log("Memories:", stats.memories, "| Graph nodes:", stats.graphNodes);

  // Prepare training data from memories + graph nodes
  const { Database } = await import("bun:sqlite");
  const d = new Database(dbPath);

  // Get all memories for training  
  const memories = d.query(
    "SELECT content, source, layer FROM memories ORDER BY timestamp DESC LIMIT 50"
  ).all() as any[];

  // Convert to instruction-response format
  const trainingSamples: Array<{ instruction: string; response: string }> = [];
  for (const m of memories) {
    const promptMatch = m.content.match(/^Prompt: (.+?)$/m);
    const responseMatch = m.content.match(/^Response: (.+)/m);
    if (promptMatch && responseMatch) {
      trainingSamples.push({
        instruction: promptMatch[1].slice(0, 200),
        response: responseMatch[1].slice(0, 500),
      });
    }
  }

  console.log("Training samples:", trainingSamples.length);

  // Write training data
  const dataPath = loraDir + "/training_data.jsonl";
  writeFileSync(dataPath, trainingSamples.map(s => JSON.stringify(s)).join("\n"));

  // Prepare training command
  const sidecarPath = join(import.meta.dir || process.cwd(), "..", "..", "packages", "python-sidecar", "train.py");
  const resolvedSidecar = existsSync(sidecarPath) ? sidecarPath : 
    "/Users/oskarschachta/Projects/Private/my-brain/packages/python-sidecar/train.py";

  console.log("\n=== Training Command ===");
  console.log("cd packages/python-sidecar && uv run python3 " + resolvedSidecar + " \\");
  console.log("  --model-path mlx-community/SmolLM2-360M-Instruct \\");
  console.log("  --lora-output-dir " + loraDir + " \\");
  console.log("  --learning-rate 1e-4 --lora-rank 16 --lora-alpha 32 \\");
  console.log("  --batch-size 1 --max-seq-length 512 --iterations 50 \\");
  console.log("  --data-path " + dataPath);

  // Check if model exists
  const modelCache = home + "/.cache/huggingface/hub/models--mlx-community--SmolLM2-360M-Instruct";
  const modelReady = existsSync(modelCache);
  console.log("\nModel cached:", modelReady ? "YES" : "NO (download in progress)");

  if (modelReady) {
    console.log("\nModel ready! Running training...");
    // TODO: run the training
    console.log("Training would start now with", trainingSamples.length, "samples");
  } else {
    console.log("\nWaiting for model download to complete...");
    console.log("Run training manually when ready:");
    console.log("  cd ~/Projects/Private/my-brain/packages/python-sidecar");
    console.log("  uv run python3 " + resolvedSidecar + " \\");
    console.log("    --model-path mlx-community/SmolLM2-360M-Instruct \\");
    console.log("    --lora-output-dir " + loraDir + " \\");
    console.log("    --learning-rate 1e-4 --lora-rank 16 --lora-alpha 32 \\");
    console.log("    --batch-size 1 --max-seq-length 512 --iterations 50 \\");
    console.log("    --data-path " + dataPath);
  }

  d.close();
  db.close();
  console.log("\nDone.");
}

main().catch(e => { console.error(e); process.exit(1); });

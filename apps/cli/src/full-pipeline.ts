// Full pipeline test: harvest, curate, MLX train
// bun run apps/cli/src/full-pipeline.ts
import { BrainDB, createHookSystem, PluginManager, HookEvent, MemoryLayer } from "@the-brain/core";
import { createGraphMemoryPlugin } from "@the-brain/plugin-graph-memory";
import { createSpmCurator } from "@the-brain/plugin-spm-curator";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

async function main() {
  const home = process.env.HOME || "/tmp";
  const dbPath = home + "/.the-brain/brain.db";
  const loraDir = home + "/.the-brain/lora-checkpoints";

  // Ensure directories exist
  mkdirSync(home + "/.the-brain", { recursive: true });
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
  const claudeMod = await import("@the-brain/plugin-harvester-claude");
  await pm.load(claudeMod.default || claudeMod);

  // Load Hermes Harvester
  const hermesMod = await import("@the-brain/plugin-harvester-hermes");
  await pm.load(hermesMod.default || hermesMod);

  // Load lm-eval Harvester
  const lmEvalMod = await import("@the-brain/plugin-harvester-lm-eval");
  await pm.load(lmEvalMod.default || lmEvalMod);

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

  try {
  // Get all memories for training  
  const memories = d.query(
    "SELECT content, source, layer FROM memories ORDER BY timestamp DESC LIMIT 50"
  ).all() as MemoryRow[];

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
    join(import.meta.dir, "..", "..", "..", "..", "packages", "python-sidecar", "train.py");

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

  if (modelReady && trainingSamples.length > 0) {
    console.log("\nModel ready! Running MLX LoRA training...");
    console.log(`Training on ${trainingSamples.length} samples`);

    // Spawn MLX training via Python sidecar
    const { spawnSync } = await import("node:child_process");
    const startTime = Date.now();

    const child = spawnSync("uv", [
      "run", "python3", resolvedSidecar,
      "--model-path", "mlx-community/SmolLM2-360M-Instruct",
      "--lora-output-dir", loraDir,
      "--learning-rate", "1e-4",
      "--lora-rank", "16",
      "--lora-alpha", "32",
      "--batch-size", "1",
      "--max-seq-length", "512",
      "--iterations", "50",
      "--data", dataPath,
    ], {
      cwd: resolvedSidecar.replace(/\/[^/]+$/, ""),
      encoding: "utf-8",
      timeout: 600_000, // 10 min timeout
      stdio: ["pipe", "pipe", "pipe"],
    });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);

    if (child.error) {
      console.error(`\n❌ Training failed: ${child.error.message}`);
      process.exit(1);
    }
    if (child.status !== 0) {
      console.error(`\n❌ Training exited with code ${child.status}`);
      process.exit(1);
    }
    console.log(`\n✅ LoRA training complete in ${duration}s`);
    console.log(`   Checkpoint: ${loraDir}/adapter.safetensors`);
  } else if (!modelReady) {
    console.log("\nWaiting for model download to complete...");
    console.log("Run training manually when ready:");
    console.log("  cd ~/Projects/Private/the-brain/packages/python-sidecar");
    console.log("  uv run python3 " + resolvedSidecar + " \\");
    console.log("    --model-path mlx-community/SmolLM2-360M-Instruct \\");
    console.log("    --lora-output-dir " + loraDir + " \\");
    console.log("    --learning-rate 1e-4 --lora-rank 16 --lora-alpha 32 \\");
    console.log("    --batch-size 1 --max-seq-length 512 --iterations 50 \\");
    console.log("    --data-path " + dataPath);
  } else {
    console.log("\nNo training samples — skipping training.");
  }

  } finally {
    d.close();
    db.close();
  }
  console.log("\nDone.");
}

main().catch(e => { console.error(e); process.exit(1); });

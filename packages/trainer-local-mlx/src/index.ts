/**
 * @my-brain/trainer-local-mlx
 * Zero-cost, privacy-first LoRA training on Apple Silicon.
 * Wraps the Python MLX sidecar for local fine-tuning.
 */
import { definePlugin, HookEvent } from "@my-brain/core";
import type { ConsolidationContext, DeepLayerPlugin, MemoryLayer as ML } from "@my-brain/core";
import { MemoryLayer } from "@my-brain/core";
import { spawn } from "node:child_process";
import { join } from "node:path";

interface TrainerConfig {
  modelPath: string;
  loraOutputDir: string;
  pythonSidecarPath: string;
  learningRate: number;
  loraRank: number;
  loraAlpha: number;
  batchSize: number;
  maxSeqLength: number;
  iterations: number;
  minFragments: number;
}

const DEFAULT_CONFIG: TrainerConfig = {
  modelPath: "mlx-community/SmolLM2-135M-Instruct",
  loraOutputDir: join(process.env.HOME || "~", ".my-brain", "lora-checkpoints"),
  pythonSidecarPath: join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "packages",
    "python-sidecar",
    "train.py"
  ),
  learningRate: 1e-4,
  loraRank: 16,
  loraAlpha: 32,
  batchSize: 2,
  maxSeqLength: 512,
  iterations: 50,
  minFragments: 3,
};

export function createMlxTrainer(config: Partial<TrainerConfig> = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  async function runTraining(ctx: ConsolidationContext): Promise<void> {
    const { fragments } = ctx;

    if (fragments.length === 0) {
      console.log("[MLX Trainer] No fragments to train on, skipping");
      return;
    }

    if (fragments.length < cfg.minFragments) {
      console.log(`[MLX Trainer] Only ${fragments.length} fragments (need ${cfg.minFragments}), skipping`);
      return;
    }

    // Prepare training data, write to temp file (avoids CLI arg size limit)
    let trainingData = fragments.map((f) => ({
      text: f.content,
      metadata: f.metadata ?? {},
    }));

    // ── Quality filter: skip repetitive Bash/observation noise ──
    const beforeFilter = trainingData.length;
    trainingData = trainingData.filter((item) => {
      const text = item.text || "";
      // Skip raw XML observations (Bash, Read, Grep wrappers)
      if (/<what_happened>|observed_from_primary_session|<function_calls>/.test(text)) return false;
      // Skip progress summaries (repetitive boilerplate)
      if (/PROGRESS SUMMARY|CHECKPOINT/.test(text)) return false;
      // Skip very short fragments (no signal)
      if (text.trim().length < 20) return false;
      return true;
    });
    if (beforeFilter > trainingData.length) {
      console.log(
        `[MLX Trainer] Filtered ${beforeFilter - trainingData.length} low-signal fragments (${trainingData.length} kept)`
      );
    }

    // ── Identity Anchor integration ──────────────────────────
    // If identity anchor detected drift, it injects boosted fragments
    // to prevent catastrophic forgetting of core user preferences.
    const identityAnchor = (ctx as any).identityAnchor;
    const boostedFragments: Array<{ text: string; metadata: Record<string, unknown> }> =
      identityAnchor?.boostedFragments ?? [];

    if (boostedFragments.length > 0) {
      console.log(
        `[MLX Trainer] Identity anchor: adding ${boostedFragments.length} boosted fragments (drift: ${identityAnchor.drift?.toFixed(3)})`
      );
      trainingData = [...boostedFragments, ...trainingData];
    }

    const { writeFileSync, mkdirSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");

    const tmpDir = path.join(os.tmpdir(), "my-brain-train-" + Date.now());
    mkdirSync(tmpDir, { recursive: true });

    const dataFile = path.join(tmpDir, "fragments.json");
    writeFileSync(dataFile, JSON.stringify(trainingData));

    console.log(
      `[MLX Trainer] Starting LoRA training with ${fragments.length} fragments (data: ${dataFile})...`
    );

    await hooks.callHook(HookEvent.TRAINING_START, {
      fragmentCount: fragments.length,
      config: {
        modelPath: cfg.modelPath,
        loraRank: cfg.loraRank,
        iterations: cfg.iterations,
      },
    });

    const startTime = Date.now();

    try {
      const result = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          "uv",
          [
            "run",
            "--with",
            "mlx-lm",
            "python3",
            cfg.pythonSidecarPath,
            "--model-path",
            cfg.modelPath,
            "--lora-output-dir",
            cfg.loraOutputDir,
            "--learning-rate",
            String(cfg.learningRate),
            "--lora-rank",
            String(cfg.loraRank),
            "--lora-alpha",
            String(cfg.loraAlpha),
            "--batch-size",
            String(cfg.batchSize),
            "--max-seq-length",
            String(cfg.maxSeqLength),
            "--iterations",
            String(cfg.iterations),
            "--data",
            dataFile,
          ],
          {
            stdio: ["pipe", "pipe", "pipe"],
          }
        );

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (data: Buffer) => {
          stdout += data.toString();
          // Stream progress to console
          process.stderr.write(data);
        });

        child.stderr.on("data", (data: Buffer) => {
          stderr += data.toString();
          process.stderr.write(data);
        });

        child.on("close", (code: number) => {
          if (code === 0) {
            resolve(stdout);
          } else {
            reject(new Error(`MLX training failed (exit ${code}): ${stderr}`));
          }
        });

        child.on("error", reject);
      });

      const duration = (Date.now() - startTime) / 1000;
      console.log(`[MLX Trainer] Training complete in ${duration.toFixed(1)}s`);

      await hooks.callHook(HookEvent.TRAINING_COMPLETE, {
        duration,
        output: result,
        checkpointPath: cfg.loraOutputDir,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[MLX Trainer] Error: ${errorMsg}`);
      await hooks.callHook(HookEvent.TRAINING_ERROR, {
        error: errorMsg,
        fragmentCount: fragments.length,
      });
    }
  }

  // Create a placeholder hooks reference that gets set during setup
  let hooks: any;

  const trainerPlugin = definePlugin({
    name: "@my-brain/trainer-local-mlx",
    version: "0.1.0",
    description:
      "Zero-cost, privacy-first LoRA training on Apple Silicon using MLX",

    setup(h) {
      hooks = h;

      // Register as Deep Layer consolidator
      h.hook(HookEvent.DEEP_CONSOLIDATE, async (ctx: ConsolidationContext) => {
        await runTraining(ctx);
      });

      // Allow manual trigger
      h.hook("training:run" as any, async (ctx: ConsolidationContext) => {
        await runTraining(ctx);
      });
    },

    // Expose for direct CLI invocation (my-brain train)
    async train(ctx: ConsolidationContext): Promise<void> {
      await runTraining(ctx);
    },
  });

  return trainerPlugin;
}

export default createMlxTrainer;

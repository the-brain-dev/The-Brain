/**
 * train command — Trigger LoRA training on DEEP memories.
 *
 *   my-brain train                 Train on all DEEP-layer memories
 *   my-brain train --project <p>    Train on a specific project's DEEP memories
 *   my-brain train --global         Train on global brain DEEP memories
 *   my-brain train --iterations N   Override training iterations
 *   my-brain train --dry-run        Show what would be trained, don't execute
 */
import { consola } from "consola";
import { BrainDB, MemoryLayer } from "@my-brain/core";
import type { MemoryFragment, ConsolidationContext, MyBrainConfig } from "@my-brain/core";
import { createMlxTrainer } from "@my-brain/trainer-local-mlx";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const CONFIG_PATH = join(process.env.HOME || "~", ".my-brain", "config.json");
const DEFAULT_DB_PATH = join(process.env.HOME || "~", ".my-brain", "brain.db");

export async function trainCommand(options: {
  project?: string;
  global?: boolean;
  iterations?: number;
  dryRun?: boolean;
}) {
  let dbPath = DEFAULT_DB_PATH;

  // Resolve DB path from config
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = await readFile(CONFIG_PATH, "utf-8");
      const config: MyBrainConfig = JSON.parse(raw);

      if (options.project) {
        const ctx = config.contexts?.[options.project];
        if (!ctx) {
          consola.error(`Project "${options.project}" not found.`);
          process.exit(1);
        }
        dbPath = ctx.dbPath;
        consola.info(`Targeting project: ${options.project}`);
      } else if (options.global) {
        dbPath = config.database.path;
        consola.info("Targeting global brain");
      } else if (config.activeContext && config.activeContext !== "global" && config.contexts?.[config.activeContext]) {
        dbPath = config.contexts[config.activeContext].dbPath;
      } else {
        dbPath = config.database.path;
      }
    } catch {}
  }

  const db = new BrainDB(dbPath);

  try {
    // Load DEEP memories
    const deepMemories = await db.getMemoriesByLayer(MemoryLayer.DEEP, 500);

    if (deepMemories.length === 0) {
      consola.warn("No DEEP-layer memories found. Run `my-brain consolidate --now` first.");
      return;
    }

    // Convert to MemoryFragments
    const fragments: MemoryFragment[] = deepMemories.map((m) => ({
      id: m.id,
      layer: MemoryLayer.DEEP,
      content: m.content,
      surpriseScore: m.surpriseScore,
      timestamp: m.timestamp,
      source: m.source,
      metadata: m.metadata,
    }));

    consola.info(`Loaded ${fragments.length} DEEP memories for training`);

    if (options.dryRun) {
      consola.info("Dry run — would train on these fragments:");
      for (let i = 0; i < Math.min(fragments.length, 10); i++) {
        const preview = fragments[i].content.slice(0, 100).replace(/\n/g, " ");
        consola.info(`  ${i + 1}. [${fragments[i].source}] ${preview}...`);
      }
      if (fragments.length > 10) {
        consola.info(`  ... and ${fragments.length - 10} more`);
      }
      return;
    }

    // Build consolidation context
    const ctx: ConsolidationContext = {
      targetLayer: MemoryLayer.DEEP,
      fragments,
      results: {
        promoted: fragments.length,
        discarded: 0,
        remaining: 0,
        enrichedFragments: fragments,
      },
    };

    // Create trainer with optional iteration override
    const trainerConfig: Record<string, unknown> = {};
    if (options.iterations) {
      trainerConfig.iterations = options.iterations;
    }
    const trainer = createMlxTrainer(trainerConfig);

    consola.start(`Starting LoRA training with ${fragments.length} fragments...`);
    await trainer.train(ctx);
  } catch (err) {
    consola.error("Training failed:", err);
    process.exit(1);
  } finally {
    db.close();
  }
}

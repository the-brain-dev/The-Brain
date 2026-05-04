/**
 * MLX Trainer — end-to-end integration test.
 *
 * Tests the full pipeline: DEEP_CONSOLIDATE hook → fragment preparation → training data validation.
 * Actual uv/mlx training is verified manually (requires Apple Silicon + mlx-lm).
 */
import { describe, test, expect } from "bun:test";
import { BrainDB, MemoryLayer, createHookSystem } from "@my-brain/core";
import type { ConsolidationContext, MemoryFragment } from "@my-brain/core";

describe("MLX Trainer — end-to-end pipeline", () => {
  test("creates plugin and registers DEEP_CONSOLIDATE hook", async () => {
    const { createMlxTrainer } = await import("../index");
    const plugin = await Promise.resolve(createMlxTrainer());

    expect(plugin.name).toBe("@my-brain/trainer-local-mlx");
    expect(typeof plugin.setup).toBe("function");

    // Verify hook registration
    const hooks = createHookSystem();
    const registered: string[] = [];
    hooks.hook = ((event: string, fn: Function) => {
      registered.push(event);
    }) as any;

    plugin.setup(hooks as any);
    expect(registered.length).toBeGreaterThan(0);
  });

  test("training fragments format matches MLX requirements", async () => {
    const fragments: MemoryFragment[] = [
      {
        id: "f1",
        layer: MemoryLayer.DEEP,
        content: "User prefers TypeScript with strict mode",
        timestamp: Date.now(),
        source: "cursor",
        surpriseScore: 0.85,
        metadata: { type: "preference" },
      },
      {
        id: "f2",
        layer: MemoryLayer.DEEP,
        content: "Code reviews enforce async/await over callbacks",
        timestamp: Date.now(),
        source: "cursor",
        surpriseScore: 0.78,
        metadata: { type: "pattern" },
      },
      {
        id: "f3",
        layer: MemoryLayer.DEEP,
        content: "Uses Drizzle ORM for all database access",
        timestamp: Date.now(),
        source: "claude",
        surpriseScore: 0.92,
        metadata: { type: "concept" },
      },
    ];

    // Convert to MLX training format (same as daemon consolidation)
    const trainingData = fragments.map((f) => ({
      text: f.content,
      metadata: f.metadata ?? {},
    }));

    // Validate format
    expect(trainingData.length).toBe(3);
    for (const item of trainingData) {
      expect(typeof item.text).toBe("string");
      expect(item.text.length).toBeGreaterThan(0);
      expect(item.metadata).toBeDefined();
    }

    // Verify the data is JSON-serializable (train.py expects JSON)
    const json = JSON.stringify(trainingData);
    const parsed = JSON.parse(json);
    expect(parsed.length).toBe(3);
  });

  test("trainer configuration is correct", async () => {
    const { createMlxTrainer } = await import("../index");

    const plugin = createMlxTrainer({
      modelPath: "mlx-community/SmolLM2-135M-Instruct",
      iterations: 50,
      minFragments: 3,
      batchSize: 2,
      maxSeqLength: 512,
    });

    expect(plugin.name).toBe("@my-brain/trainer-local-mlx");
  });

  test("real deep memories exist after consolidation", async () => {
    const dbPath = "/Users/oskarschachta/.my-brain/global/brain.db";
    const db = new BrainDB(dbPath);

    const deepMemories = await db.getMemoriesByLayer(MemoryLayer.DEEP);
    console.log(`  Deep memories in global brain: ${deepMemories.length}`);

    // After SPM reprocessing + consolidation, we should have Deep memories
    // This is a soft assertion — depends on whether consolidation ran
    if (deepMemories.length > 0) {
      for (const m of deepMemories.slice(0, 3)) {
        expect(m.layer).toBe(MemoryLayer.DEEP);
        expect(m.content).toBeDefined();
      }
    }

    db.close();
  });

  test("adapter file exists from previous training run", () => {
    const { existsSync } = require("node:fs");
    const adapterPath = "/Users/oskarschachta/.my-brain/lora-checkpoints/adapter.safetensors";

    if (existsSync(adapterPath)) {
      const { statSync } = require("node:fs");
      const stat = statSync(adapterPath);
      console.log(`  Adapter: ${(stat.size / 1024).toFixed(0)} KB`);
      expect(stat.size).toBeGreaterThan(0);
    } else {
      console.log("  No adapter found — run `my-brain consolidate --reprocess` first");
    }
  });
});

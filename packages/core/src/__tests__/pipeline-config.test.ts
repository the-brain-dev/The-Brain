/**
 * PipelineConfig validation tests — schema parses correct configs, rejects malformed ones.
 */
import { describe, test, expect } from "bun:test";
import { TheBrainConfigSchema, parseConfig } from "@the-brain-dev/core";

const BASE_CONFIG = {
  plugins: [],
  daemon: { pollIntervalMs: 30000, logDir: "/tmp/logs" },
  database: { path: "/tmp/brain.db" },
  mlx: { enabled: false },
  wiki: { enabled: true, outputDir: "/tmp/wiki" },
  activeContext: "global",
  contexts: {},
};

describe("PipelineConfig schema", () => {
  test("valid pipeline parses correctly", () => {
    const raw = {
      ...BASE_CONFIG,
      pipeline: {
        harvesters: ["cursor", "claude"],
        layers: { instant: true, selection: true, deep: true },
        outputs: ["auto-wiki"],
        training: { mlx: false },
        llm: true,
      },
    };
    const result = parseConfig(raw);
    expect(result.pipeline).toBeDefined();
    expect(result.pipeline!.harvesters).toEqual(["cursor", "claude"]);
    expect(result.pipeline!.layers.instant).toBe(true);
    expect(result.pipeline!.training.mlx).toBe(false);
    expect(result.pipeline!.llm).toBe(true);
  });

  test("empty harvesters array is valid", () => {
    const raw = {
      ...BASE_CONFIG,
      pipeline: {
        harvesters: [],
        layers: { instant: true, selection: false, deep: true },
        outputs: [],
        training: { mlx: false },
        llm: false,
      },
    };
    const result = parseConfig(raw);
    expect(result.pipeline!.harvesters).toEqual([]);
  });

  test("all layers disabled is valid", () => {
    const raw = {
      ...BASE_CONFIG,
      pipeline: {
        harvesters: ["cursor"],
        layers: { instant: false, selection: false, deep: false },
        outputs: [],
        training: { mlx: false },
        llm: false,
      },
    };
    const result = parseConfig(raw);
    expect(result.pipeline!.layers.instant).toBe(false);
    expect(result.pipeline!.layers.selection).toBe(false);
    expect(result.pipeline!.layers.deep).toBe(false);
  });

  test("missing pipeline field is optional (backward compat)", () => {
    const raw = { ...BASE_CONFIG };
    const result = parseConfig(raw);
    expect(result.pipeline).toBeUndefined();
  });

  test("MLX disabled by default-like config", () => {
    const raw = {
      ...BASE_CONFIG,
      pipeline: {
        harvesters: ["cursor", "claude"],
        layers: { instant: true, selection: true, deep: true },
        outputs: ["auto-wiki"],
        training: { mlx: false },
        llm: true,
      },
    };
    const result = parseConfig(raw);
    expect(result.pipeline!.training.mlx).toBe(false);
  });

  test("LLM enabled by default-like config", () => {
    const raw = {
      ...BASE_CONFIG,
      pipeline: {
        harvesters: ["cursor", "claude"],
        layers: { instant: true, selection: true, deep: true },
        outputs: ["auto-wiki"],
        training: { mlx: false },
        llm: true,
      },
    };
    const result = parseConfig(raw);
    expect(result.pipeline!.llm).toBe(true);
  });

  test("multiple harvesters work", () => {
    const raw = {
      ...BASE_CONFIG,
      pipeline: {
        harvesters: ["cursor", "claude", "hermes", "gemini", "windsurf", "lm-eval"],
        layers: { instant: true, selection: true, deep: true },
        outputs: [],
        training: { mlx: false },
        llm: false,
      },
    };
    const result = parseConfig(raw);
    expect(result.pipeline!.harvesters).toHaveLength(6);
  });

  test("malformed pipeline rejects — missing required fields", () => {
    const raw = {
      ...BASE_CONFIG,
      pipeline: {
        harvesters: ["cursor"],
        // missing layers, outputs, training, llm
      },
    };
    try {
      parseConfig(raw);
      // Should not reach here — parseConfig should throw
      expect.unreachable("parseConfig should have thrown for missing pipeline fields");
    } catch (e: unknown) {
      expect((e as Error).message).toContain("pipeline");
    }
  });
});

/**
 * Pipeline engine tests — verify isPluginEnabled and registry structure.
 */
import { describe, test, expect } from "bun:test";
import { isPluginEnabled, PLUGIN_REGISTRY } from "../daemon";
import type { PluginEntry } from "../daemon";
import type { PipelineConfig } from "@the-brain-dev/core";

const defaultPipeline: PipelineConfig = {
  harvesters: ["cursor", "claude"],
  layers: { instant: true, selection: true, deep: true },
  outputs: ["auto-wiki"],
  training: { mlx: false },
  llm: true,
};

describe("isPluginEnabled", () => {
  test("always-loaded plugin returns true regardless of pipeline", () => {
    const entry = PLUGIN_REGISTRY.find(e => e.always)!;
    expect(entry).toBeDefined();
    expect(entry.name).toBe("data-curator");

    // True with pipeline
    expect(isPluginEnabled(entry, defaultPipeline)).toBe(true);
    // True without pipeline (undefined)
    expect(isPluginEnabled(entry, undefined)).toBe(true);
    // True even with empty pipeline
    expect(isPluginEnabled(entry, { harvesters: [], layers: { instant: false, selection: false, deep: false }, outputs: [], training: { mlx: false }, llm: false })).toBe(true);
  });

  test("undefined pipeline = everything enabled (backward compat)", () => {
    const cursor = PLUGIN_REGISTRY.find(e => e.name === "cursor")!;
    expect(isPluginEnabled(cursor, undefined)).toBe(true);

    const mlx = PLUGIN_REGISTRY.find(e => e.name === "mlx")!;
    expect(isPluginEnabled(mlx, undefined)).toBe(true);
  });

  test("harvester enabled when in harvesters list", () => {
    const cursor = PLUGIN_REGISTRY.find(e => e.name === "cursor")!;
    expect(cursor.type).toBe("harvester");

    expect(isPluginEnabled(cursor, defaultPipeline)).toBe(true);

    // Disable by removing from list
    const noCursor: PipelineConfig = { ...defaultPipeline, harvesters: ["claude"] };
    expect(isPluginEnabled(cursor, noCursor)).toBe(false);
  });

  test("harvester disabled when not in harvesters list", () => {
    const hermes = PLUGIN_REGISTRY.find(e => e.name === "hermes")!;
    expect(hermes.type).toBe("harvester");

    // Not in default harvesters
    expect(isPluginEnabled(hermes, defaultPipeline)).toBe(false);

    // Enable by adding
    const withHermes: PipelineConfig = { ...defaultPipeline, harvesters: [...defaultPipeline.harvesters, "hermes"] };
    expect(isPluginEnabled(hermes, withHermes)).toBe(true);
  });

  test("layer enabled when pipeline.layers.<key> is true", () => {
    const graph = PLUGIN_REGISTRY.find(e => e.name === "graph-memory")!;
    expect(graph.layerKey).toBe("instant");
    expect(isPluginEnabled(graph, defaultPipeline)).toBe(true);

    const spm = PLUGIN_REGISTRY.find(e => e.name === "spm-curator")!;
    expect(spm.layerKey).toBe("selection");
    expect(isPluginEnabled(spm, defaultPipeline)).toBe(true);

    const identity = PLUGIN_REGISTRY.find(e => e.name === "identity-anchor")!;
    expect(identity.layerKey).toBe("deep");
    expect(isPluginEnabled(identity, defaultPipeline)).toBe(true);
  });

  test("layer disabled when pipeline.layers.<key> is false", () => {
    const spm = PLUGIN_REGISTRY.find(e => e.name === "spm-curator")!;
    const noSelection: PipelineConfig = {
      ...defaultPipeline,
      layers: { instant: true, selection: false, deep: true },
    };
    expect(isPluginEnabled(spm, noSelection)).toBe(false);
  });

  test("all layers can be disabled", () => {
    const allOff: PipelineConfig = {
      ...defaultPipeline,
      layers: { instant: false, selection: false, deep: false },
    };

    const graph = PLUGIN_REGISTRY.find(e => e.name === "graph-memory")!;
    const spm = PLUGIN_REGISTRY.find(e => e.name === "spm-curator")!;
    const identity = PLUGIN_REGISTRY.find(e => e.name === "identity-anchor")!;

    expect(isPluginEnabled(graph, allOff)).toBe(false);
    expect(isPluginEnabled(spm, allOff)).toBe(false);
    expect(isPluginEnabled(identity, allOff)).toBe(false);
  });

  test("output enabled when in outputs list", () => {
    const wiki = PLUGIN_REGISTRY.find(e => e.name === "auto-wiki")!;
    expect(wiki.type).toBe("output");

    expect(isPluginEnabled(wiki, defaultPipeline)).toBe(true);

    const noOutput: PipelineConfig = { ...defaultPipeline, outputs: [] };
    expect(isPluginEnabled(wiki, noOutput)).toBe(false);
  });

  test("MLX training toggled by pipeline.training.mlx", () => {
    const mlx = PLUGIN_REGISTRY.find(e => e.name === "mlx")!;
    expect(mlx.type).toBe("training");

    // Default: disabled
    expect(isPluginEnabled(mlx, defaultPipeline)).toBe(false);

    // Enabled
    const withMlx: PipelineConfig = {
      ...defaultPipeline,
      training: { mlx: true },
    };
    expect(isPluginEnabled(mlx, withMlx)).toBe(true);
  });

  test("all harvesters in registry match their config keys", () => {
    const harvesters = PLUGIN_REGISTRY.filter(e => e.type === "harvester");
    expect(harvesters.length).toBe(6);
    const names = harvesters.map(e => e.name);
    expect(names).toContain("cursor");
    expect(names).toContain("claude");
    expect(names).toContain("hermes");
    expect(names).toContain("lm-eval");
    expect(names).toContain("windsurf");
    expect(names).toContain("gemini");

    // Each harvester's configKey === name
    for (const h of harvesters) {
      expect(h.configKey).toBe(h.name);
    }
  });

  test("empty harvesters means nothing loaded", () => {
    const emptyHarvesters: PipelineConfig = {
      ...defaultPipeline,
      harvesters: [],
    };
    for (const entry of PLUGIN_REGISTRY) {
      if (entry.type === "harvester") {
        expect(isPluginEnabled(entry, emptyHarvesters)).toBe(false);
      }
    }
  });
});

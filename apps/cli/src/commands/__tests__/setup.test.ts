/**
 * setup command tests — config loading, --status, flag-based mutations.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_HOME = join(tmpdir(), "the-brain-setup-test-" + Date.now());

beforeAll(async () => {
  await mkdir(join(TEST_HOME, ".the-brain"), { recursive: true });
  process.env.HOME = TEST_HOME;
});

afterAll(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
});

function makeConfigJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify(
    {
      plugins: [],
      daemon: { pollIntervalMs: 30000, logDir: join(TEST_HOME, ".the-brain", "logs") },
      database: { path: join(TEST_HOME, ".the-brain", "global", "brain.db") },
      mlx: { enabled: false },
      wiki: { enabled: true, outputDir: join(TEST_HOME, ".the-brain", "global", "wiki") },
      activeContext: "global",
      contexts: {},
      ...overrides,
    },
    null,
    2,
  );
}

describe("setupCommand", () => {
  test("module exports setupCommand function", async () => {
    const mod = await import("../setup");
    expect(typeof mod.setupCommand).toBe("function");
  });

  test("--status with no pipeline field shows warning", async () => {
    // Write config WITHOUT pipeline
    const configPath = join(TEST_HOME, ".the-brain", "config.json");
    await writeFile(configPath, makeConfigJson({ pipeline: undefined }));

    const { setupCommand } = await import("../setup");
    // --status should not throw when pipeline is missing
    // It reads config and shows "No pipeline configured" message
    await setupCommand({ status: true });
    // If we got here without throwing, the test passes
  });

  test("--status with pipeline shows full config", async () => {
    const configPath = join(TEST_HOME, ".the-brain", "config.json");
    await writeFile(
      configPath,
      makeConfigJson({
        pipeline: {
          harvesters: ["cursor", "hermes"],
          layers: { instant: true, selection: false, deep: true },
          outputs: [],
          training: { mlx: true },
          llm: false,
        },
      }),
    );

    const { setupCommand } = await import("../setup");
    await setupCommand({ status: true });
    // Should not throw
  });

  test("--enable adds harvester to pipeline", async () => {
    const configPath = join(TEST_HOME, ".the-brain", "config.json");
    await writeFile(
      configPath,
      makeConfigJson({
        pipeline: {
          harvesters: ["cursor"],
          layers: { instant: true, selection: true, deep: true },
          outputs: ["auto-wiki"],
          training: { mlx: false },
          llm: true,
        },
      }),
    );

    const { setupCommand } = await import("../setup");
    await setupCommand({ enable: "claude,gemini" });

    // Read back and verify
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw);
    expect(config.pipeline.harvesters).toContain("cursor");
    expect(config.pipeline.harvesters).toContain("claude");
    expect(config.pipeline.harvesters).toContain("gemini");
    expect(config.pipeline.harvesters.length).toBe(3);
  });

  test("--disable removes harvester from pipeline", async () => {
    const configPath = join(TEST_HOME, ".the-brain", "config.json");
    await writeFile(
      configPath,
      makeConfigJson({
        pipeline: {
          harvesters: ["cursor", "claude", "hermes"],
          layers: { instant: true, selection: true, deep: true },
          outputs: ["auto-wiki"],
          training: { mlx: false },
          llm: true,
        },
      }),
    );

    const { setupCommand } = await import("../setup");
    await setupCommand({ disable: "claude" });

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw);
    expect(config.pipeline.harvesters).toEqual(["cursor", "hermes"]);
  });

  test("--layer-instant off toggles boolean", async () => {
    const configPath = join(TEST_HOME, ".the-brain", "config.json");
    await writeFile(
      configPath,
      makeConfigJson({
        pipeline: {
          harvesters: ["cursor"],
          layers: { instant: true, selection: true, deep: true },
          outputs: ["auto-wiki"],
          training: { mlx: false },
          llm: true,
        },
      }),
    );

    const { setupCommand } = await import("../setup");
    await setupCommand({ layerInstant: "off" });

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw);
    expect(config.pipeline.layers.instant).toBe(false);
  });

  test("--mlx on toggles MLX training", async () => {
    const configPath = join(TEST_HOME, ".the-brain", "config.json");
    await writeFile(
      configPath,
      makeConfigJson({
        pipeline: {
          harvesters: ["cursor"],
          layers: { instant: true, selection: true, deep: true },
          outputs: [],
          training: { mlx: false },
          llm: false,
        },
      }),
    );

    const { setupCommand } = await import("../setup");
    await setupCommand({ mlx: "on" });

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw);
    expect(config.pipeline.training.mlx).toBe(true);
  });

  test("--output sets output plugins list", async () => {
    const configPath = join(TEST_HOME, ".the-brain", "config.json");
    await writeFile(
      configPath,
      makeConfigJson({
        pipeline: {
          harvesters: ["cursor"],
          layers: { instant: true, selection: true, deep: true },
          outputs: ["auto-wiki"],
          training: { mlx: false },
          llm: false,
        },
      }),
    );

    const { setupCommand } = await import("../setup");
    await setupCommand({ output: "" });

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw);
    expect(config.pipeline.outputs).toEqual([]);
  });

  test("unknown harvester in --enable warns but doesn't crash", async () => {
    const configPath = join(TEST_HOME, ".the-brain", "config.json");
    await writeFile(
      configPath,
      makeConfigJson({
        pipeline: {
          harvesters: ["cursor"],
          layers: { instant: true, selection: true, deep: true },
          outputs: [],
          training: { mlx: false },
          llm: false,
        },
      }),
    );

    const { setupCommand } = await import("../setup");
    // Should not throw — warns and continues
    await setupCommand({ enable: "bogus-harvester" });

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw);
    // Pipeline unchanged
    expect(config.pipeline.harvesters).toEqual(["cursor"]);
  });
});

describe("yesNo helper", () => {
  test("empty input returns default", async () => {
    const { yesNo } = await import("../setup");
    expect(yesNo("", true)).toBe(true);
    expect(yesNo("", false)).toBe(false);
  });

  test("y/Y returns true", async () => {
    const { yesNo } = await import("../setup");
    expect(yesNo("y", false)).toBe(true);
    expect(yesNo("Y", false)).toBe(true);
    expect(yesNo("yes", true)).toBe(true);
  });

  test("n/N returns false", async () => {
    const { yesNo } = await import("../setup");
    expect(yesNo("n", true)).toBe(false);
    expect(yesNo("N", true)).toBe(false);
    expect(yesNo("no", true)).toBe(false);
  });
});

describe("showReview back/retry flow", () => {
  test("Enter returns true (save)", async () => {
    const { showReview } = await import("../setup");
    const mockRl = {
      question: (_q: string, cb: (answer: string) => void) => cb(""),
      close: () => {},
    } as any;

    const pipeline = {
      harvesters: ["cursor"],
      layers: { instant: true, selection: true, deep: true },
      outputs: ["auto-wiki"],
      training: { mlx: false },
      llm: false,
    };

    const result = await showReview(mockRl, pipeline);
    expect(result).toBe(true);
  });

  test("'q' returns false (quit)", async () => {
    const { showReview } = await import("../setup");
    const mockRl = {
      question: (_q: string, cb: (answer: string) => void) => cb("q"),
      close: () => {},
    } as any;

    const pipeline = {
      harvesters: ["cursor"],
      layers: { instant: true, selection: true, deep: true },
      outputs: [],
      training: { mlx: false },
      llm: false,
    };

    const result = await showReview(mockRl, pipeline);
    expect(result).toBe(false);
  });

  test("'b' returns false (back to retry)", async () => {
    const { showReview } = await import("../setup");
    const mockRl = {
      question: (_q: string, cb: (answer: string) => void) => cb("b"),
      close: () => {},
    } as any;

    const pipeline = {
      harvesters: ["cursor", "claude"],
      layers: { instant: true, selection: false, deep: true },
      outputs: ["auto-wiki"],
      training: { mlx: true },
      llm: true,
    };

    const result = await showReview(mockRl, pipeline);
    expect(result).toBe(false); // back → loop should re-run
  });
});

describe("getDefaultPipeline", () => {
  test("returns expected defaults", async () => {
    const { getDefaultPipeline } = await import("../setup");
    const pipeline = getDefaultPipeline();
    expect(pipeline.harvesters).toEqual(["cursor", "claude"]);
    expect(pipeline.layers.instant).toBe(true);
    expect(pipeline.layers.selection).toBe(true);
    expect(pipeline.layers.deep).toBe(true);
    expect(pipeline.outputs).toEqual(["auto-wiki"]);
    expect(pipeline.training.mlx).toBe(false);
    expect(pipeline.llm).toBe(true);
  });
});

/**
 * Tests for HarnessFingerprintStore — Phase 2 Regression Fingerprinting
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { HarnessFingerprintStore } from "../fingerprint-store";

let TEST_HOME: string;
let store: HarnessFingerprintStore;

beforeEach(() => {
  TEST_HOME = join(
    tmpdir(),
    "test-" + Date.now() + "-" + randomBytes(4).toString("hex"),
  );
  process.env.HOME = TEST_HOME;
  mkdirSync(join(TEST_HOME, ".the-brain", "identity"), { recursive: true });

  store = new HarnessFingerprintStore(
    join(TEST_HOME, ".the-brain", "identity", "harness-fingerprints.json"),
  );
});

afterEach(() => {
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    // cleanup may fail on some systems — ignore
  }
});

describe("HarnessFingerprintStore", () => {
  // ── CRUD ────────────────────────────────────────────────

  it("starts empty", () => {
    expect(store.size).toBe(0);
    expect(store.getAll()).toHaveLength(0);
  });

  it("creates fingerprint on first update", () => {
    const fp = store.update("claude-sonnet-4", "mmlu", "acc", 0.892);
    expect(fp.modelName).toBe("claude-sonnet-4");
    expect(fp.benchmark).toBe("mmlu");
    expect(fp.metric).toBe("acc");
    expect(fp.mean).toBe(0.892);
    expect(fp.n).toBe(1);
    expect(fp.std).toBe(0);
    expect(store.size).toBe(1);
  });

  it("updates existing fingerprint", () => {
    store.update("test-model", "gsm8k", "exact_match", 0.90);
    const fp = store.update("test-model", "gsm8k", "exact_match", 0.92);

    expect(fp.n).toBe(2);
    expect(fp.mean).toBe(0.91);
    expect(fp.std).toBeGreaterThan(0);
    expect(fp.values).toEqual([0.90, 0.92]);
  });

  it("caps values at 100 entries", () => {
    for (let i = 0; i < 150; i++) {
      store.update("cap-test", "mmlu", "acc", 0.89 + (i % 5) * 0.001);
    }
    const fp = store.get("cap-test", "mmlu", "acc")!;
    expect(fp.values.length).toBeLessThanOrEqual(100);
    expect(fp.n).toBeLessThanOrEqual(100);
  });

  it("get returns correct fingerprint", () => {
    store.update("model-A", "mmlu", "acc", 0.85);
    store.update("model-B", "gsm8k", "exact_match", 0.92);

    expect(store.get("model-A", "mmlu", "acc")?.mean).toBe(0.85);
    expect(store.get("model-B", "gsm8k", "exact_match")?.mean).toBe(0.92);
    expect(store.get("nonexistent", "mmlu", "acc")).toBeUndefined();
  });

  it("getByModel returns all fingerprints for a model", () => {
    store.update("model-A", "mmlu", "acc", 0.85);
    store.update("model-A", "gsm8k", "exact_match", 0.90);
    store.update("model-B", "mmlu", "acc", 0.88);

    const byModel = store.getByModel("model-A");
    expect(byModel).toHaveLength(2);
  });

  it("getByBenchmark returns all fingerprints for a benchmark", () => {
    store.update("model-A", "mmlu", "acc", 0.85);
    store.update("model-B", "mmlu", "acc", 0.88);
    store.update("model-A", "gsm8k", "exact_match", 0.90);

    const byBench = store.getByBenchmark("mmlu");
    expect(byBench).toHaveLength(2);
  });

  // ── Batch update ────────────────────────────────────────

  it("batchUpdate processes multiple observations", () => {
    store.batchUpdate({
      "model-A::mmlu::acc": 0.85,
      "model-A::gsm8k::exact_match": 0.90,
      "model-B::mmlu::acc": 0.88,
    });
    expect(store.size).toBe(3);
  });

  it("batchUpdate igores malformed keys", () => {
    store.batchUpdate({
      "model-A::mmlu::acc": 0.85,
      "bad-key": 0.99,
      "also::bad": 0.50,
    });
    expect(store.size).toBe(1);
  });

  // ── Persistence ─────────────────────────────────────────

  it("saves and loads fingerprints", () => {
    store.update("model-A", "mmlu", "acc", 0.85);
    store.update("model-A", "gsm8k", "exact_match", 0.90);
    store.save();

    expect(existsSync(store["storePath"])).toBe(true);

    // Create a new store from the same file
    const store2 = new HarnessFingerprintStore(store["storePath"]);
    expect(store2.size).toBe(2);
    expect(store2.get("model-A", "mmlu", "acc")?.mean).toBe(0.85);
  });

  it("handles corrupted store file gracefully", () => {
    // Write invalid JSON
    const { writeFileSync } = require("node:fs");
    writeFileSync(store["storePath"], "not valid json {{{", "utf-8");

    const store2 = new HarnessFingerprintStore(store["storePath"]);
    expect(store2.size).toBe(0); // starts fresh
  });

  it("isDirty tracks changes", () => {
    expect(store.isDirty()).toBe(false);
    store.update("model", "bench", "metric", 0.5);
    expect(store.isDirty()).toBe(true);
    store.save();
    expect(store.isDirty()).toBe(false);
  });

  // ── Prediction ──────────────────────────────────────────

  it("predict returns null for unknown model", () => {
    expect(store.predict("unknown", "mmlu", "acc")).toBeNull();
  });

  it("predict returns range for known fingerprint", () => {
    // Build up a fingerprint with consistent scores
    for (let i = 0; i < 10; i++) {
      store.update("model-A", "mmlu", "acc", 0.89 + (i % 3) * 0.01);
    }

    const prediction = store.predict("model-A", "mmlu", "acc")!;
    expect(prediction).not.toBeNull();
    expect(prediction.predictedRange).toHaveLength(2);
    expect(prediction.predictedRange[0]).toBeLessThan(prediction.predictedRange[1]);
    expect(prediction.modelName).toBe("model-A");
    expect(prediction.benchmark).toBe("mmlu");
    expect(prediction.metric).toBe("acc");
  });

  it("prediction is cold start when n < 3", () => {
    store.update("model-A", "mmlu", "acc", 0.85);
    const prediction = store.predict("model-A", "mmlu", "acc")!;
    expect(prediction.isColdStart).toBe(true);
    expect(prediction.confidence).toBeLessThan(0.5);
  });

  it("prediction confidence grows with n", () => {
    // Cold start
    store.update("model-A", "mmlu", "acc", 0.85);
    const coldConf = store.predict("model-A", "mmlu", "acc")!.confidence;

    // Warm
    for (let i = 0; i < 20; i++) {
      store.update("model-A", "mmlu", "acc", 0.89);
    }
    const warmConf = store.predict("model-A", "mmlu", "acc")!.confidence;

    expect(warmConf).toBeGreaterThan(coldConf);
  });

  it("predictAll returns all metrics for model+benchmark", () => {
    store.update("model-A", "mmlu", "acc", 0.85);
    store.update("model-A", "mmlu", "acc_norm", 0.87);
    store.update("model-A", "gsm8k", "exact_match", 0.90);

    const predictions = store.predictAll("model-A", "mmlu");
    expect(predictions).toHaveLength(2);
  });

  // ── Surprise Assessment ─────────────────────────────────

  it("assess returns null for unknown model", () => {
    expect(store.assess("unknown", "mmlu", "acc", 0.85)).toBeNull();
  });

  it("assess detects anomaly when score is far from baseline", () => {
    // Build tight baseline
    for (let i = 0; i < 20; i++) {
      store.update("model-A", "mmlu", "acc", 0.90);
    }

    const assessment = store.assess("model-A", "mmlu", "acc", 0.70)!;
    expect(assessment.isAnomalous).toBe(true);
    expect(assessment.zScore).toBeGreaterThan(2);
    expect(assessment.surpriseScore).toBeGreaterThan(0.5);
  });

  it("assess does not flag normal variations", () => {
    for (let i = 0; i < 20; i++) {
      store.update("model-A", "mmlu", "acc", 0.90 + (i % 3) * 0.005);
    }

    const assessment = store.assess("model-A", "mmlu", "acc", 0.905)!;
    expect(assessment.isAnomalous).toBe(false);
    expect(assessment.zScore).toBeLessThanOrEqual(2);
  });

  it("assess respects cold start — never anomalous", () => {
    store.update("model-A", "mmlu", "acc", 0.85);
    store.update("model-A", "mmlu", "acc", 0.86);

    const assessment = store.assess("model-A", "mmlu", "acc", 0.50)!;
    // Even with a huge drift, cold start prevents flagging
    expect(assessment.isAnomalous).toBe(false);
    expect(assessment.prediction.isColdStart).toBe(true);
  });

  it("assessAll processes multiple metrics", () => {
    for (let i = 0; i < 10; i++) {
      store.update("model-A", "mmlu", "acc", 0.90 + (i % 3) * 0.01);
      store.update("model-A", "mmlu", "acc_norm", 0.91 + (i % 3) * 0.01);
    }

    const assessments = store.assessAll("model-A", "mmlu", {
      acc: 0.905,
      acc_norm: 0.60, // anomalous!
    });

    expect(assessments).toHaveLength(2);
    expect(assessments.find((a) => a.prediction.metric === "acc")!.isAnomalous).toBe(false);
    expect(assessments.find((a) => a.prediction.metric === "acc_norm")!.isAnomalous).toBe(true);
  });

  // ── Drift Detection ─────────────────────────────────────

  it("detectDrift returns no drift for empty store", () => {
    const result = store.detectDrift("unknown", "mmlu");
    expect(result.drifting).toBe(false);
    expect(result.avgZScore).toBe(0);
  });

  it("detectDrift catches systematic degradation", () => {
    // Build baseline: scores around 0.90
    for (let i = 0; i < 20; i++) {
      store.update("model-A", "mmlu", "acc", 0.90 + (i % 5) * 0.002);
    }

    // Inject 5 degrading scores
    for (let i = 0; i < 5; i++) {
      store.update("model-A", "mmlu", "acc", 0.80 - i * 0.01);
    }

    const result = store.detectDrift("model-A", "mmlu", 5);
    expect(result.drifting).toBe(true);
    expect(result.metrics).toContain("acc");
  });

  it("detectDrift does not flag stable models", () => {
    for (let i = 0; i < 30; i++) {
      store.update("model-A", "mmlu", "acc", 0.90 + (i % 3) * 0.005);
    }

    const result = store.detectDrift("model-A", "mmlu", 5);
    expect(result.drifting).toBe(false);
  });

  // ── Summary ─────────────────────────────────────────────

  it("summary includes models and benchmarks", () => {
    store.update("claude-sonnet-4", "mmlu", "acc", 0.892);
    store.update("claude-sonnet-4", "gsm8k", "exact_match", 0.945);
    store.update("hermes-agent", "mmlu", "acc", 0.871);

    const summary = store.summary();
    expect(summary).toContain("claude-sonnet-4");
    expect(summary).toContain("hermes-agent");
    expect(summary).toContain("mmlu");
    expect(summary).toContain("gsm8k");
    expect(summary).toContain("3 entries");
  });

  // ── Clear ───────────────────────────────────────────────

  it("clear removes all fingerprints", () => {
    store.update("model-A", "mmlu", "acc", 0.85);
    store.update("model-B", "gsm8k", "exact_match", 0.90);
    expect(store.size).toBe(2);

    store.clear();
    expect(store.size).toBe(0);
    expect(store.getAll()).toHaveLength(0);
  });

  // ── Key format ──────────────────────────────────────────

  it("key format is model::benchmark::metric", () => {
    const key = HarnessFingerprintStore.key("model", "bench", "metric");
    expect(key).toBe("model::bench::metric");
  });
});

/**
 * Tests for per-model per-benchmark fingerprinting
 */
import { describe, it, expect } from "bun:test";
import {
  loadFingerprints,
  saveFingerprints,
  updateFingerprints,
  diagnose,
  scanForAnomalies,
  summarizeAnomalies,
  fingerprintKey,
  type BenchmarkFingerprint,
} from "../fingerprint";
import { parseEvalResults } from "../parser";

function makeFingerprint(
  override: Partial<BenchmarkFingerprint> = {},
): BenchmarkFingerprint {
  return {
    modelName: "test-model",
    benchmark: "mmlu",
    metric: "acc",
    mean: 0.89,
    std: 0.01,
    n: 10,
    _sum: 8.9,
    _sumSq: 7.921,
    lastUpdated: Date.now(),
    values: [0.88, 0.89, 0.90, 0.88, 0.89, 0.90, 0.89, 0.88, 0.90, 0.89],
    ...override,
  };
}

describe("fingerprintKey", () => {
  it("produces unique key format", () => {
    const key = fingerprintKey("model-A", "mmlu", "acc");
    expect(key).toBe("model-A::mmlu::acc");
  });

  it("different models = different keys", () => {
    expect(fingerprintKey("A", "mmlu", "acc")).not.toBe(
      fingerprintKey("B", "mmlu", "acc"),
    );
  });
});

describe("diagnose", () => {
  it("detects anomaly when >2σ", () => {
    const fp = makeFingerprint({ mean: 0.89, std: 0.01, n: 10 });
    const result = diagnose(fp, 0.84); // 5σ away
    expect(result.isAnomalous).toBe(true);
    expect(result.zScore).toBeGreaterThan(2);
  });

  it("does not flag anomaly when within 2σ", () => {
    const fp = makeFingerprint({ mean: 0.89, std: 0.01, n: 10 });
    const result = diagnose(fp, 0.895); // 0.5σ away
    expect(result.isAnomalous).toBe(false);
    expect(result.zScore).toBeLessThanOrEqual(2);
  });

  it("cold start (< 3 samples) never flags anomaly", () => {
    const fp = makeFingerprint({ mean: 0.89, std: 0.001, n: 2 });
    const result = diagnose(fp, 0.80); // very far, but cold start
    expect(result.isAnomalous).toBe(false);
  });

  it("confidence grows with sample count", () => {
    const fp3 = makeFingerprint({ n: 3 });
    const fp10 = makeFingerprint({ n: 10 });
    const d3 = diagnose(fp3, 0.89);
    const d10 = diagnose(fp10, 0.89);
    expect(d10.confidence).toBeGreaterThan(d3.confidence);
  });

  it("confidence caps at 0.95", () => {
    const fp = makeFingerprint({ n: 1000 });
    const result = diagnose(fp, 0.89);
    expect(result.confidence).toBeLessThanOrEqual(0.95);
  });

  it("returns predicted range", () => {
    const fp = makeFingerprint({ mean: 0.89, std: 0.01, n: 10 });
    const result = diagnose(fp, 0.89);
    expect(result.predictedRange[0]).toBeLessThan(result.predictedRange[1]);
    expect(result.predictedRange[0]).toBeCloseTo(0.87, 1);
    expect(result.predictedRange[1]).toBeCloseTo(0.91, 1);
  });

  it("handles zero std (all identical values) — anomaly if different", () => {
    const fp = makeFingerprint({ mean: 0.90, std: 0, n: 10, values: [0.90, 0.90, 0.90] });
    const sameResult = diagnose(fp, 0.90);
    expect(sameResult.isAnomalous).toBe(false);

    const differentResult = diagnose(fp, 0.80);
    expect(differentResult.isAnomalous).toBe(true);
  });
});

describe("loadFingerprints / saveFingerprints", () => {
  it("round-trips fingerprints", () => {
    const fp = makeFingerprint();
    const original = new Map<string, BenchmarkFingerprint>();
    original.set("test-model::mmlu::acc", fp);

    const saved = saveFingerprints(original);
    const loaded = loadFingerprints({ fingerprints: saved });

    expect(loaded.size).toBe(1);
    const restored = loaded.get("test-model::mmlu::acc")!;
    expect(restored.mean).toBe(fp.mean);
    expect(restored.std).toBe(fp.std);
    expect(restored.n).toBe(fp.n);
  });

  it("handles null state gracefully", () => {
    const loaded = loadFingerprints(null);
    expect(loaded.size).toBe(0);
  });

  it("skips fingerprints with no values", () => {
    const bad: Record<string, unknown> = {
      "model::bench::metric": { n: 0, values: [] },
    };
    const loaded = loadFingerprints({ fingerprints: bad });
    expect(loaded.size).toBe(0);
  });
});

describe("updateFingerprints", () => {
  it("creates new fingerprints for first-time models", () => {
    const json = JSON.stringify({
      results: { mmlu: { "acc,none": 0.85 } },
      model_name: "new-model",
    });
    const run = parseEvalResults(json, "test.json");

    const updated = updateFingerprints(new Map(), run);
    expect(updated.size).toBe(1);

    const fp = updated.get("new-model::mmlu::acc")!;
    expect(fp.mean).toBe(0.85);
    expect(fp.n).toBe(1);
    expect(fp.std).toBe(0);
  });

  it("updates existing fingerprints", () => {
    const json = JSON.stringify({
      results: { mmlu: { "acc,none": 0.91 } },
      model_name: "test-model",
    });
    const run = parseEvalResults(json, "test.json");

    const existing = new Map();
    existing.set("test-model::mmlu::acc", makeFingerprint({ n: 10 }));

    const updated = updateFingerprints(existing, run);
    const fp = updated.get("test-model::mmlu::acc")!;
    expect(fp.n).toBe(11);
    expect(fp.values).toContain(0.91);
  });

  it("handles multiple tasks and metrics", () => {
    const json = JSON.stringify({
      results: {
        mmlu: { "acc,none": 0.85, "acc_norm,none": 0.87 },
        gsm8k: { "exact_match,strict-match": 0.92 },
      },
      model_name: "multi-model",
    });
    const run = parseEvalResults(json, "test.json");

    const updated = updateFingerprints(new Map(), run);
    expect(updated.size).toBe(3); // acc, acc_norm, exact_match
  });
});

describe("scanForAnomalies", () => {
  it("returns empty when no fingerprints exist", () => {
    const json = JSON.stringify({
      results: { mmlu: { "acc,none": 0.85 } },
      model_name: "unknown-model",
    });
    const run = parseEvalResults(json, "test.json");
    const diagnoses = scanForAnomalies(new Map(), run);
    expect(diagnoses).toHaveLength(0);
  });

  it("flags anomalous scores", () => {
    const fps = new Map();
    const fp = makeFingerprint({ mean: 0.90, std: 0.005, n: 20 });
    fps.set("test-model::mmlu::acc", fp);

    const json = JSON.stringify({
      results: { mmlu: { "acc,none": 0.70 } },
      model_name: "test-model",
    });
    const run = parseEvalResults(json, "test.json");

    const diagnoses = scanForAnomalies(fps, run);
    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0].isAnomalous).toBe(true);
    expect(diagnoses[0].zScore).toBeGreaterThan(5);
  });

  it("does not flag normal scores", () => {
    const fps = new Map();
    const fp = makeFingerprint({ mean: 0.90, std: 0.01, n: 20 });
    fps.set("test-model::mmlu::acc", fp);

    const json = JSON.stringify({
      results: { mmlu: { "acc,none": 0.905 } },
      model_name: "test-model",
    });
    const run = parseEvalResults(json, "test.json");

    const diagnoses = scanForAnomalies(fps, run);
    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0].isAnomalous).toBe(false);
  });
});

describe("summarizeAnomalies", () => {
  it("returns 'No anomalies' when empty", () => {
    const result = summarizeAnomalies([]);
    expect(result).toContain("No anomalies");
  });

  it("shows anomaly details", () => {
    const fp = makeFingerprint({ mean: 0.90, std: 0.01, n: 10 });
    const diag = diagnose(fp, 0.85);
    const result = summarizeAnomalies([diag]);
    expect(result).toContain("test-model");
    expect(result).toContain("mmlu");
    expect(result).toContain("acc");
  });
});

describe("values cap", () => {
  it("caps values array at 100 entries", () => {
    const json = JSON.stringify({
      results: { mmlu: { "acc,none": 0.89 } },
      model_name: "cap-test",
    });
    const run = parseEvalResults(json, "test.json");

    let fps = new Map<string, BenchmarkFingerprint>();
    for (let i = 0; i < 150; i++) {
      fps = updateFingerprints(
        fps,
        parseEvalResults(
          JSON.stringify({
            results: { mmlu: { "acc,none": 0.89 + (i % 5) * 0.001 } },
            model_name: "cap-test",
          }),
          "test.json",
        ),
      );
    }

    const fp = fps.get("cap-test::mmlu::acc")!;
    expect(fp.values.length).toBeLessThanOrEqual(100);
    expect(fp.n).toBeLessThanOrEqual(100);
  });
});

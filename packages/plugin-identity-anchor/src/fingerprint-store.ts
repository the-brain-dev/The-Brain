/**
 * HarnessFingerprintStore — persistent store for per-model per-benchmark
 * performance fingerprints. Used by the identity anchor to provide
 * regression predictions to meta-harnesses (AHE, Meta-Harness).
 *
 * Stores fingerprints as JSON at ~/.the-brain/identity/harness-fingerprints.json
 * Uses Welford's online algorithm for running statistics.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  BenchmarkFingerprintData,
  RegressionPrediction,
  SurpriseAssessment,
} from "@the-brain/core";

const ANOMALY_THRESHOLD = 2.0; // σ
const COLD_START_MIN_SAMPLES = 3;
const CONFIDENCE_CAP = 0.95;

// ── Store ──────────────────────────────────────────────────────

export class HarnessFingerprintStore {
  private fingerprints: Map<string, BenchmarkFingerprintData>;
  private storePath: string;
  private dirty = false;

  constructor(storePath?: string) {
    this.storePath =
      storePath ||
      join(
        process.env.HOME || homedir(),
        ".the-brain",
        "identity",
        "harness-fingerprints.json",
      );
    this.fingerprints = this.load();
  }

  // ── Persistence ────────────────────────────────────────────

  private load(): Map<string, BenchmarkFingerprintData> {
    try {
      if (existsSync(this.storePath)) {
        const raw = readFileSync(this.storePath, "utf-8");
        const data = JSON.parse(raw) as Record<string, BenchmarkFingerprintData>;
        const map = new Map<string, BenchmarkFingerprintData>();
        for (const [key, fp] of Object.entries(data)) {
          if (fp.n > 0 && fp.values?.length > 0) {
            map.set(key, fp);
          }
        }
        return map;
      }
    } catch {
      // Corrupted — start fresh
    }
    return new Map();
  }

  save(): void {
    const dir = join(this.storePath, "..");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const obj: Record<string, BenchmarkFingerprintData> = {};
    for (const [key, fp] of this.fingerprints) {
      obj[key] = fp;
    }
    writeFileSync(this.storePath, JSON.stringify(obj, null, 2), "utf-8");
    this.dirty = false;
  }

  private markDirty(): void {
    this.dirty = true;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  // ── Key format ─────────────────────────────────────────────

  static key(model: string, benchmark: string, metric: string): string {
    return `${model}::${benchmark}::${metric}`;
  }

  // ── CRUD ───────────────────────────────────────────────────

  get(model: string, benchmark: string, metric: string): BenchmarkFingerprintData | undefined {
    return this.fingerprints.get(HarnessFingerprintStore.key(model, benchmark, metric));
  }

  /** Returns all fingerprints for a given model */
  getByModel(model: string): BenchmarkFingerprintData[] {
    const results: BenchmarkFingerprintData[] = [];
    for (const [key, fp] of this.fingerprints) {
      if (fp.modelName === model) results.push(fp);
    }
    return results;
  }

  /** Returns all fingerprints for a given benchmark */
  getByBenchmark(benchmark: string): BenchmarkFingerprintData[] {
    const results: BenchmarkFingerprintData[] = [];
    for (const [key, fp] of this.fingerprints) {
      if (fp.benchmark === benchmark) results.push(fp);
    }
    return results;
  }

  getAll(): BenchmarkFingerprintData[] {
    return Array.from(this.fingerprints.values());
  }

  get size(): number {
    return this.fingerprints.size;
  }

  // ── Update ─────────────────────────────────────────────────

  /**
   * Update or create a fingerprint with a new observation.
   * Returns the updated fingerprint.
   */
  update(model: string, benchmark: string, metric: string, value: number): BenchmarkFingerprintData {
    const key = HarnessFingerprintStore.key(model, benchmark, metric);
    const existing = this.fingerprints.get(key);

    if (existing) {
      return this.updateExisting(existing, value);
    } else {
      return this.createNew(model, benchmark, metric, value);
    }
  }

  /**
   * Batch update from a record of { "model::benchmark::metric": value }.
   */
  batchUpdate(observations: Record<string, number>): void {
    for (const [key, value] of Object.entries(observations)) {
      const parts = key.split("::");
      if (parts.length !== 3) continue;
      this.update(parts[0], parts[1], parts[2], value);
    }
  }

  private createNew(
    model: string,
    benchmark: string,
    metric: string,
    value: number,
  ): BenchmarkFingerprintData {
    const fp: BenchmarkFingerprintData = {
      modelName: model,
      benchmark,
      metric,
      mean: value,
      std: 0,
      n: 1,
      lastUpdated: Date.now(),
      values: [value],
    };
    const key = HarnessFingerprintStore.key(model, benchmark, metric);
    this.fingerprints.set(key, fp);
    this.markDirty();
    return fp;
  }

  private updateExisting(
    fp: BenchmarkFingerprintData,
    value: number,
  ): BenchmarkFingerprintData {
    fp.values.push(value);

    // Cap at 100 values to avoid unbounded growth
    if (fp.values.length > 100) {
      fp.values = fp.values.slice(-100);
    }

    // Recompute stats from values array
    fp.n = fp.values.length;
    fp.mean = fp.values.reduce((a, b) => a + b, 0) / fp.n;

    if (fp.n > 1) {
      const sumSqDiff = fp.values.reduce((sum, v) => sum + (v - fp.mean) ** 2, 0);
      fp.std = Math.sqrt(sumSqDiff / (fp.n - 1));
    } else {
      fp.std = 0;
    }

    fp.lastUpdated = Date.now();
    this.markDirty();
    return fp;
  }

  // ── Prediction ─────────────────────────────────────────────

  /**
   * Predict expected score range for a model on a benchmark.
   * Returns null if no baseline exists (true cold start).
   */
  predict(model: string, benchmark: string, metric: string): RegressionPrediction | null {
    const fp = this.fingerprints.get(
      HarnessFingerprintStore.key(model, benchmark, metric),
    );
    if (!fp) return null;

    const confidence = Math.min(CONFIDENCE_CAP, fp.n / (fp.n + 5));
    const margin = ANOMALY_THRESHOLD * Math.max(fp.std, 0.001);

    return {
      modelName: fp.modelName,
      benchmark: fp.benchmark,
      metric: fp.metric,
      predictedRange: [fp.mean - margin, fp.mean + margin],
      confidence,
      isColdStart: fp.n < COLD_START_MIN_SAMPLES,
      baselineStd: fp.std,
    };
  }

  /**
   * Predict scores for ALL metrics of a model+benchmark pair.
   */
  predictAll(model: string, benchmark: string): RegressionPrediction[] {
    const results: RegressionPrediction[] = [];
    for (const [key, fp] of this.fingerprints) {
      if (fp.modelName === model && fp.benchmark === benchmark) {
        const p = this.predict(model, benchmark, fp.metric);
        if (p) results.push(p);
      }
    }
    return results;
  }

  // ── Surprise Assessment ────────────────────────────────────

  /**
   * Compare an observed score against the prediction.
   * Returns a SurpriseAssessment for SPM curator integration.
   */
  assess(
    model: string,
    benchmark: string,
    metric: string,
    observed: number,
  ): SurpriseAssessment | null {
    const prediction = this.predict(model, benchmark, metric);
    if (!prediction) return null;

    const fp = this.get(model, benchmark, metric)!;
    const zScore =
      fp.std > 0 ? Math.abs(observed - fp.mean) / fp.std : observed !== fp.mean ? ANOMALY_THRESHOLD + 1 : 0;

    const isAnomalous = zScore > ANOMALY_THRESHOLD && !prediction.isColdStart;

    // Surprise score: normalized 0-1 based on z-score
    // z=0 → surprise=0, z=3+ → surprise=1
    const surpriseScore = Math.min(1, zScore / (ANOMALY_THRESHOLD * 1.5));

    return {
      prediction,
      observed,
      zScore,
      isAnomalous,
      surpriseScore,
    };
  }

  /**
   * Assess ALL metrics for a model+benchmark pair against observed scores.
   * observed: { "metric_name": value }
   */
  assessAll(
    model: string,
    benchmark: string,
    observed: Record<string, number>,
  ): SurpriseAssessment[] {
    const results: SurpriseAssessment[] = [];
    for (const [metric, value] of Object.entries(observed)) {
      const assessment = this.assess(model, benchmark, metric, value);
      if (assessment) results.push(assessment);
    }
    return results;
  }

  // ── Drift Detection ────────────────────────────────────────

  /**
   * Detect if a model's performance is systematically drifting across
   * benchmarks (independent of specific harness edits).
   *
   * Computes the average z-score of the last K observations against
   * the fingerprint baseline. If > threshold, model may be degrading.
   */
  detectDrift(
    model: string,
    benchmark: string,
    windowSize = 5,
  ): { drifting: boolean; avgZScore: number; metrics: string[] } {
    const fingerprints = this.getByModel(model).filter(
      (fp) => fp.benchmark === benchmark,
    );
    if (fingerprints.length === 0) {
      return { drifting: false, avgZScore: 0, metrics: [] };
    }

    let totalZ = 0;
    const driftingMetrics: string[] = [];

    for (const fp of fingerprints) {
      if (fp.values.length < windowSize + 1) continue;

      // Check last K values against baseline (excluding them)
      const allButLast = fp.values.slice(0, -windowSize);
      const lastK = fp.values.slice(-windowSize);

      const baselineMean =
        allButLast.reduce((a, b) => a + b, 0) / allButLast.length;
      const baselineStd =
        allButLast.length > 1
          ? Math.sqrt(
              allButLast.reduce((sum, v) => sum + (v - baselineMean) ** 2, 0) /
                (allButLast.length - 1),
            )
          : 0;

      for (const v of lastK) {
        const z = baselineStd > 0 ? Math.abs(v - baselineMean) / baselineStd : 0;
        totalZ += z;
      }

      const avgMetricZ = totalZ / lastK.length;
      if (avgMetricZ > 1.5) {
        driftingMetrics.push(fp.metric);
      }
    }

    const avgZScore =
      fingerprints.length > 0 ? totalZ / (fingerprints.length * windowSize) : 0;

    return {
      drifting: driftingMetrics.length > 0,
      avgZScore,
      metrics: driftingMetrics,
    };
  }

  // ── Summary ────────────────────────────────────────────────

  /**
   * Human-readable summary of the store state.
   */
  summary(): string {
    const models = new Set<string>();
    const benchmarks = new Set<string>();
    for (const fp of this.fingerprints.values()) {
      models.add(fp.modelName);
      benchmarks.add(fp.benchmark);
    }

    return [
      `Fingerprints: ${this.fingerprints.size} entries`,
      `Models: ${models.size} (${[...models].join(", ")})`,
      `Benchmarks: ${benchmarks.size} (${[...benchmarks].join(", ")})`,
    ].join("\n");
  }

  // ── Reset ──────────────────────────────────────────────────

  clear(): void {
    this.fingerprints.clear();
    this.markDirty();
  }
}

/**
 * Per-model per-benchmark fingerprinting for regression detection.
 *
 * Tracks running statistics (mean, std) for each model+benchmark+metric
 * combination. Enables drift detection, predictive intervals, and
 * anomaly scoring without requiring cross-cycle access to all raw data.
 */

import type { BenchmarkScore, ParsedEvalRun } from "./parser";

/** Fingerprint for a single model+benchmark+metric combination */
export interface BenchmarkFingerprint {
  modelName: string;
  benchmark: string;
  metric: string;
  /** Running mean */
  mean: number;
  /** Running standard deviation */
  std: number;
  /** Number of samples */
  n: number;
  /** Running sum (for Welford) */
  _sum: number;
  /** Running sum of squares (for Welford) */
  _sumSq: number;
  /** Last update timestamp */
  lastUpdated: number;
  /** All observed values (for recomputing on serialization) */
  values: number[];
}

/** Result of comparing a new score against the fingerprint */
export interface FingerprintDiagnosis {
  fingerprint: BenchmarkFingerprint;
  /** The actual score observed */
  observed: number;
  /** How many standard deviations from the mean */
  zScore: number;
  /** Is this anomalous? (>2σ) */
  isAnomalous: boolean;
  /** Predicted range (±2σ) */
  predictedRange: [number, number];
  /** Confidence in the prediction (increases with sample count) */
  confidence: number;
}

const ANOMALY_THRESHOLD = 2.0; // σ
const COLD_START_MIN_SAMPLES = 3; // minimum samples before confident predictions

/**
 * Create a new fingerprint with the first observation.
 */
function createFingerprint(
  modelName: string,
  benchmark: string,
  metric: string,
  value: number,
): BenchmarkFingerprint {
  return {
    modelName,
    benchmark,
    metric,
    mean: value,
    std: 0,
    n: 1,
    _sum: value,
    _sumSq: value * value,
    lastUpdated: Date.now(),
    values: [value],
  };
}

/**
 * Update a fingerprint with a new observation using Welford's online algorithm.
 */
function updateFingerprint(
  fp: BenchmarkFingerprint,
  value: number,
): BenchmarkFingerprint {
  fp.values.push(value);

  // Keep max 100 values to avoid unbounded growth
  if (fp.values.length > 100) {
    fp.values = fp.values.slice(-100);
  }

  fp.n = fp.values.length;
  fp._sum = fp.values.reduce((a, b) => a + b, 0);
  fp._sumSq = fp.values.reduce((a, b) => a + b * b, 0);
  fp.mean = fp._sum / fp.n;
  const variance = fp.n > 1
    ? (fp._sumSq - (fp._sum * fp._sum) / fp.n) / (fp.n - 1)
    : 0;
  fp.std = Math.sqrt(Math.max(0, variance));
  fp.lastUpdated = Date.now();

  return fp;
}

/**
 * Load fingerprints from persistent state.
 */
export function loadFingerprints(
  state: Record<string, unknown> | null,
): Map<string, BenchmarkFingerprint> {
  const fps = new Map<string, BenchmarkFingerprint>();
  if (!state?.fingerprints) return fps;

  const raw = state.fingerprints as Record<string, BenchmarkFingerprint>;
  for (const [key, fp] of Object.entries(raw)) {
    if (fp.n > 0 && fp.values?.length > 0) {
      fps.set(key, fp);
    }
  }

  return fps;
}

/**
 * Save fingerprints to persistent state.
 */
export function saveFingerprints(
  fps: Map<string, BenchmarkFingerprint>,
): Record<string, BenchmarkFingerprint> {
  const obj: Record<string, BenchmarkFingerprint> = {};
  for (const [key, fp] of fps) {
    obj[key] = fp;
  }
  return obj;
}

/**
 * Build a unique key for a model+benchmark+metric combination.
 */
export function fingerprintKey(
  model: string,
  benchmark: string,
  metric: string,
): string {
  return `${model}::${benchmark}::${metric}`;
}

/**
 * Update fingerprints from a parsed eval run.
 */
export function updateFingerprints(
  fingerprints: Map<string, BenchmarkFingerprint>,
  run: ParsedEvalRun,
): Map<string, BenchmarkFingerprint> {
  const updated = new Map(fingerprints);

  for (const task of run.tasks) {
    for (const score of task.scores) {
      const key = fingerprintKey(run.model, task.task, score.metric);

      const existing = updated.get(key);
      if (existing) {
        updated.set(key, updateFingerprint(existing, score.value));
      } else {
        updated.set(key, createFingerprint(run.model, task.task, score.metric, score.value));
      }
    }
  }

  return updated;
}

/**
 * Diagnose whether a new score is anomalous compared to the fingerprint.
 */
export function diagnose(
  fingerprint: BenchmarkFingerprint,
  observed: number,
): FingerprintDiagnosis {
  const zScore = fingerprint.std > 0
    ? Math.abs(observed - fingerprint.mean) / fingerprint.std
    : observed !== fingerprint.mean ? ANOMALY_THRESHOLD + 1 : 0;

  const isAnomalous = zScore > ANOMALY_THRESHOLD && fingerprint.n >= COLD_START_MIN_SAMPLES;
  const predictedRange: [number, number] = [
    fingerprint.mean - ANOMALY_THRESHOLD * Math.max(fingerprint.std, 0.001),
    fingerprint.mean + ANOMALY_THRESHOLD * Math.max(fingerprint.std, 0.001),
  ];

  // Confidence grows with sample count, caps at 0.95
  const confidence = Math.min(0.95, fingerprint.n / (fingerprint.n + 5));

  return {
    fingerprint,
    observed,
    zScore,
    isAnomalous,
    predictedRange,
    confidence,
  };
}

/**
 * Scan a parsed eval run against all fingerprints and return anomalies.
 */
export function scanForAnomalies(
  fingerprints: Map<string, BenchmarkFingerprint>,
  run: ParsedEvalRun,
): FingerprintDiagnosis[] {
  const diagnoses: FingerprintDiagnosis[] = [];

  for (const task of run.tasks) {
    for (const score of task.scores) {
      const key = fingerprintKey(run.model, task.task, score.metric);
      const fp = fingerprints.get(key);
      if (!fp) continue; // no baseline yet

      const d = diagnose(fp, score.value);
      diagnoses.push(d);
    }
  }

  return diagnoses;
}

/**
 * Summarize anomalies for human review.
 */
export function summarizeAnomalies(diagnoses: FingerprintDiagnosis[]): string {
  if (diagnoses.length === 0) return "No anomalies detected.";

  const anomalous = diagnoses.filter((d) => d.isAnomalous);
  if (anomalous.length === 0) {
    return `All ${diagnoses.length} metrics within expected range.`;
  }

  const lines = [`${anomalous.length}/${diagnoses.length} metrics anomalous:`];
  for (const d of anomalous) {
    lines.push(
      `  ${d.fingerprint.modelName}/${d.fingerprint.benchmark}/${d.fingerprint.metric}` +
      `: observed=${d.observed.toFixed(4)}, expected=${d.fingerprint.mean.toFixed(4)}` +
      `±${(d.fingerprint.std * 2).toFixed(4)}, z=${d.zScore.toFixed(2)}, conf=${d.confidence.toFixed(2)}`,
    );
  }
  return lines.join("\n");
}

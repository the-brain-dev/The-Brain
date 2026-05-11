/**
 * Parser for lm-evaluation-harness JSON results files.
 *
 * Expected input format (from lm-eval --output_path results.json):
 * ```json
 * {
 *   "results": {
 *     "mmlu": {
 *       "acc,none": 0.892,
 *       "acc_stderr,none": 0.012,
 *       "acc_norm,none": 0.901,
 *       "acc_norm_stderr,none": 0.011
 *     },
 *     "gsm8k": {
 *       "exact_match,strict-match": 0.945,
 *       "exact_match_stderr,strict-match": 0.008
 *     }
 *   },
 *   "config": {
 *     "model": "hf-causal",
 *     "model_args": "pretrained=meta-llama/Llama-3.1-8B-Instruct",
 *     "batch_size": 8,
 *     "num_fewshot": 5
 *   },
 *   "task_hashes": { "mmlu": "abc123", "gsm8k": "def456" },
 *   "total_evaluation_time_seconds": 245.67,
 *   "model_name": "Llama-3.1-8B-Instruct",
 *   "model_name_sanitized": "Llama-3_1-8B-Instruct"
 * }
 * ```
 */

export interface BenchmarkScore {
  /** Normalized metric name (e.g., "acc", "exact_match") */
  metric: string;
  /** The score value */
  value: number;
  /** Standard error (stderr), if available */
  stderr?: number;
}

export interface ParsedTaskResult {
  /** Task/benchmark name (e.g., "mmlu", "gsm8k") */
  task: string;
  /** All scores for this task */
  scores: BenchmarkScore[];
  /** Task content hash from lm-eval (for deduplication) */
  taskHash?: string;
}

export interface ParsedEvalRun {
  /** File this was parsed from */
  sourceFile: string;
  /** Model name (sanitized from config) */
  model: string;
  /** Raw model name from config */
  rawModelName?: string;
  /** All task results */
  tasks: ParsedTaskResult[];
  /** Total evaluation time in seconds */
  totalTime?: number;
  /** Number of few-shot examples */
  numFewshot?: number;
  /** Batch size used */
  batchSize?: number;
  /** Unix timestamp of when this was parsed */
  parsedAt: number;
  /** Unique run hash (model + task hashes) */
  runHash: string;
}

/**
 * Extracts the model name from lm-eval config.model_args.
 * Handles various formats: "pretrained=X", "model=X", "peft=X", "path=X"
 */
export function extractModelName(config: Record<string, unknown>): string {
  const modelName = config.model_name as string | undefined;
  if (modelName) return modelName;

  const modelArgs = config.model_args;
  if (typeof modelArgs === "string") {
    const prefixes = ["pretrained", "delta", "peft", "model", "path", "engine"];
    for (const prefix of prefixes) {
      const match = modelArgs.match(new RegExp(`${prefix}=([^,]+)`));
      if (match) return match[1];
    }
    return modelArgs;
  }

  if (typeof modelArgs === "object" && modelArgs !== null) {
    const args = modelArgs as Record<string, unknown>;
    const prefixes = ["pretrained", "delta", "peft", "model", "path", "engine"];
    for (const prefix of prefixes) {
      if (args[prefix]) return String(args[prefix]);
    }
  }

  return "unknown";
}

/**
 * Parses a single metric key from lm-eval results.
 * Format: "metric_name,filter_name" or just "metric_name"
 * Examples: "acc,none" → "acc", "exact_match,strict-match" → "exact_match"
 */
export function parseMetricKey(key: string): { metric: string; filter: string } {
  const commaIndex = key.indexOf(",");
  if (commaIndex === -1) {
    return { metric: key, filter: "none" };
  }
  return {
    metric: key.slice(0, commaIndex),
    filter: key.slice(commaIndex + 1),
  };
}

/**
 * Distinguishes score keys from stderr keys.
 * Score: "acc,none" → 0.892
 * Stderr: "acc_stderr,none" → 0.012
 */
function isStderrKey(key: string): boolean {
  return key.includes("_stderr,") || key.endsWith("_stderr");
}

/**
 * Gets the base metric key from a stderr key.
 * "acc_stderr,none" → "acc,none"
 */
function baseKeyFromStderr(stderrKey: string): string {
  return stderrKey.replace("_stderr,", ",");
}

/**
 * Parses a single task's results object.
 */
function parseTaskResults(
  taskName: string,
  taskResults: Record<string, unknown>,
): ParsedTaskResult {
  const scores: BenchmarkScore[] = [];
  const stderrValues: Record<string, number> = {};

  // First pass: collect stderr values
  for (const [key, value] of Object.entries(taskResults)) {
    if (isStderrKey(key) && typeof value === "number") {
      const baseKey = baseKeyFromStderr(key);
      stderrValues[baseKey] = value;
    }
  }

  // Second pass: collect scores, pairing with stderr
  for (const [key, value] of Object.entries(taskResults)) {
    if (isStderrKey(key)) continue; // skip stderr keys
    if (typeof value !== "number") continue;

    const { metric } = parseMetricKey(key);

    // Avoid duplicate primary metrics (prefer the first one)
    const existing = scores.find((s) => s.metric === metric);
    if (existing) continue;

    scores.push({
      metric,
      value,
      stderr: stderrValues[key],
    });
  }

  return { task: taskName, scores };
}

/**
 * Computes a deterministic hash for a run to enable deduplication.
 * Uses model name + task hashes.
 */
function computeRunHash(model: string, taskHashes?: Record<string, string>): string {
  let input = model;
  if (taskHashes) {
    const sorted = Object.entries(taskHashes)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([task, hash]) => `${task}:${hash}`)
      .join(";");
    input += "|" + sorted;
  }

  // Simple FNV-1a hash
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Parses a full lm-eval results JSON file.
 */
export function parseEvalResults(raw: string, sourceFile: string): ParsedEvalRun {
  const data = JSON.parse(raw);

  const config = (data.config || {}) as Record<string, unknown>;
  const results = (data.results || {}) as Record<string, Record<string, unknown>>;
  const taskHashes = (data.task_hashes || {}) as Record<string, string>;

  const model = data.model_name
    ? String(data.model_name)
    : extractModelName(config);

  const tasks: ParsedTaskResult[] = [];
  for (const [taskName, taskResults] of Object.entries(results)) {
    tasks.push(parseTaskResults(taskName, taskResults));
  }

  // Add task hashes
  for (const task of tasks) {
    task.taskHash = taskHashes[task.task];
  }

  return {
    sourceFile,
    model,
    rawModelName: config.model_name as string | undefined,
    tasks,
    totalTime: data.total_evaluation_time_seconds as number | undefined,
    numFewshot: config.num_fewshot as number | undefined,
    batchSize: config.batch_size as number | undefined,
    parsedAt: Date.now(),
    runHash: computeRunHash(model, taskHashes),
  };
}

/**
 * Returns a human-readable summary of the parsed run.
 */
export function summarizeRun(run: ParsedEvalRun): string {
  const lines = [`Model: ${run.model}`];
  for (const task of run.tasks) {
    const scoreStr = task.scores
      .map((s) => `${s.metric}=${s.value.toFixed(4)}${s.stderr ? `±${s.stderr.toFixed(4)}` : ""}`)
      .join(", ");
    lines.push(`  ${task.task}: ${scoreStr}`);
  }
  return lines.join("\n");
}

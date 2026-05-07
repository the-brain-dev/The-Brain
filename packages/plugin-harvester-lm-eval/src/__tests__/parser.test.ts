/**
 * Tests for lm-eval result parser
 */
import { describe, it, expect } from "bun:test";
import {
  parseEvalResults,
  extractModelName,
  parseMetricKey,
  summarizeRun,
} from "../parser";

const SAMPLE_JSON = JSON.stringify({
  results: {
    mmlu: {
      "acc,none": 0.892,
      "acc_stderr,none": 0.012,
      "acc_norm,none": 0.901,
      "acc_norm_stderr,none": 0.011,
    },
    gsm8k: {
      "exact_match,strict-match": 0.945,
      "exact_match_stderr,strict-match": 0.008,
    },
  },
  config: {
    model: "hf-causal",
    model_args: "pretrained=meta-llama/Llama-3.1-8B-Instruct",
    batch_size: 8,
    num_fewshot: 5,
  },
  task_hashes: { mmlu: "abc123", gsm8k: "def456" },
  total_evaluation_time_seconds: 245.67,
  model_name: "Llama-3.1-8B-Instruct",
});

describe("parseEvalResults", () => {
  it("parses a complete lm-eval results JSON", () => {
    const run = parseEvalResults(SAMPLE_JSON, "/tmp/results.json");

    expect(run.model).toBe("Llama-3.1-8B-Instruct");
    expect(run.tasks).toHaveLength(2);
    expect(run.totalTime).toBe(245.67);
    expect(run.numFewshot).toBe(5);
    expect(run.batchSize).toBe(8);
    expect(run.runHash).toBeString();
    expect(run.sourceFile).toBe("/tmp/results.json");
  });

  it("extracts correct task scores", () => {
    const run = parseEvalResults(SAMPLE_JSON, "/tmp/results.json");

    const mmlu = run.tasks.find((t) => t.task === "mmlu")!;
    expect(mmlu).toBeDefined();
    expect(mmlu.scores).toHaveLength(2);

    const acc = mmlu.scores.find((s) => s.metric === "acc")!;
    expect(acc.value).toBe(0.892);
    expect(acc.stderr).toBe(0.012);

    const accNorm = mmlu.scores.find((s) => s.metric === "acc_norm")!;
    expect(accNorm.value).toBe(0.901);
    expect(accNorm.stderr).toBe(0.011);

    const gsm8k = run.tasks.find((t) => t.task === "gsm8k")!;
    expect(gsm8k.scores).toHaveLength(1);
    expect(gsm8k.scores[0].metric).toBe("exact_match");
    expect(gsm8k.scores[0].value).toBe(0.945);
    expect(gsm8k.scores[0].stderr).toBe(0.008);
  });

  it("assigns task hashes", () => {
    const run = parseEvalResults(SAMPLE_JSON, "/tmp/results.json");
    const mmlu = run.tasks.find((t) => t.task === "mmlu")!;
    const gsm8k = run.tasks.find((t) => t.task === "gsm8k")!;
    expect(mmlu.taskHash).toBe("abc123");
    expect(gsm8k.taskHash).toBe("def456");
  });

  it("handles missing model_name by extracting from model_args", () => {
    const json = JSON.stringify({
      results: { mmlu: { "acc,none": 0.5 } },
      config: { model_args: "pretrained=some-model" },
    });
    const run = parseEvalResults(json, "test.json");
    expect(run.model).toBe("some-model");
  });

  it("prioritizes model_name over model_args extraction", () => {
    const json = JSON.stringify({
      results: { mmlu: { "acc,none": 0.5 } },
      config: { model_args: "pretrained=fallback-model" },
      model_name: "preferred-model",
    });
    const run = parseEvalResults(json, "test.json");
    expect(run.model).toBe("preferred-model");
  });

  it("handles empty results object", () => {
    const json = JSON.stringify({
      results: {},
      model_name: "test-model",
    });
    const run = parseEvalResults(json, "test.json");
    expect(run.tasks).toHaveLength(0);
    expect(run.model).toBe("test-model");
  });

  it("produces deterministic run hashes", () => {
    const run1 = parseEvalResults(SAMPLE_JSON, "/tmp/a.json");
    const run2 = parseEvalResults(SAMPLE_JSON, "/tmp/b.json");
    expect(run1.runHash).toBe(run2.runHash);
  });

  it("produces different run hashes for different models", () => {
    const json1 = JSON.stringify({
      results: { mmlu: { "acc,none": 0.5 } },
      model_name: "model-A",
    });
    const json2 = JSON.stringify({
      results: { mmlu: { "acc,none": 0.5 } },
      model_name: "model-B",
    });
    const run1 = parseEvalResults(json1, "a.json");
    const run2 = parseEvalResults(json2, "b.json");
    expect(run1.runHash).not.toBe(run2.runHash);
  });

  it("handles metrics without stderr", () => {
    const json = JSON.stringify({
      results: { mmlu: { "acc,none": 0.75 } },
      model_name: "test",
    });
    const run = parseEvalResults(json, "test.json");
    const acc = run.tasks[0].scores[0];
    expect(acc.value).toBe(0.75);
    expect(acc.stderr).toBeUndefined();
  });
});

describe("extractModelName", () => {
  it("extracts pretrained from string model_args", () => {
    expect(
      extractModelName({ model_args: "pretrained=meta-llama/Llama-3.1-8B" }),
    ).toBe("meta-llama/Llama-3.1-8B");
  });

  it("extracts model from string model_args", () => {
    expect(
      extractModelName({ model_args: "model=openai/gpt-4" }),
    ).toBe("openai/gpt-4");
  });

  it("extracts from dict model_args", () => {
    expect(
      extractModelName({
        model_args: { pretrained: "meta-llama/Llama-3.1-8B" },
      }),
    ).toBe("meta-llama/Llama-3.1-8B");
  });

  it("falls back to unknown", () => {
    expect(extractModelName({})).toBe("unknown");
  });

  it("uses model_name field if available", () => {
    expect(
      extractModelName({
        model_name: "direct-name",
        model_args: "pretrained=ignored",
      }),
    ).toBe("direct-name");
  });
});

describe("parseMetricKey", () => {
  it("parses acc,none", () => {
    const { metric, filter } = parseMetricKey("acc,none");
    expect(metric).toBe("acc");
    expect(filter).toBe("none");
  });

  it("parses exact_match,strict-match", () => {
    const { metric, filter } = parseMetricKey("exact_match,strict-match");
    expect(metric).toBe("exact_match");
    expect(filter).toBe("strict-match");
  });

  it("handles no filter part", () => {
    const { metric, filter } = parseMetricKey("accuracy");
    expect(metric).toBe("accuracy");
    expect(filter).toBe("none");
  });

  it("handles multiple commas (only splits on first)", () => {
    const { metric, filter } = parseMetricKey("f1,macro,weighted");
    expect(metric).toBe("f1");
    expect(filter).toBe("macro,weighted");
  });
});

describe("summarizeRun", () => {
  it("produces string with model name and task scores", () => {
    const run = parseEvalResults(SAMPLE_JSON, "/tmp/test.json");
    const summary = summarizeRun(run);
    expect(summary).toContain("Llama-3.1-8B-Instruct");
    expect(summary).toContain("mmlu");
    expect(summary).toContain("gsm8k");
    expect(summary).toContain("0.8920");
  });
});

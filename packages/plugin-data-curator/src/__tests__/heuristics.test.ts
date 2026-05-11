/**
 * Tests for data curator heuristics.
 *
 * Run: bun test packages/plugin-data-curator/src/__tests__/heuristics.test.ts
 */

import { describe, test, expect } from "bun:test";
import { evaluateHeuristics } from "../heuristics";

describe("evaluateHeuristics", () => {
  // ── System noise ──
  test("rejects context compaction", () => {
    const prompt = "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted...";
    const response = "Some response";
    const result = evaluateHeuristics(prompt, response);
    expect(result.passed).toBe(false);
    expect(result.rejectReason).toContain("context bracket");
    expect(result.scores.noSystemNoise).toBe(0);
  });

  test("rejects model switch notes", () => {
    const prompt = "[Note: model was just switched from deepseek-v4-flash to deepseek-v4-pro via DeepSeek. Adjust your self-identification accordingly.]";
    const response = "OK";
    const result = evaluateHeuristics(prompt, response);
    expect(result.passed).toBe(false);
    expect(result.rejectReason).toContain("system bracket");
  });

  test("rejects background process notifications", () => {
    const prompt = "[IMPORTANT: Background process proc_abc123 completed (exit code 0).]";
    const response = "";
    const result = evaluateHeuristics(prompt, response);
    expect(result.passed).toBe(false);
    expect(result.rejectReason).toContain("important bracket");
  });

  test("rejects empty tool call messages", () => {
    const prompt = "You just executed tool calls but returned an empty response. Please process the tool results above.";
    const response = "";
    const result = evaluateHeuristics(prompt, response);
    expect(result.passed).toBe(false);
    expect(result.rejectReason).toContain("tool loop message");
  });

  test("rejects max iterations messages", () => {
    const prompt = "You've reached the maximum number of tool-calling iterations allowed.";
    const response = "Summary...";
    const result = evaluateHeuristics(prompt, response);
    expect(result.passed).toBe(false);
    expect(result.rejectReason).toContain("tool loop message");
  });

  test("rejects cron response messages", () => {
    const prompt = "Cronjob Response: Daily digest...";
    const response = "Job completed";
    const result = evaluateHeuristics(prompt, response);
    expect(result.passed).toBe(false);
    expect(result.rejectReason).toContain("cron label");
  });

  test("rejects system prompt annotations", () => {
    const prompt = "[System note: language set to Polish]";
    const response = "Rozumiem";
    const result = evaluateHeuristics(prompt, response);
    expect(result.passed).toBe(false);
    expect(result.rejectReason).toContain("system bracket");
  });

  // ── Empty / near-empty ──
  test("rejects empty response", () => {
    const prompt = "What is 2+2?";
    const response = "";
    const result = evaluateHeuristics(prompt, response);
    expect(result.passed).toBe(false);
    expect(result.rejectReason).toContain("empty");
  });

  test("rejects whitespace-only response", () => {
    const prompt = "test";
    const response = "   \n  \t  ";
    const result = evaluateHeuristics(prompt, response);
    expect(result.passed).toBe(false);
  });

  test("rejects very short non-code response", () => {
    const prompt = "Do this task";
    const response = "Ok";
    const result = evaluateHeuristics(prompt, response);
    expect(result.passed).toBe(false);
    expect(result.rejectReason).toContain("too short");
  });

  test("detects emoji-only response", () => {
    const prompt = "How are you?";
    const response = "👋🙂💻";
    const result = evaluateHeuristics(prompt, response);
    expect(result.passed).toBe(false);
    expect(result.rejectReason).toContain("emoji");
  });

  test("detects emoji-garbage with mixed text", () => {
    const prompt = "What do you think?";
    const response = "👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍"; // pure emoji, no alphanumeric
    const result = evaluateHeuristics(prompt, response);
    expect(result.passed).toBe(false);
    expect(result.rejectReason).toContain("emoji");
  });

  test("rejects off-topic content via configurable patterns", () => {
    const prompt = "Find me a pizza place in Brooklyn";
    const response = "Searching...";
    const result = evaluateHeuristics(prompt, response, [/\b(pizza|Brooklyn)\b/i]);
    expect(result.passed).toBe(false);
    expect(result.rejectReason).toContain("off-topic");
  });

  // ── Valid interactions ──
  test("passes clean code interaction", () => {
    const prompt = "Write a function to calculate fibonacci";
    const response = "```python\ndef fib(n):\n    if n <= 1: return n\n    return fib(n-1) + fib(n-2)\n```";
    const result = evaluateHeuristics(prompt, response);
    expect(result.passed).toBe(true);
    expect(result.scores.contentQuality).toBe(0.75); // 0.5 + 1 code block * 0.25
  });

  test("passes long technical response", () => {
    const prompt = "Explain the architecture";
    const response = "The system uses a 3-layer cognitive architecture. Layer 1: Graph Memory for instant corrections. Layer 2: SPM Curator for surprise-gated filtering. Layer 3: MLX LoRA training for permanent consolidation. Each layer operates independently...";
    const result = evaluateHeuristics(prompt, response);
    expect(result.passed).toBe(true);
    expect(result.scores.contentQuality).toBeGreaterThanOrEqual(0.5);
  });

  test("passes balanced prompt-response pair", () => {
    const prompt = "Add error handling to this function";
    const response = "Here's the updated function with try-catch and proper error propagation. The key changes are...";
    const result = evaluateHeuristics(prompt, response);
    expect(result.passed).toBe(true);
    expect(result.scores.coherence).toBeGreaterThanOrEqual(0.6);
  });

  test("passes short response with code block", () => {
    const prompt = "Fix this bug";
    const response = "```js\nconst x = 1;\n```";
    const result = evaluateHeuristics(prompt, response);
    // Has code block — the <50 char rejection only applies when there's no ```
    expect(result.passed).toBe(true);
  });

  test("heuristic report includes all scores", () => {
    const prompt = "Write a function";
    const response = "Here is a function:\n```js\nfunction add(a,b) { return a+b; }\n```";
    const result = evaluateHeuristics(prompt, response);
    expect(result.scores).toHaveProperty("contentQuality");
    expect(result.scores).toHaveProperty("coherence");
    expect(result.scores).toHaveProperty("noSystemNoise");
    expect(result.scores.noSystemNoise).toBe(1); // Clean
    expect(result.scores.contentQuality).toBeGreaterThan(0);
  });
});

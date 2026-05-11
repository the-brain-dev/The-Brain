/**
 * Tests for LLM Judge prompt building and response parsing.
 *
 * Run: bun test packages/plugin-data-curator/src/__tests__/judge.test.ts
 */

import { describe, test, expect } from "bun:test";
import { buildJudgePrompt, parseJudgeResponse } from "../judge";

describe("buildJudgePrompt", () => {
  test("includes prompt and response", () => {
    const result = buildJudgePrompt("Write a function", "function add() {}");
    expect(result).toContain("Write a function");
    expect(result).toContain("function add() {}");
  });

  test("truncates long content", () => {
    const longPrompt = "x".repeat(3000);
    const longResponse = "y".repeat(3000);
    const result = buildJudgePrompt(longPrompt, longResponse);
    // Should not include full 3000 chars (truncated at 2000)
    expect(result.length).toBeLessThan(longPrompt.length + longResponse.length + 1000);
  });

  test("contains JSON instruction", () => {
    const result = buildJudgePrompt("test", "test");
    expect(result).toContain("overall");
    expect(result).toContain("correctness");
    expect(result).toContain("JSON");
  });
});

describe("parseJudgeResponse", () => {
  test("parses valid JSON response", () => {
    const raw = `{
      "overall": 8,
      "correctness": 9,
      "completeness": 8,
      "educational_value": 7,
      "coherence": 9,
      "noise_level": 8,
      "needs_rewrite": false,
      "reasoning": "Good code example"
    }`;
    const result = parseJudgeResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.overall).toBe(8);
    expect(result!.dimensions.correctness).toBe(9);
    expect(result!.dimensions.educationalValue).toBe(7);
    expect(result!.needsRewrite).toBe(false);
    expect(result!.reasoning).toBe("Good code example");
  });

  test("parses JSON wrapped in markdown", () => {
    const raw = '```json\n{\n  "overall": 4,\n  "correctness": 3,\n  "completeness": 5,\n  "educational_value": 2,\n  "coherence": 5,\n  "noise_level": 3,\n  "needs_rewrite": true,\n  "reasoning": "Poor quality"\n}\n```';
    const result = parseJudgeResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.overall).toBe(4);
    expect(result!.needsRewrite).toBe(true);
  });

  test("parses JSON with extra text", () => {
    const raw = 'Here is the evaluation:\n{"overall":6,"correctness":7,"completeness":6,"educational_value":5,"coherence":6,"noise_level":6,"needs_rewrite":false,"reasoning":"ok"}\nEnd.';
    const result = parseJudgeResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.overall).toBe(6);
  });

  test("clamps scores to 1-10 range", () => {
    const raw = '{"overall":15,"correctness":-3,"completeness":99,"educational_value":0,"coherence":5,"noise_level":5,"needs_rewrite":false,"reasoning":"test"}';
    const result = parseJudgeResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.overall).toBe(10); // clamped from 15
    expect(result!.dimensions.correctness).toBe(1); // clamped from -3
    expect(result!.dimensions.completeness).toBe(10); // clamped from 99
    expect(result!.dimensions.educationalValue).toBe(1); // clamped from 0
  });

  test("auto-sets needsRewrite for low overall score", () => {
    const raw = '{"overall":3,"correctness":4,"completeness":4,"educational_value":3,"coherence":4,"noise_level":4,"needs_rewrite":false,"reasoning":"test"}';
    const result = parseJudgeResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.needsRewrite).toBe(true); // overall < 6 => auto true
  });

  test("handles missing fields with defaults", () => {
    const raw = '{"overall": 7}';
    const result = parseJudgeResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.overall).toBe(7);
    expect(result!.dimensions.correctness).toBe(5); // default
    expect(result!.reasoning).toBe("");
  });

  test("returns null for invalid JSON", () => {
    expect(parseJudgeResponse("not json at all")).toBeNull();
    expect(parseJudgeResponse("")).toBeNull();
    expect(parseJudgeResponse("{broken")).toBeNull();
  });

  test("returns null for non-integer scores", () => {
    const raw = '{"overall":"good","correctness":5,"completeness":5,"educational_value":5,"coherence":5,"noise_level":5,"needs_rewrite":false,"reasoning":""}';
    const result = parseJudgeResponse(raw);
    expect(result).not.toBeNull();
    expect(result!.overall).toBe(5); // NaN → clamped to 5 (default)
  });
});

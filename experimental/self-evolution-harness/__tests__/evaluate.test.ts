/**
 * evaluate.test.ts — Tests for the self-evolution harness evaluator
 *
 * Tests: parseTestOutput, parseCoverageOutput, parseLintOutput, determineVerdict
 */

import { describe, test, expect } from "bun:test";
import {
  parseTestOutput,
  parseCoverageOutput,
  parseLintOutput,
  determineVerdict,
} from "../evaluate";

// ── parseTestOutput ────────────────────────────────────────────────────────────

describe("parseTestOutput", () => {
  test("parses standard bun test output", () => {
    const output = `
tests/foo.test.ts:
✓ should work > packages/foo

 200 pass
 0 fail
 15 tests
Ran 215 tests across 20 files. 0 fail. 0 timeout. [3.45s]
    `.trim();

    const result = parseTestOutput(output);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(200);
    expect(result!.passed).toBe(200);
    expect(result!.failed).toBe(0);
  });

  test("parses output with failures", () => {
    const output = `
 198 pass
 2 fail
 200 tests
Ran 200 tests across 20 files. [3.45s]
    `.trim();

    const result = parseTestOutput(output);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(200);
    expect(result!.passed).toBe(198);
    expect(result!.failed).toBe(2);
  });

  test("parses output with timeouts counted as failures", () => {
    const output = `
 197 pass
 1 fail
 1 timeout
 199 tests
Ran 199 tests across 20 files. [5.12s]
    `.trim();

    const result = parseTestOutput(output);
    expect(result).not.toBeNull();
    expect(result!.failed).toBe(2); // 1 fail + 1 timeout
  });

  test("returns null for unrecognized output", () => {
    const result = parseTestOutput("Some random text without test counts");
    expect(result).toBeNull();
  });

  test("handles pass-only output (no fail line)", () => {
    const output = "806 pass\nRan 806 tests across 56 files.";
    const result = parseTestOutput(output);
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(806);
    expect(result!.failed).toBe(0);
  });

  test("handles fail-only output (no pass line)", () => {
    const output = "3 fail\nRan 3 tests across 1 file.";
    const result = parseTestOutput(output);
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(0);
    expect(result!.failed).toBe(3);
  });
});

// ── parseCoverageOutput ────────────────────────────────────────────────────────

describe("parseCoverageOutput", () => {
  test("parses standard table format", () => {
    const output = `
File      | % Stmts | % Branch | % Funcs | % Lines
----------|---------|----------|---------|--------
All files |   86.32 |    78.91 |   92.14 |   86.32
    `.trim();

    expect(parseCoverageOutput(output)).toBe(86.32);
  });

  test("parses 'All files' singular variant", () => {
    const output = `
All file  |   100.00 |    95.00 |   100.00 |   100.00
    `.trim();

    expect(parseCoverageOutput(output)).toBe(100.0);
  });

  test("parses Statements percentage format", () => {
    const output = "Coverage summary: 45.67% Statements, 38.12% Branches";
    expect(parseCoverageOutput(output)).toBe(45.67);
  });

  test("returns null for unrecognized output", () => {
    expect(parseCoverageOutput("No coverage data here")).toBeNull();
    expect(parseCoverageOutput("")).toBeNull();
  });

  test("parses fallback pattern", () => {
    const output = "some text coverage is 92.50% overall";
    expect(parseCoverageOutput(output)).toBe(92.50);
  });

  test("standard table format takes precedence over fallback", () => {
    const output = `
All files |   88.00 |    80.00 |   90.00 |   88.00
also coverage 12.34% somewhere else
    `.trim();

    expect(parseCoverageOutput(output)).toBe(88.0);
  });
});

// ── parseLintOutput ────────────────────────────────────────────────────────────

describe("parseLintOutput", () => {
  test("counts errors and warnings", () => {
    const output = "error: unused variable\nerror: missing type\nwarning: deprecated API";
    const result = parseLintOutput(output);
    expect(result.errors).toBe(2);
    expect(result.warnings).toBe(1);
  });

  test("returns zeros for clean output", () => {
    const result = parseLintOutput("No issues found.");
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(0);
  });

  test("counts 'error' case-insensitively", () => {
    const output = "Error on line 1\nERROR on line 3";
    expect(parseLintOutput(output).errors).toBe(2);
  });
});

// ── determineVerdict ───────────────────────────────────────────────────────────

describe("determineVerdict", () => {
  test("confirmed: all checks pass with predictions", () => {
    const result = determineVerdict({
      tests_failed: 0,
      buildSuccess: true,
      coverage_delta: 0.15,
      lint_delta: 0,
      predictedFixesCount: 2,
      predictedRegressionsCount: 0,
    });

    expect(result.verdict).toBe("confirmed");
    expect(result.predictionAccuracy).toBe("correct");
    expect(result.predictedFixesHit).toBe(1);
    expect(result.unexpectedRegressions).toEqual([]);
  });

  test("confirmed: all checks pass, no predictions (predictedFixesHit = 0)", () => {
    const result = determineVerdict({
      tests_failed: 0,
      buildSuccess: true,
      coverage_delta: 0.05,
      lint_delta: -1,
      predictedFixesCount: 0,
      predictedRegressionsCount: 0,
    });

    expect(result.verdict).toBe("confirmed");
    expect(result.predictedFixesHit).toBe(0);
  });

  test("rejected: test failures", () => {
    const result = determineVerdict({
      tests_failed: 3,
      buildSuccess: true,
      coverage_delta: 0,
      lint_delta: 0,
      predictedFixesCount: 1,
      predictedRegressionsCount: 0,
    });

    expect(result.verdict).toBe("rejected");
    expect(result.predictionAccuracy).toBe("incorrect");
    expect(result.predictedFixesHit).toBe(0);
  });

  test("rejected: build failure", () => {
    const result = determineVerdict({
      tests_failed: 0,
      buildSuccess: false,
      coverage_delta: 0,
      lint_delta: 0,
      predictedFixesCount: 1,
      predictedRegressionsCount: 0,
    });

    expect(result.verdict).toBe("rejected");
  });

  test("rejected: both tests AND build fail", () => {
    const result = determineVerdict({
      tests_failed: 5,
      buildSuccess: false,
      coverage_delta: 0,
      lint_delta: 0,
      predictedFixesCount: 0,
      predictedRegressionsCount: 0,
    });

    expect(result.verdict).toBe("rejected");
    expect(result.predictionAccuracy).toBe("incorrect");
  });

  test("confirmed_with_regression: coverage drops significantly", () => {
    const result = determineVerdict({
      tests_failed: 0,
      buildSuccess: true,
      coverage_delta: -2.5,
      lint_delta: 0,
      predictedFixesCount: 2,
      predictedRegressionsCount: 0,
    });

    expect(result.verdict).toBe("confirmed_with_regression");
    expect(result.predictionAccuracy).toBe("partial");
    expect(result.unexpectedRegressions.length).toBe(1);
    expect(result.unexpectedRegressions[0]).toContain("coverage dropped");
    expect(result.unexpectedRegressions[0]).toContain("2.50%");
  });

  test("confirmed_with_regression: lint spikes", () => {
    const result = determineVerdict({
      tests_failed: 0,
      buildSuccess: true,
      coverage_delta: 0.1,
      lint_delta: 8,
      predictedFixesCount: 1,
      predictedRegressionsCount: 0,
    });

    expect(result.verdict).toBe("confirmed_with_regression");
    expect(result.predictionAccuracy).toBe("partial");
    expect(result.unexpectedRegressions[0]).toContain("lint issues increased");
  });

  test("confirmed: minor coverage drop within tolerance (-0.5)", () => {
    const result = determineVerdict({
      tests_failed: 0,
      buildSuccess: true,
      coverage_delta: -0.5,
      lint_delta: 0,
      predictedFixesCount: 1,
      predictedRegressionsCount: 0,
    });

    expect(result.verdict).toBe("confirmed");
  });

  test("confirmed: minor lint increase within tolerance (+3)", () => {
    const result = determineVerdict({
      tests_failed: 0,
      buildSuccess: true,
      coverage_delta: 0.1,
      lint_delta: 3,
      predictedFixesCount: 0,
      predictedRegressionsCount: 0,
    });

    expect(result.verdict).toBe("confirmed");
  });

  test("coverage regression at exact threshold (-1.0) is NOT flagged", () => {
    const result = determineVerdict({
      tests_failed: 0,
      buildSuccess: true,
      coverage_delta: -1.0,
      lint_delta: 0,
      predictedFixesCount: 0,
      predictedRegressionsCount: 0,
    });

    expect(result.verdict).toBe("confirmed");
  });

  test("coverage regression below threshold (-1.01) IS flagged", () => {
    const result = determineVerdict({
      tests_failed: 0,
      buildSuccess: true,
      coverage_delta: -1.01,
      lint_delta: 0,
      predictedFixesCount: 0,
      predictedRegressionsCount: 0,
    });

    expect(result.verdict).toBe("confirmed_with_regression");
  });

  test("lint spike at exact threshold (5) is NOT flagged", () => {
    const result = determineVerdict({
      tests_failed: 0,
      buildSuccess: true,
      coverage_delta: 0,
      lint_delta: 5,
      predictedFixesCount: 0,
      predictedRegressionsCount: 0,
    });

    expect(result.verdict).toBe("confirmed");
  });

  test("lint spike above threshold (6) IS flagged", () => {
    const result = determineVerdict({
      tests_failed: 0,
      buildSuccess: true,
      coverage_delta: 0,
      lint_delta: 6,
      predictedFixesCount: 0,
      predictedRegressionsCount: 0,
    });

    expect(result.verdict).toBe("confirmed_with_regression");
  });

  test("coverage takes priority over lint — both bad, coverage checked first", () => {
    const result = determineVerdict({
      tests_failed: 0,
      buildSuccess: true,
      coverage_delta: -3.0,
      lint_delta: 10,
      predictedFixesCount: 1,
      predictedRegressionsCount: 0,
    });

    expect(result.verdict).toBe("confirmed_with_regression");
    expect(result.unexpectedRegressions[0]).toContain("coverage dropped");
  });
});

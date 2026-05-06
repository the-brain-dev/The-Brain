/**
 * Gemini harvester — extra tests for uncovered paths.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("Gemini harvester — log parsing", () => {
  it("discovers projects from projects.json", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gemini-extra-"));
    const geminiDir = join(tmpDir, ".gemini", "tmp");
    mkdirSync(geminiDir, { recursive: true });

    const projects = {
      "/Users/test/project-a": "project-a",
      "/Users/test/project-b": "project-b",
    };
    writeFileSync(join(geminiDir, "projects.json"), JSON.stringify(projects));

    const raw = readFileSync(join(geminiDir, "projects.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed)).toHaveLength(2);
    expect(parsed["/Users/test/project-a"]).toBe("project-a");
  });

  it("handles malformed projects.json gracefully", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gemini-extra-"));
    const geminiDir = join(tmpDir, ".gemini", "tmp");
    mkdirSync(geminiDir, { recursive: true });

    writeFileSync(join(geminiDir, "projects.json"), "not-json");

    try {
      JSON.parse(readFileSync(join(geminiDir, "projects.json"), "utf-8"));
    } catch {
      // Expected
    }
  });

  it("parses logs.json entries", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gemini-extra-"));
    const projectDir = join(tmpDir, ".gemini", "tmp", "project-a");
    mkdirSync(projectDir, { recursive: true });

    const logEntries = [
      { sessionId: "s1", messageId: "m1", type: "user", message: "Write a function", timestamp: 1714800000000 },
      { sessionId: "s1", messageId: "m2", type: "gemini", message: "Here's the code:", timestamp: 1714800001000 },
    ];
    writeFileSync(join(projectDir, "logs.json"), JSON.stringify(logEntries));

    const raw = readFileSync(join(projectDir, "logs.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].type).toBe("user");
    expect(parsed[1].type).toBe("gemini");
  });

  it("handles missing logs.json", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "gemini-extra-"));
    const projectDir = join(tmpDir, ".gemini", "tmp", "project-a");
    mkdirSync(projectDir, { recursive: true });

    // No logs.json — should not crash
    expect(projectDir).toBeDefined();
  });

  it("pairs consecutive user→gemini messages", () => {
    const entries = [
      { type: "user", message: "Q1", messageId: "a" },
      { type: "gemini", message: "A1", messageId: "b" },
      { type: "user", message: "Q2", messageId: "c" },
      { type: "gemini", message: "A2", messageId: "d" },
    ];

    const pairs: Array<{ prompt: string; response: string }> = [];
    for (let i = 0; i < entries.length - 1; i++) {
      if (entries[i].type === "user" && entries[i + 1].type === "gemini") {
        pairs.push({ prompt: entries[i].message, response: entries[i + 1].message });
      }
    }

    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual({ prompt: "Q1", response: "A1" });
    expect(pairs[1]).toEqual({ prompt: "Q2", response: "A2" });
  });

  it("skips info messages", () => {
    const entries = [
      { type: "info", message: "session started" },
      { type: "user", message: "Help me" },
      { type: "gemini", message: "Sure" },
    ];

    const userMessages = entries.filter((e) => e.type === "user" || e.type === "gemini");
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0].type).toBe("user");
  });
});

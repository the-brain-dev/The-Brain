/**
 * context command tests — validates cleaned JSON + markdown output.
 *
 * Uses explicit dbPath for parallel test safety.
 */
import { describe, test, expect } from "bun:test";
import { contextCommand } from "../context";
import type { ContextOutput } from "../context";

const REAL_DB_PATH = "/Users/oskarschachta/.my-brain/global/brain.db";

describe("context command (cleaned output)", () => {
  test("returns valid JSON with cleaned content", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => { logs.push(args.join(" ")); };

    try {
      await contextCommand({ json: true, dbPath: REAL_DB_PATH });

      expect(logs.length).toBe(1);
      const output: ContextOutput = JSON.parse(logs[0]);

      // Meta
      expect(output.meta.dbType).toBe("global");
      expect(new Date(output.meta.generatedAt).getTime()).toBeGreaterThan(0);

      // Stats
      expect(output.stats.totalMemories).toBeGreaterThan(0);

      // Graph nodes have cleaned labels
      for (const node of output.graphNodes.highWeight) {
        expect(node.cleaned).toBeString();
        expect(node.cleaned.length).toBeGreaterThan(0);
        // Cleaned label should not contain raw \\n
        expect(node.cleaned).not.toContain("\\\\n");
      }

      // Recent activity uses cleaned summaries
      for (const a of output.recentActivity) {
        expect(a.summary).toBeString();
        expect(a.summary.length).toBeGreaterThan(0);
        // Should not contain raw XML
        expect(a.summary).not.toContain("<observed_from_primary_session>");
        expect(a.summary).not.toContain("<what_happened>");
      }

      // SPM patterns use cleaned summaries
      for (const p of output.spmPatterns) {
        expect(p.summary).toBeString();
        expect(p.surpriseScore).toBeGreaterThanOrEqual(0.3);
      }
    } finally {
      console.log = origLog;
    }
  });

  test("returns compact markdown", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => { logs.push(args.join(" ")); };

    try {
      await contextCommand({ markdown: true, dbPath: REAL_DB_PATH });

      expect(logs.length).toBe(1);
      const md = logs[0];

      // Markdown structure
      expect(md).toContain("## 🧠 my-brain Context");
      expect(md).toContain("**Stats:**");

      // Should NOT contain raw XML
      expect(md).not.toContain("observed_from_primary_session");
      expect(md).not.toContain("what_happened");

      // Should have cleaned content
      const hasGraph = md.includes("📌");
      const hasSPM = md.includes("⚡");
      const hasRecent = md.includes("🕐");
      expect(hasGraph || hasSPM || hasRecent).toBe(true);
    } finally {
      console.log = origLog;
    }
  });

  test("deduplicates similar content", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => { logs.push(args.join(" ")); };

    try {
      await contextCommand({ json: true, dbPath: REAL_DB_PATH });
      const output: ContextOutput = JSON.parse(logs[0]);

      // Check that summaries are unique
      const summaries = output.recentActivity.map(a => a.summary.slice(0, 50));
      const uniqueSummaries = new Set(summaries);
      expect(uniqueSummaries.size).toBe(summaries.length);
    } finally {
      console.log = origLog;
    }
  });

  test("graph nodes sorted by weight (descending)", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => { logs.push(args.join(" ")); };

    try {
      await contextCommand({ json: true, dbPath: REAL_DB_PATH });
      const output: ContextOutput = JSON.parse(logs[0]);

      if (output.graphNodes.highWeight.length >= 2) {
        for (let i = 0; i < output.graphNodes.highWeight.length - 1; i++) {
          expect(
            output.graphNodes.highWeight[i].weight
          ).toBeGreaterThanOrEqual(
            output.graphNodes.highWeight[i + 1].weight
          );
        }
      }
    } finally {
      console.log = origLog;
    }
  });

  test("handles non-existent database gracefully", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => { logs.push(args.join(" ")); };

    try {
      await contextCommand({ json: true, dbPath: "/tmp/nonexistent-12345.db" });
      const output = JSON.parse(logs[0]);
      expect(output.error).toBe("no_database");
    } finally {
      console.log = origLog;
    }
  });
});

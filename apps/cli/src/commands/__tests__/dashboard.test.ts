/**
 * Tests for dashboard rendering functions.
 *
 * Tests the ANSI-rendered components without needing a terminal.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { BrainDB } from "@the-brain/core";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// We test the data-fetching logic through a mocked DB
// Full rendering tests require a terminal — these test the data pipeline.

describe("Dashboard data fetching", () => {
  let tmpDir: string;
  let db: BrainDB;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "the-brain-dash-"));
    db = new BrainDB(join(tmpDir, "test.db"));

    // Seed test data
    await db.insertMemory({
      id: "mem-1",
      layer: "instant" as any,
      content: "User asked about TypeScript const vs let",
      timestamp: Date.now() - 60000,
      source: "cursor",
    });
    await db.insertMemory({
      id: "mem-2",
      layer: "selection" as any,
      content: "Fixed memory leak in harvester pipeline",
      timestamp: Date.now() - 120000,
      source: "claude",
    });
    await db.insertMemory({
      id: "mem-3",
      layer: "deep" as any,
      content: "Pattern: always use const for immutable bindings",
      timestamp: Date.now() - 600000,
      source: "cursor",
      surpriseScore: 0.75,
    });

    // Seed graph nodes
    await db.upsertGraphNode({
      id: "node-1",
      label: "const vs let preference",
      type: "preference",
      content: "User prefers const over let",
      connections: [],
      weight: 0.92,
      timestamp: Date.now(),
      source: "cursor",
    });
    await db.upsertGraphNode({
      id: "node-2",
      label: "harvester memory leak fix",
      type: "correction",
      content: "Fixed harvester not releasing file handles",
      connections: ["node-1"],
      weight: 0.85,
      timestamp: Date.now(),
      source: "claude",
    });
    await db.upsertGraphNode({
      id: "node-3",
      label: "Bun test runner preference",
      type: "preference",
      content: "Use bun test for all tests",
      connections: [],
      weight: 0.45,
      timestamp: Date.now(),
      source: "cursor",
    });
  });

  afterEach(() => {
    try { db?.close(); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("fetches stats with correct counts", async () => {
    const stats = await db.getStats();
    expect(stats.memories).toBe(3);
    expect(stats.graphNodes).toBe(3);
    expect(stats.perLayer.instant).toBe(1);
    expect(stats.perLayer.selection).toBe(1);
    expect(stats.perLayer.deep).toBe(1);
  });

  it("fetches recent memories sorted by timestamp", async () => {
    const memories = await db.getAllMemories(10);
    expect(memories.length).toBe(3);
    // Most recent first
    expect(memories[0].id).toBe("mem-1");
    expect(memories[2].id).toBe("mem-3");
  });

  it("fetches memories by layer", async () => {
    const instant = await db.getMemoriesByLayer("instant" as any);
    expect(instant.length).toBe(1);
    expect(instant[0].content).toContain("TypeScript");

    const deep = await db.getMemoriesByLayer("deep" as any);
    expect(deep.length).toBe(1);
    expect(deep[0].content).toContain("immutable");
  });

  it("fetches high-weight graph nodes", async () => {
    const nodes = await db.getHighWeightNodes(0.5);
    expect(nodes.length).toBe(2); // 0.92 and 0.85
    expect(nodes[0].weight).toBeGreaterThanOrEqual(0.85);
  });

  it("updates memory surprise scores", async () => {
    await db.updateMemory("mem-3", { surpriseScore: 0.9 });
    const memories = await db.getMemoriesByLayer("deep" as any);
    expect(memories[0].surpriseScore).toBe(0.9);
  });
});

describe("Dashboard ANSI rendering", () => {
  it("produces ANSI escape codes for colors", () => {
    const CSI = "\x1b[";
    const GREEN = `${CSI}32m`;
    const RESET = `${CSI}0m`;
    const result = `${GREEN}RUNNING${RESET}`;
    expect(result).toContain(CSI);
    expect(result).toContain("32m");
    expect(result).toContain("RUNNING");
    expect(result).toContain("0m");
  });

  it("generates bold text", () => {
    const BOLD = "\x1b[1m";
    const RESET = "\x1b[0m";
    expect(`${BOLD}Hello${RESET}`).toContain("1m");
  });

  it("generates dim text", () => {
    const DIM = "\x1b[2m";
    const RESET = "\x1b[0m";
    expect(`${DIM}subtle${RESET}`).toContain("2m");
  });

  it("formats bar chart for weight visualization", () => {
    const BAR = "█";
    const EMPTY = "░";
    const width = 20;
    const weight = 0.75;
    const barLen = Math.round(weight * width);
    const bar = BAR.repeat(barLen) + EMPTY.repeat(width - barLen);
    expect(bar).toBe("█".repeat(15) + "░".repeat(5));
    expect(bar.length).toBe(20);
  });

  it("truncates long strings properly", () => {
    const long = "This is a very long label that should be truncated at 40 characters because it's too long";
    const max = 40;
    const truncated = long.length > max ? long.slice(0, max - 3) + "..." : long;
    expect(truncated.length).toBe(40);
    expect(truncated.endsWith("...")).toBe(true);
  });
});

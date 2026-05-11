/**
 * Tests for project-local .brain/ state directory.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { LocalBrainDir } from "../local-brain";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("LocalBrainDir", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("creates .brain/ directory on init", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "brain-local-"));
    const localBrain = new LocalBrainDir(tmpDir);

    expect(localBrain.exists()).toBe(false);

    localBrain.ensureDir();

    expect(localBrain.exists()).toBe(true);
    expect(existsSync(join(tmpDir, ".brain"))).toBe(true);
    expect(existsSync(join(tmpDir, ".brain", ".gitignore"))).toBe(true);
    expect(existsSync(join(tmpDir, ".brain", "prompts"))).toBe(true);
  });

  it("reads default state when no state.json exists", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "brain-local-"));
    const localBrain = LocalBrainDir.init(tmpDir);
    const state = localBrain.readState();

    expect(state.totalInteractions).toBe(0);
    expect(state.crossProjectPromotions).toBe(0);
    expect(state.lastConsolidation).toBeUndefined();
  });

  it("updates and persists state", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "brain-local-"));
    const localBrain = LocalBrainDir.init(tmpDir);

    await localBrain.updateState({
      lastConsolidation: 1714800000000,
      totalInteractions: 42,
    });

    const state = localBrain.readState();
    expect(state.lastConsolidation).toBe(1714800000000);
    expect(state.totalInteractions).toBe(42);
    expect(state.crossProjectPromotions).toBe(0); // unchanged default

    // Verify persistence to disk
    const raw = readFileSync(join(tmpDir, ".brain", "state.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.lastConsolidation).toBe(1714800000000);
  });

  it("deep merges harvester offsets", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "brain-local-"));
    const localBrain = LocalBrainDir.init(tmpDir);

    await localBrain.updateState({
      harvesterOffsets: {
        cursor: { lastOffset: 100, lastTimestamp: 1000 },
      },
    });

    await localBrain.updateState({
      harvesterOffsets: {
        claude: { lastOffset: 200, lastTimestamp: 2000 },
      },
    });

    const state = localBrain.readState();
    expect(state.harvesterOffsets!.cursor).toBeDefined();
    expect(state.harvesterOffsets!.claude).toBeDefined();
    expect(state.harvesterOffsets!.cursor!.lastOffset).toBe(100);
    expect(state.harvesterOffsets!.claude!.lastOffset).toBe(200);
  });

  it("getLocalDBPath returns path when directory exists", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "brain-local-"));
    const localBrain = new LocalBrainDir(tmpDir);
    localBrain.ensureDir();

    const dbPath = localBrain.getLocalDBPath();
    expect(dbPath).toBe(join(tmpDir, ".brain", "memories.db"));
  });

  it("getLocalDBPath returns null when directory doesn't exist", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "brain-local-"));
    const localBrain = new LocalBrainDir(tmpDir);

    const dbPath = localBrain.getLocalDBPath();
    expect(dbPath).toBeNull();
  });

  it("discovers .brain/ by walking up directories", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "brain-local-"));

    // Create .brain/ at the root
    LocalBrainDir.init(tmpDir);

    // Create nested directory
    const nestedDir = join(tmpDir, "src", "components", "deep");
    mkdirSync(nestedDir, { recursive: true });

    const discovered = LocalBrainDir.discover(nestedDir);
    expect(discovered).not.toBeNull();
    expect(discovered!.exists()).toBe(true);
  });

  it("returns null when no .brain/ found in parent chain", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "brain-local-"));
    const discovered = LocalBrainDir.discover(tmpDir);
    expect(discovered).toBeNull();
  });

  it("getPromptsDir returns prompts subdirectory", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "brain-local-"));
    const localBrain = LocalBrainDir.init(tmpDir);

    const promptsDir = localBrain.getPromptsDir();
    expect(promptsDir).toBe(join(tmpDir, ".brain", "prompts"));
    expect(existsSync(promptsDir)).toBe(true);
  });
});

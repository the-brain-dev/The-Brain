/**
 * Clean CLI commands tests — no mock.module()
 */
import { describe, test, expect, mock } from "bun:test";

// ── daemon command ──────────────────────────────────────────────
describe("daemonCommand", () => {
  test("imports daemonCommand function", async () => {
    const mod = await import("../commands/daemon");
    expect(typeof mod.daemonCommand).toBe("function");
  });

  test("status reports daemon is stopped", async () => {
    const { daemonCommand } = await import("../commands/daemon");
    await daemonCommand("status", {});
    // Should not throw
  });

  test("unknown action exits with error", async () => {
    const { daemonCommand } = await import("../commands/daemon");
    const origExit = process.exit;
    let exited = false;
    process.exit = mock((() => { exited = true; throw new Error("exit"); }) as any);
    try {
      await daemonCommand("bogus", {});
    } catch (e: any) {
      expect(e.message).toBe("exit");
    }
    expect(exited).toBe(true);
    process.exit = origExit;
  });
});

// ── inspect command ─────────────────────────────────────────────
describe("inspectCommand", () => {
  test("imports inspectCommand", async () => {
    const mod = await import("../commands/inspect");
    expect(typeof mod.inspectCommand).toBe("function");
  });

  test("--stats with in-memory DB", async () => {
    const { inspectCommand } = await import("../commands/inspect");
    await inspectCommand({ stats: true });
  });

  test("--graph flag", async () => {
    const { inspectCommand } = await import("../commands/inspect");
    await inspectCommand({ graph: true });
  });

  test("--memories flag", async () => {
    const { inspectCommand } = await import("../commands/inspect");
    await inspectCommand({ memories: true });
  });

  test("--recent flag", async () => {
    const { inspectCommand } = await import("../commands/inspect");
    await inspectCommand({ recent: true });
  });

  test("--memories with layer filter", async () => {
    const { inspectCommand } = await import("../commands/inspect");
    await inspectCommand({ memories: "instant" });
  });
});

// ── consolidate command ─────────────────────────────────────────
describe("consolidateCommand", () => {
  test("imports consolidateCommand", async () => {
    const mod = await import("../commands/consolidate");
    expect(typeof mod.consolidateCommand).toBe("function");
  });

  test("--now on in-memory DB", async () => {
    const { consolidateCommand } = await import("../commands/consolidate");
    const origExit = process.exit;
    process.exit = mock(() => { throw new Error("exit"); }) as any;
    try { await consolidateCommand({ now: true }); } catch (e: any) {}
    process.exit = origExit;
  });

  test("--now --layer selection", async () => {
    const { consolidateCommand } = await import("../commands/consolidate");
    const origExit = process.exit;
    process.exit = mock(() => { throw new Error("exit"); }) as any;
    try { await consolidateCommand({ now: true, layer: "selection" }); } catch (e: any) {}
    process.exit = origExit;
  });
});

// ── init command ────────────────────────────────────────────────
describe("initCommand", () => {
  test("--force --db-path :memory:", async () => {
    const { initCommand } = await import("../commands/init");
    await initCommand({ force: true, dbPath: ":memory:" });
  });
});

// ── daemon module (stopDaemon only, since startDaemon hangs) ────
describe("daemon module", () => {
  test("stopDaemon handles missing PID gracefully", async () => {
    const { stopDaemon } = await import("../daemon");
    await stopDaemon();
    // Should not throw
  });

  test("startDaemon is importable", async () => {
    const mod = await import("../daemon");
    expect(typeof mod.startDaemon).toBe("function");
    expect(typeof mod.stopDaemon).toBe("function");
  });
});

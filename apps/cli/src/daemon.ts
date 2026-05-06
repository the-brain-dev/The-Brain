/**
 * Daemon runtime — starts engine, runs infinite processing loop.
 * Multi-project aware: consolidates active project + cross-project SPM promotion.
 */
import { writeFile, unlink, readFile } from "node:fs/promises";
import { consola } from "consola";
import { HookEvent, MemoryLayer, ProjectManager } from "@the-brain/core";
import type { BrainDB, ConsolidationContext } from "@the-brain/core";
import { initDaemon, getConfigDir, getPidFile, getConfigPath } from "./engine";
import type { DaemonConfig, DaemonEngine } from "./engine";
import { startAPIServer, type APIState } from "./api-server";

const CONSOLIDATION_INTERVAL = 3600 * 1000; // 1 hour

// ── Exported for tests ─────────────────────────────────────────
export { getConfigDir, getPidFile, getConfigPath };
export type { DaemonConfig, DaemonEngine };
export { initDaemon } from "./engine";

// ── startDaemon ────────────────────────────────────────────────

export async function startDaemon(config: DaemonConfig) {
  consola.start("Initializing the-brain daemon...");
  const engine = await initDaemon(config);
  const PID_FILE = getPidFile();

  await writeFile(PID_FILE, String(process.pid));

  consola.success(`Daemon started (PID: ${process.pid})`);
  consola.info(`Polling every ${config.pollIntervalMs}ms | Press Ctrl+C to stop`);

  await engine.hooks.callHook(HookEvent.DAEMON_START, {
    config,
    activeContext: engine.activeProject || "global",
  });

  // ── API server (menu bar app, health checks) ──────────────
  const apiState: APIState = {
    startTime: Date.now(),
    lastTraining: null,
    lastTrainingDuration: null,
    lastTrainingLoss: null,
    lastConsolidationAt: null,
  };

  // ── Resolve server config from brain config ──
  const serverCfg = {
    mode: engine.config.server?.mode ?? "local" as const,
    bindAddress: engine.config.server?.bindAddress ?? "127.0.0.1",
    authToken: engine.config.server?.authToken,
    port: engine.config.server?.port,
  };
  const apiServer = startAPIServer(engine, apiState, serverCfg);
  const apiPort = serverCfg.port ?? 9420;
  consola.info(`API server: http://${serverCfg.bindAddress}:${apiPort} (${serverCfg.mode} mode)`);
  if (serverCfg.authToken) {
    consola.info(`  Auth: Bearer ${serverCfg.authToken.slice(0, 12)}...`);
  }

  // ── Main loop via pluggable scheduler ──────────────────────
  const tick = async () => {
    if (!engine.running) return;
    try {
      await engine.hooks.callHook(HookEvent.HARVESTER_POLL);
      await runConsolidationCheck(engine);
    } catch (err) {
      consola.error("Daemon tick error:", err);
    }
  };

  // Initial tick + recurring schedule
  await tick();
  engine.scheduler.schedule("main-loop", config.pollIntervalMs, tick);

  // ── Overnight training schedule ──────────────────────────
  const mlxSchedule = engine.brainConfig.mlx?.schedule ?? "0 2 * * *";
  scheduleOvernightTraining(engine, mlxSchedule, apiState);

  // Cleanup
  const cleanup = async () => {
    engine.running = false;
    await engine.scheduler.shutdown();
    await engine.cleanup();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Keep process alive — cleanup calls process.exit(0)
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (!engine.running) { clearInterval(timer); resolve(); }
    }, 1000);
  });
}

// ── Consolidation ──────────────────────────────────────────────

async function runConsolidationCheck(engine: DaemonEngine) {
  const now = Date.now();
  if (now - engine.lastConsolidation > CONSOLIDATION_INTERVAL) {
    const pm = engine.projectManager;

    // ── 1. Consolidate active project ──
    const activeDB = await pm.getActiveDB();
    const surprising = await activeDB.getSurprisingMemories(0.4);

    if (surprising.length > 0) {
      const ctx: ConsolidationContext = {
        targetLayer: MemoryLayer.DEEP,
        fragments: surprising,
        results: {
          layer: MemoryLayer.DEEP,
          fragmentsPromoted: 0,
          fragmentsDiscarded: 0,
          duration: 0,
        },
      };
      // Promote to DEEP (write to DB), but DON'T fire DEEP_CONSOLIDATE here.
      // Training runs on a separate overnight cron schedule via mlx.schedule config.
      for (const frag of surprising) {
        if (frag.surpriseScore && frag.surpriseScore >= 0.4) {
          await activeDB.insertMemory({
            ...frag,
            layer: MemoryLayer.DEEP,
            metadata: { ...(frag.metadata || {}), promotedAt: now },
          });
        }
      }

      engine.lastConsolidation = now;
      consola.debug(`Promoted ${surprising.length} memories to DEEP (hourly SPM check)`);
    }

    // ── 2. Cross-project promotion check (SPM) ──
    // Check if the same pattern appears in 2+ projects → promote to global
    await crossProjectPromotionCheck(pm);
  }
}

/**
 * Cross-project promotion: if a memory/pattern appears in 2+ projects,
 * promote it to the global brain.
 */
async function crossProjectPromotionCheck(pm: ProjectManager) {
  const globalDB = pm.getGlobalDB();
  const projects = pm.listProjects();

  if (projects.length < 2) return; // Need at least 2 projects to compare

  // Collect recent memories from each project
  const projectMemories = new Map<string, Awaited<ReturnType<BrainDB["getRecentMemories"]>>>();
  for (const ctx of projects) {
    const pdb = await pm.getProjectDB(ctx.name).catch(() => null);
    if (!pdb) continue;
    const memories = await pdb.getRecentMemories(24); // Last 24h
    if (memories.length > 0) {
      projectMemories.set(ctx.name, memories);
    }
  }

  if (projectMemories.size < 2) return;

  // Simple cross-project pattern detection: hash first 80 chars of content
  const globalDBMemories = await globalDB.getRecentMemories(24);
  const globalHashes = new Set(globalDBMemories.map((m) => m.content.slice(0, 80)));

  for (const [projectA, memsA] of projectMemories) {
    for (const [projectB, memsB] of projectMemories) {
      if (projectA >= projectB) continue; // Don't compare same pair twice

      for (const mA of memsA) {
        for (const mB of memsB) {
          const hashA = mA.content.slice(0, 80);
          const hashB = mB.content.slice(0, 80);

          // Same content in 2 different projects → promote to global
          if (hashA === hashB && !globalHashes.has(hashA)) {
            await globalDB.insertMemory({
              ...mA,
              id: `global-${mA.id}`,
              layer: MemoryLayer.SELECTION,
              metadata: {
                ...(mA.metadata || {}),
                promotedFrom: [projectA, projectB],
                crossProject: true,
              },
            });
            globalHashes.add(hashA);
            consola.debug(`Cross-project promotion: "${hashA.slice(0, 50)}..." from ${projectA}+${projectB}`);
          }
        }
      }
    }
  }
}

// ── Overnight Training Scheduler ────────────────────────────────

/**
 * Parse a simple 5-field cron expression into ms until next run.
 * Format: minute hour day-of-month month day-of-week
 * Supports wildcard (*), explicit values, and ranges.
 */
function parseCronSchedule(cron: string): number {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return 3600_000; // default: every hour

  const [minStr, hourStr, dom, month, dow] = parts;
  const now = new Date();

  // Parse fields
  const parseField = (field: string, currentValue: number, unit: "minute" | "hour"): number => {
    if (field === "*") return currentValue;
    // Range support: "0-6"
    if (field.includes("-")) {
      const [start, end] = field.split("-").map(Number);
      if (currentValue >= start && currentValue <= end) return currentValue;
      return start;
    }
    // Comma-separated
    if (field.includes(",")) {
      const values = field.split(",").map(Number);
      const next = values.find(v => v >= currentValue);
      return next ?? values[0];
    }
    return Number(field);
  };

  const targetMinute = parseField(minStr, now.getMinutes(), "minute");
  const targetHour = parseField(hourStr, now.getHours(), "hour");

  // Compute next occurrence
  const next = new Date(now);
  next.setSeconds(0, 0);

  if (targetHour > now.getHours() || (targetHour === now.getHours() && targetMinute > now.getMinutes())) {
    // Later today
    next.setHours(targetHour, targetMinute);
  } else {
    // Tomorrow
    next.setDate(next.getDate() + 1);
    next.setHours(targetHour, targetMinute);
  }

  return next.getTime() - now.getTime();
}

/**
 * Schedule overnight MLX LoRA training based on mlx.schedule in config.
 * Consolidates DEEP memories and runs full training pipeline.
 */
function scheduleOvernightTraining(engine: DaemonEngine, cronExpr: string, apiState: APIState) {
  const scheduleNext = () => {
    const delayMs = parseCronSchedule(cronExpr);
    consola.info(`Overnight training scheduled in ${Math.round(delayMs / 3600_000)}h ${Math.round((delayMs % 3600_000) / 60_000)}m (cron: ${cronExpr})`);

    engine.scheduler.scheduleOnce("overnight-training", delayMs, async () => {
      if (!engine.running) return;

      consola.start("Starting overnight MLX LoRA training...");
      const startTime = Date.now();

      try {
        const activeDB = await engine.projectManager.getActiveDB();
        const deepMemories = await activeDB.getMemoriesByLayer(MemoryLayer.DEEP, 500);

        if (deepMemories.length < 3) {
          consola.info(`Overnight training skipped: only ${deepMemories.length} DEEP memories (need ≥3)`);
          return;
        }

        const fragments = deepMemories.map((m) => ({
          id: m.id,
          layer: MemoryLayer.DEEP,
          content: m.content,
          surpriseScore: m.surpriseScore,
          timestamp: m.timestamp,
          source: m.source,
          metadata: m.metadata,
        }));

        // ── Fire DEEP_CONSOLIDATE to trigger training ──
        const ctx: ConsolidationContext = {
          targetLayer: MemoryLayer.DEEP,
          fragments,
          results: {
            layer: MemoryLayer.DEEP,
            fragmentsPromoted: 0,
            fragmentsDiscarded: 0,
            duration: 0,
          },
        };

        await engine.hooks.callHook(HookEvent.DEEP_CONSOLIDATE, ctx);

        const duration = (Date.now() - startTime) / 1000;
        apiState.lastTraining = Date.now();
        apiState.lastTrainingDuration = duration;
        consola.success(`Overnight training complete in ${duration.toFixed(1)}s`);
      } catch (err) {
        consola.error("Overnight training failed:", err);
      }

      // Schedule next run
      scheduleNext();
    });
  };

  scheduleNext();
}

// ── stopDaemon ─────────────────────────────────────────────────

export async function stopDaemon() {
  try {
    const pidStr = await readFile(getPidFile(), "utf-8");
    const pid = parseInt(pidStr);
    process.kill(pid, "SIGTERM");
    consola.success(`Sent SIGTERM to daemon (PID: ${pid})`);
  } catch {
    consola.warn("No running daemon found");
  }
}

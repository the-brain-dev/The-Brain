/**
 * Daemon runtime — starts engine, runs infinite processing loop.
 * Multi-project aware: consolidates active project + cross-project SPM promotion.
 */
import { join } from "node:path";
import { writeFile, unlink, readFile } from "node:fs/promises";
import { consola } from "consola";
import { HookEvent, MemoryLayer, ProjectManager } from "@my-brain/core";
import type { BrainDB, ConsolidationContext } from "@my-brain/core";
import { initDaemon, getConfigDir, getPidFile, getConfigPath } from "./engine";
import type { DaemonConfig, DaemonEngine } from "./engine";

const CONSOLIDATION_INTERVAL = 3600 * 1000; // 1 hour

// ── Exported for tests ─────────────────────────────────────────
export { getConfigDir, getPidFile, getConfigPath };
export type { DaemonConfig, DaemonEngine };
export { initDaemon } from "./engine";

// ── startDaemon ────────────────────────────────────────────────

export async function startDaemon(config: DaemonConfig) {
  consola.start("Initializing my-brain daemon...");
  const engine = await initDaemon(config);
  const PID_FILE = getPidFile();

  await writeFile(PID_FILE, String(process.pid));

  consola.success(`Daemon started (PID: ${process.pid})`);
  consola.info(`Polling every ${config.pollIntervalMs}ms | Press Ctrl+C to stop`);

  await engine.hooks.callHook(HookEvent.DAEMON_START, {
    config,
    activeContext: engine.activeProject || "global",
  });

  // ── Main loop ────────────────────────────────────────────────
  const tick = async () => {
    if (!engine.running) return;
    try {
      await engine.hooks.callHook(HookEvent.HARVESTER_POLL);
      await runConsolidationCheck(engine);
    } catch (err) {
      consola.error("Daemon tick error:", err);
    }
  };

  await tick();
  const interval = setInterval(tick, config.pollIntervalMs);

  // Cleanup
  const cleanup = async () => {
    engine.running = false;
    clearInterval(interval);
    await engine.cleanup();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  await new Promise(() => {}); // infinite — never resolves
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
      await engine.layerRouter.runDeep(ctx);

      // Fire DEEP_CONSOLIDATE hook (auto-wiki, MLX trainer react to this)
      await engine.hooks.callHook(HookEvent.DEEP_CONSOLIDATE, ctx);

      engine.lastConsolidation = now;
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

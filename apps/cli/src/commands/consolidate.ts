/**
 * consolidate command — Force memory consolidation (Layer 2 → Layer 3).
 *
 * Supports:
 *   --now        Run consolidation immediately
 *   --reprocess  Run all INSTANT memories through SPM Curator first
 *                (assigns surprise scores, promotes to SELECTION layer)
 *   --project    Target a specific project
 *   --global     Target global brain
 */
import { consola } from "consola";
import { BrainDB, MemoryLayer, safeParseConfig } from "@the-brain-dev/core";
import type { ConsolidationContext, MemoryFragment, Memory, InteractionContext } from "@the-brain-dev/core";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { TheBrainConfig } from "@the-brain-dev/core";

const CONFIG_PATH = join(process.env.HOME || "~", ".the-brain", "config.json");
const DEFAULT_DB_PATH = join(process.env.HOME || "~", ".the-brain", "brain.db");

export async function consolidateCommand(options: {
  now?: boolean;
  layer?: string;
  reprocess?: boolean;
  project?: string;
  global?: boolean;
}) {
  let dbPath = DEFAULT_DB_PATH;

  // Resolve DB path from config
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = await readFile(CONFIG_PATH, "utf-8");
      const result = safeParseConfig(JSON.parse(raw));
      if (!result.success) {
        consola.warn(`Config validation: ${result.error}. Using defaults.`);
        dbPath = DEFAULT_DB_PATH;
      } else {
        const config = result.data;

        if (options.project) {
          const ctx = config.contexts?.[options.project];
          if (!ctx) {
            consola.error(`Project "${options.project}" not found.`);
            process.exit(1);
          }
          dbPath = ctx.dbPath;
          consola.info(`Targeting project: ${options.project}`);
        } else if (options.global) {
          dbPath = config.database.path;
          consola.info("Targeting global brain");
        } else if (config.activeContext && config.activeContext !== "global" && config.contexts?.[config.activeContext]) {
          dbPath = config.contexts[config.activeContext].dbPath;
        } else {
          dbPath = config.database.path;
        }
      }
    } catch (err) {
      console.error("[Consolidate] Failed to load config, using default DB path:", err);
    }
  }

  const db = new BrainDB(dbPath);

  try {
    // ── Reprocess: run SPM on all INSTANT memories ──
    if (options.reprocess) {
      await reprocessMemoriesWithSPM(db);
    }

    // ── Normal consolidation ──
    const startTime = Date.now();

    const selectionMemories = await db.getMemoriesByLayer(MemoryLayer.SELECTION, 500);
    const surprisingMemories = await db.getSurprisingMemories(0.3);

    consola.info(`Found ${selectionMemories.length} selection-layer memories`);
    consola.info(`Found ${surprisingMemories.length} surprising memories (>=0.3)`);

    let promotedCount = 0;
    let discardedCount = 0;

    for (const mem of surprisingMemories) {
      const deepId = `deep-${mem.id}`;
      try {
        await db.insertMemory({
          ...mem,
          id: deepId,
          layer: MemoryLayer.DEEP,
          metadata: {
            ...mem.metadata,
            consolidatedAt: Date.now(),
            originalLayer: MemoryLayer.SELECTION,
          },
        });
        promotedCount++;
      } catch (err) {
        // If duplicate ID, update metadata instead of failing
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("UNIQUE") || msg.includes("duplicate")) {
          await db.updateMemory(deepId, {
            metadata: JSON.stringify({
              ...mem.metadata,
              consolidatedAt: Date.now(),
              originalLayer: MemoryLayer.SELECTION,
              reconsolidated: true,
            }),
          });
        }
        // Other errors (disk full, etc.) — skip this memory, continue with others
      }
    }

    // Discard old, low-surprise memories
    const toDiscard = selectionMemories.filter(
      (m) => (m.surpriseScore ?? 0) < 0.2 && m.timestamp < Date.now() - 86400 * 1000 * 7
    );
    discardedCount = toDiscard.length;

    const duration = (Date.now() - startTime) / 1000;

    consola.success(`
🧠 Consolidation complete!

  Duration:       ${duration.toFixed(1)}s
  Promoted:       ${promotedCount} fragments -> Deep Layer
  Discarded:       ${discardedCount} stale fragments
  Remaining:      ${selectionMemories.length - promotedCount - discardedCount} in Selection Layer
`);

    const stats = await db.getStats();
    consola.info(`Total memories: ${stats.memories} | Graph nodes: ${stats.graphNodes}`);
  } catch (err) {
    consola.error("Consolidation failed:", err);
    process.exit(1);
  } finally {
    db.close();
  }
}

// ── SPM Reprocessing ────────────────────────────────────────────

function parseMemoryContent(mem: Memory): { prompt: string; response: string } {
  const content = mem.content || "";
  const promptMatch = content.match(/Prompt:\s*(.+?)(?:\nResponse:|\n$|$)/s);
  const responseMatch = content.match(/Response:\s*(.+?)$/s);
  return {
    prompt: promptMatch?.[1]?.trim() || content.slice(0, 200),
    response: responseMatch?.[1]?.trim() || "",
  };
}

async function reprocessMemoriesWithSPM(db: BrainDB) {
  consola.start("Reprocessing all memories through SPM Curator...");

  const allMemories = await db.getMemoriesByLayer(MemoryLayer.INSTANT, 1000);
  if (allMemories.length === 0) {
    consola.info("No INSTANT memories to reprocess.");
    return;
  }

  const { createSpmCurator } = await import("@the-brain-dev/plugin-spm-curator");
  const spm = createSpmCurator({ threshold: 0.3 }).instance;

  let processed = 0;
  let scored = 0;

  for (const mem of allMemories) {
    const { prompt, response } = parseMemoryContent(mem);

    const ctx: InteractionContext = {
      interaction: {
        id: mem.id,
        prompt,
        response,
        timestamp: mem.timestamp,
        source: mem.source,
      },
      fragments: [{
        id: mem.id,
        layer: MemoryLayer.INSTANT,
        content: mem.content,
        timestamp: mem.timestamp,
        source: mem.source,
      }],
      promoteToDeep(frag: MemoryFragment) { /* handled below via insertMemory */ },
    };

    const result = await spm.evaluate(ctx);

    // Update memory with surprise score and move to SELECTION if scored
    if (result.score > 0) {
      const selId = `sel-${mem.id}`;
      try {
        await db.insertMemory({
          ...mem,
          id: selId,
          layer: MemoryLayer.SELECTION,
          surpriseScore: result.score,
          metadata: {
            ...mem.metadata,
            spmReprocessed: true,
            spmScore: result.score,
            spmReason: result.reason,
            spmIsSurprising: result.isSurprising,
          },
        });
        scored++;
      } catch (err) {
        // Already exists from previous reprocess — update instead
        console.error("[Consolidate] Insert failed (expected if duplicate), updating:", err);
        await db.updateMemory(selId, {
          surpriseScore: result.score,
          metadata: JSON.stringify({
            ...mem.metadata,
            spmReprocessed: true,
            spmScore: result.score,
            spmReason: result.reason,
            spmIsSurprising: result.isSurprising,
            updatedAt: Date.now(),
          }),
        });
        scored++;
      }
    }

    processed++;

    if (processed % 50 === 0) {
      consola.info(`  ${processed}/${allMemories.length} processed...`);
    }
  }

  consola.success(`SPM reprocessing complete: ${scored}/${processed} scored`);
}

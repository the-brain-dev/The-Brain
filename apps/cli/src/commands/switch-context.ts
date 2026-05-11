/**
 * switch-context command — Switch the active project context
 */
import { consola } from "consola";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TheBrainConfig } from "@the-brain-dev/core";
import { safeParseConfig } from "@the-brain-dev/core";

const CONFIG_DIR = join(process.env.HOME || "~", ".the-brain");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export async function switchContextCommand(options: {
  project?: string;
  global?: boolean;
}) {
  const target = options.global ? "global" : options.project;

  if (!target) {
    consola.error("Specify --project <name> or --global");
    process.exit(1);
  }

  try {
    // Load config
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const parsed = safeParseConfig(JSON.parse(raw));
    if (!parsed.success) {
      consola.error("Config validation failed. Run 'the-brain init' to repair.");
      process.exit(1);
    }
    const config = parsed.data;

    // Validate
    if (target !== "global" && !config.contexts?.[target]) {
      const available = Object.keys(config.contexts || {}).join(", ");
      consola.error(
        `Project "${target}" not found.${available ? ` Available: ${available}` : " No projects registered."}`
      );
      consola.info("Create one with: the-brain init --project " + target);
      process.exit(1);
    }

    const oldContext = config.activeContext || "global";
    config.activeContext = target;

    // Update lastActive
    if (target !== "global" && config.contexts[target]) {
      config.contexts[target].lastActive = Date.now();
    }

    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");

    consola.success(`Switched from "${oldContext}" → "${target}"`);

    // Show context details
    if (target === "global") {
      consola.info(`  Global DB: ${config.database.path}`);
      consola.info(`  Global Wiki: ${config.wiki.outputDir}`);
    } else {
      const ctx = config.contexts[target];
      consola.info(`  Project: ${ctx.label || ctx.name}`);
      consola.info(`  DB: ${ctx.dbPath}`);
      consola.info(`  Wiki: ${ctx.wikiDir}`);
      if (ctx.workDir) {
        consola.info(`  Root: ${ctx.workDir}`);
      }
    }

    consola.info("Run `the-brain daemon restart` to apply the new context.");
  } catch (err) {
    consola.error("Context switch failed:", err);
    process.exit(1);
  }
}

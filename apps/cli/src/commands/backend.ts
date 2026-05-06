/**
 * backend command — Manage pluggable backends via config.json.
 *
 * Usage:
 *   the-brain backend list
 *   the-brain backend set storage @the-brain/storage-postgres
 *   the-brain backend set cleaner ./my-custom-cleaner.ts
 *   the-brain backend unset storage
 */
import { join } from "node:path";
import { readFile, writeFile, access } from "node:fs/promises";
import type { TheBrainConfig } from "@the-brain/core";
import { safeParseConfig } from "@the-brain/core";

const CONFIG_PATH = join(process.env.HOME || "~", ".the-brain", "config.json");
const VALID_SLOTS = ["storage", "cleaner", "scheduler"] as const;
type BackendSlot = (typeof VALID_SLOTS)[number];

export async function backendCommand(
  action: string,
  options: { slot?: string; module?: string }
): Promise<void> {
  const config = await loadConfig();

  switch (action) {
    case "list":
      await listBackends(config);
      break;
    case "set":
      await setBackend(config, options.slot as BackendSlot, options.module ?? "");
      break;
    case "unset":
      await unsetBackend(config, options.slot as BackendSlot);
      break;
    default:
      console.error(`Unknown action: ${action}`);
      console.error("Usage: the-brain backend <list|set|unset> [slot] [module]");
      process.exit(1);
  }
}

async function listBackends(config: TheBrainConfig): Promise<void> {
  const backends = config.backends ?? {};
  console.log("\nCurrent backend configuration:");
  console.log("──────────────────────────────");

  for (const slot of VALID_SLOTS) {
    const value = (backends as Record<string, string | undefined>)[slot];
    const status = value ? `\x1b[32m${value}\x1b[0m` : "\x1b[2m(default)\x1b[0m";
    console.log(`  ${slot.padEnd(12)} ${status}`);
  }

  // Outputs
  const outputs = backends.outputs ?? [];
  if (outputs.length > 0) {
    console.log(`  ${"outputs".padEnd(12)} \x1b[32m${outputs.join(", ")}\x1b[0m`);
  } else {
    console.log(`  ${"outputs".padEnd(12)} \x1b[2m(default: auto-wiki)\x1b[0m`);
  }

  console.log("");
}

async function setBackend(
  config: TheBrainConfig,
  slot: BackendSlot,
  modulePath: string
): Promise<void> {
  if (!VALID_SLOTS.includes(slot)) {
    console.error(`Invalid slot: "${slot}". Valid: ${VALID_SLOTS.join(", ")}`);
    process.exit(1);
  }
  if (!modulePath) {
    console.error("Module path required. Usage: the-brain backend set <slot> <module>");
    process.exit(1);
  }

  if (!config.backends) config.backends = {};
  (config.backends as Record<string, string>)[slot] = modulePath;

  await saveConfig(config);
  console.log(`✅ Backend ${slot} → ${modulePath}`);
  console.log("   Restart daemon to apply: the-brain daemon restart");
}

async function unsetBackend(
  config: TheBrainConfig,
  slot: BackendSlot
): Promise<void> {
  if (!VALID_SLOTS.includes(slot)) {
    console.error(`Invalid slot: "${slot}". Valid: ${VALID_SLOTS.join(", ")}`);
    process.exit(1);
  }

  if (config.backends) {
    delete (config.backends as Record<string, string | undefined>)[slot];
    // Clean up empty backends object
    if (Object.keys(config.backends).length === 0) {
      delete config.backends;
    }
  }

  await saveConfig(config);
  console.log(`✅ Backend ${slot} → (default)`);
  console.log("   Restart daemon to apply: the-brain daemon restart");
}

async function loadConfig(): Promise<TheBrainConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const result = safeParseConfig(JSON.parse(raw));
    if (!result.success) throw new Error(`Config validation failed: ${result.error}`);
    return result.data;
  } catch {
    console.error("Config not found. Run 'the-brain init' first.");
    process.exit(1);
  }
}

async function saveConfig(config: TheBrainConfig): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

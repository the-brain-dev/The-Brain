/**
 * Backend Resolver — loads pluggable backends from config or falls back to defaults.
 *
 * Each backend module must export one of these factory functions:
 *   - StorageBackend:    export function createStorage(opts?: any): StorageBackend
 *   - ContentCleaner:    export function createCleaner(opts?: any): ContentCleanerPlugin
 *   - Scheduler:         export function createScheduler(opts?: any): SchedulerPlugin
 *   - OutputPlugin:      export function createOutput(opts?: any): OutputPlugin
 *
 * Module paths can be:
 *   - npm package:  "@the-brain/storage-postgres"
 *   - local path:   "./my-custom-cleaner.ts"
 *   - file path:    "/Users/me/extensions/my-scheduler.ts"
 */
import type {
  StorageBackend,
  ContentCleanerPlugin,
  SchedulerPlugin,
  OutputPlugin,
} from "./layers/index";
import { createDefaultCleaner } from "./cleaner-default";
import { createSqliteBackend } from "./storage-sqlite";
import { createIntervalScheduler } from "./scheduler-interval";

export interface BackendConfig {
  storage?: string;
  cleaner?: string;
  scheduler?: string;
  outputs?: string[];
}

export async function resolveBackends(
  config: BackendConfig | undefined,
  dbPath: string
): Promise<{
  storage: StorageBackend;
  cleaner: ContentCleanerPlugin;
  scheduler: SchedulerPlugin;
  outputs: OutputPlugin[];
}> {
  const storage = config?.storage
    ? await loadBackend<StorageBackend>(config.storage, "createStorage", dbPath)
    : createSqliteBackend(dbPath);

  const cleaner = config?.cleaner
    ? await loadBackend<ContentCleanerPlugin>(config.cleaner, "createCleaner")
    : createDefaultCleaner();

  const scheduler = config?.scheduler
    ? await loadBackend<SchedulerPlugin>(config.scheduler, "createScheduler")
    : createIntervalScheduler();

  const outputs: OutputPlugin[] = [];
  if (config?.outputs) {
    for (const path of config.outputs) {
      try {
        const output = await loadBackend<OutputPlugin>(path, "createOutput");
        outputs.push(output);
      } catch (err) {
        console.error(`[BackendResolver] Failed to load output "${path}":`, err);
      }
    }
  }

  return { storage, cleaner, scheduler, outputs };
}

async function loadBackend<T>(
  modulePath: string,
  factoryFn: string,
  ...args: unknown[]
): Promise<T> {
  let mod: Record<string, unknown>;

  try {
    // Dynamic import — works for npm packages, relative paths, and absolute paths
    mod = await import(modulePath);
  } catch (err) {
    throw new Error(
      `Cannot load backend "${modulePath}": ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const factory = mod[factoryFn] ?? mod.default?.[factoryFn];
  if (typeof factory !== "function") {
    throw new Error(
      `Backend "${modulePath}" does not export "${factoryFn}" function. ` +
      `Expected: export function ${factoryFn}(...): T`
    );
  }

  return factory(...args) as T;
}

/**
 * Extension Auto-Loader.
 *
 * Scans ~/.the-brain/extensions/ for .ts files and loads them
 * as lightweight plugins. No package.json required.
 *
 * Inspired by pi-mono's .pi/extensions/ system — single-file,
 * auto-discovered, quick to prototype.
 *
 * Extension format:
 *   export default function(brain: BrainAPI) {
 *     brain.hook("selection:evaluate", (ctx) => { ... });
 *     brain.registerCommand("my-cmd", handler);
 *     // Full engine access: brain.storage, brain.scheduler, brain.config
 *   }
 *
 * Usage:
 *   const loader = new ExtensionLoader(hooks, db, storage, scheduler, config);
 *   await loader.loadAll();
 */

import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import type {
  PluginHooks,
  HookEventName,
} from "./types";
import type { BrainDB } from "./db/index";
import type { StorageBackend, SchedulerPlugin } from "./layers/index";
import type { TheBrainConfig } from "./types";

/**
 * API surface exposed to extension scripts.
 * Extensions get full read access to the engine state
 * and can register hooks, commands, and their own servers.
 */
export interface BrainAPI {
  /** Register a hook for any lifecycle event */
  hook(event: HookEventName | string, handler: (...args: unknown[]) => Promise<void> | void): void;

  /** Fire a hook event */
  emit(event: HookEventName | string, ...args: unknown[]): Promise<void>;

  /** Access the database for queries */
  readonly db: BrainDB;

  /** Pluggable storage backend (full CRUD) */
  readonly storage: StorageBackend;

  /** Pluggable task scheduler */
  readonly scheduler: SchedulerPlugin;

  /** Current the-brain configuration */
  readonly config: TheBrainConfig;

  /** Get the extension's own name */
  readonly extensionName: string;

  /** Register a CLI command that extensions can invoke */
  registerCommand(name: string, handler: (args: string[]) => Promise<void> | void): void;

  /**
   * Open an external SQLite database (read-only by default).
   * Uses bun:sqlite — only works when daemon runs under Bun.
   * The caller is responsible for closing the database.
   */
  openDatabase(path: string, readonly?: boolean): Database;
}

export interface ExtensionContext {
  name: string;
  path: string;
  error?: string;
}

/** Registered CLI commands from extensions */
const extensionCommands = new Map<string, (args: string[]) => Promise<void> | void>();

/** Get all commands registered by extensions */
export function getExtensionCommands(): Map<string, (args: string[]) => Promise<void> | void> {
  return extensionCommands;
}

/**
 * Manages auto-loading of lightweight extensions from
 * ~/.the-brain/extensions/ directory.
 */
export class ExtensionLoader {
  private extensionsDir: string;
  private hooks: PluginHooks;
  private db: BrainDB;
  private storage: StorageBackend;
  private scheduler: SchedulerPlugin;
  private config: TheBrainConfig;
  private loaded: Map<string, ExtensionContext> = new Map();

  constructor(
    hooks: PluginHooks,
    db: BrainDB,
    storage: StorageBackend,
    scheduler: SchedulerPlugin,
    config: TheBrainConfig,
    extensionsDir?: string
  ) {
    this.hooks = hooks;
    this.db = db;
    this.storage = storage;
    this.scheduler = scheduler;
    this.config = config;
    this.extensionsDir = extensionsDir ?? join(homedir(), ".the-brain", "extensions");
  }

  /**
   * Load all .ts files from ~/.the-brain/extensions/.
   * Creates the directory if it doesn't exist.
   */
  async loadAll(): Promise<ExtensionContext[]> {
    ExtensionLoader.ensureExtensionsDir(this.extensionsDir);

    // Read enabled extensions from config — extensions are DISABLED by default
    const enabledExtensions: string[] = Array.isArray((this.config as any).extensions)
      ? (this.config as any).extensions
      : [];

    if (enabledExtensions.length === 0) {
      console.log("[ExtensionLoader] No extensions enabled. Add \"extensions\": [\"name\"] to config.json to enable.");
      return [];
    }

    const results: ExtensionContext[] = [];
    const files = readdirSync(this.extensionsDir).filter((f) => f.endsWith(".ts"));

    for (const file of files) {
      const fullPath = join(this.extensionsDir, file);
      const name = file.replace(/\.ts$/, "");

      // Skip sample.ts
      if (name === "sample") continue;

      // Skip if not in config's enabledExtensions list
      if (!enabledExtensions.includes(name)) {
        console.log(`[ExtensionLoader] Skipping \"${name}\" — not in config's extensions list. Add \"${name}\" to config.json to enable.`);
        continue;
      }

      try {
        const ctx = await this.loadExtension(name, fullPath);
        results.push(ctx);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        const ctx: ExtensionContext = { name, path: fullPath, error: errMsg };
        results.push(ctx);
        this.loaded.set(name, ctx);
        console.error(`[ExtensionLoader] Failed to load "${name}": ${errMsg}`);
      }
    }

    return results;
  }

  /**
   * Load a single extension file.
   */
  async loadExtension(name: string, path: string): Promise<ExtensionContext> {
    const ctx: ExtensionContext = { name, path };
    this.loaded.set(name, ctx);

    // Read and transpile the extension
    const source = readFileSync(path, "utf-8");

    // Create BrainAPI for this extension
    const brain: BrainAPI = {
      hook: (event, handler) => {
        this.hooks.hook(event as HookEventName, handler);
      },
      emit: async (event, ...args) => {
        await this.hooks.callHook(event as HookEventName, ...args);
      },
      get db() { return this._db; },
      _db: this.db,
      get storage() { return this._storage; },
      _storage: this.storage,
      get scheduler() { return this._scheduler; },
      _scheduler: this.scheduler,
      get config() { return this._config; },
      _config: this.config,
      extensionName: name,
      registerCommand(cmdName: string, handler: (args: string[]) => Promise<void> | void) {
        extensionCommands.set(cmdName, handler);
        console.log(`[ExtensionLoader] Registered command: "${cmdName}" (from ${name})`);
      },

      openDatabase(dbPath: string, readonly: boolean = true): Database {
        return new Database(dbPath, { readonly });
      },
    };

    // Execute the extension module using a simple eval-based approach.
    let extensionFn: (brain: BrainAPI) => void | Promise<void>;

    try {
      const exportMatch = source.match(
        /export\s+default\s+(?:async\s+)?function\s*\(([^)]*)\)\s*\{([\s\S]*)\}/m
      );

      if (exportMatch) {
        const params = exportMatch[1].trim();
        const body = exportMatch[2].trim();
        const isAsync = source.includes("export default async function");
        const fnBody = isAsync
          ? `return (async function(${params}) { ${body} })`
          : `return (function(${params}) { ${body} })`;
        extensionFn = new Function(fnBody)();
      } else {
        const arrowMatch = source.match(
          /export\s+default\s+(?:async\s+)?\(([^)]*)\)\s*=>\s*\{([\s\S]*)\}/m
        );

        if (arrowMatch) {
          const params = arrowMatch[1].trim();
          const body = arrowMatch[2].trim();
          const isAsync = source.includes("export default async");
          const fnBody = isAsync
            ? `return async (${params}) => { ${body} }`
            : `return (${params}) => { ${body} }`;
          extensionFn = new Function(fnBody)();
        } else {
          throw new Error(
            `Extension "${name}" does not export a default function. ` +
            `Use: export default function(brain) { ... } or export default (brain) => { ... }`
          );
        }
      }
    } catch (e) {
      throw new Error(
        `Failed to parse extension "${name}": ${e instanceof Error ? e.message : String(e)}`
      );
    }

    if (typeof extensionFn !== "function") {
      throw new Error(`Extension "${name}" does not export a default function`);
    }

    await extensionFn(brain);

    console.log(`[ExtensionLoader] Loaded extension: ${name}`);
    return ctx;
  }

  /** Reload a specific extension by name. */
  async reload(name: string): Promise<ExtensionContext> {
    const existing = this.loaded.get(name);
    if (!existing) {
      throw new Error(`Extension "${name}" not found`);
    }
    return this.loadExtension(name, existing.path);
  }

  /** Get list of all loaded extensions. */
  list(): ExtensionContext[] {
    return Array.from(this.loaded.values());
  }

  /** Get a specific extension context. */
  get(name: string): ExtensionContext | undefined {
    return this.loaded.get(name);
  }

  /** Ensure the extensions directory exists with a sample extension. */
  static ensureExtensionsDir(dir?: string): string {
    const extDir = dir ?? join(homedir(), ".the-brain", "extensions");

    if (!existsSync(extDir)) {
      mkdirSync(extDir, { recursive: true });

      const sample = `/**
 * Sample the-brain extension.
 *
 * Extensions are auto-loaded from ~/.the-brain/extensions/.
 * Export a default function that receives the BrainAPI.
 *
 * Available BrainAPI:
 *   - brain.hook(event, handler)    — subscribe to lifecycle events
 *   - brain.emit(event, ...args)    — fire hook events
 *   - brain.db                      — database queries
 *   - brain.storage                 — full CRUD access
 *   - brain.scheduler               — schedule recurring tasks
 *   - brain.config                  — read the-brain config
 *   - brain.registerCommand(name, fn) — add CLI commands
 */

export default function(brain) {
  // Example: log every new interaction
  brain.hook("onInteraction", async (ctx) => {
    console.log(\`[sample] New interaction: \${ctx.interaction.prompt.slice(0, 80)}...\`);
  });

  // Example: scheduled cleanup every hour
  brain.scheduler.schedule("sample-cleanup", 3600000, async () => {
    const stats = await brain.storage.getStats();
    console.log(\`[sample] Hourly stats: \${stats.memories} memories\`);
  });
}
`;
      writeFileSync(join(extDir, "sample.ts"), sample);
    }

    return extDir;
  }
}

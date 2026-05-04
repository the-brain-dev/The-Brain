/**
 * Extension Auto-Loader.
 *
 * Scans ~/.my-brain/extensions/ for .ts files and loads them
 * as lightweight plugins. No package.json required.
 *
 * Inspired by pi-mono's .pi/extensions/ system — single-file,
 * auto-discovered, quick to prototype.
 *
 * Extension format:
 *   export default function(brain: BrainAPI) {
 *     brain.hook("selection:evaluate", (ctx) => { ... });
 *     brain.registerCommand("my-cmd", { ... });
 *   }
 *
 * Usage:
 *   const loader = new ExtensionLoader(hooks, db);
 *   await loader.loadAll();
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  PluginHooks,
  HookEventName,
  MemoryFragment,
  ConsolidationResult,
} from "./types";
import type { BrainDB } from "./db/index";

/**
 * API surface exposed to extension scripts.
 */
export interface BrainAPI {
  /** Register a hook for any event */
  hook(event: HookEventName, handler: (...args: any[]) => Promise<void> | void): void;

  /** Fire a hook event */
  emit(event: HookEventName, ...args: any[]): Promise<void>;

  /** Access the database for queries (read-only in extensions) */
  readonly db: BrainDB;

  /** Get the extension's own name */
  readonly extensionName: string;
}

export interface ExtensionContext {
  name: string;
  path: string;
  error?: string;
}

/**
 * Manages auto-loading of lightweight extensions from
 * ~/.my-brain/extensions/ directory.
 */
export class ExtensionLoader {
  private extensionsDir: string;
  private hooks: PluginHooks;
  private db: BrainDB;
  private loaded: Map<string, ExtensionContext> = new Map();

  constructor(
    hooks: PluginHooks,
    db: BrainDB,
    extensionsDir?: string
  ) {
    this.hooks = hooks;
    this.db = db;
    this.extensionsDir = extensionsDir ?? join(homedir(), ".my-brain", "extensions");
  }

  /**
   * Load all .ts files from ~/.my-brain/extensions/.
   * Creates the directory if it doesn't exist.
   */
  async loadAll(): Promise<ExtensionContext[]> {
    if (!existsSync(this.extensionsDir)) {
      return [];
    }

    const results: ExtensionContext[] = [];
    const files = readdirSync(this.extensionsDir).filter((f) => f.endsWith(".ts"));

    for (const file of files) {
      const fullPath = join(this.extensionsDir, file);
      const name = file.replace(/\.ts$/, "");

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
        this.hooks.hook(event, handler);
      },
      emit: async (event, ...args) => {
        await this.hooks.callHook(event, ...args);
      },
      get db() {
        // Direct DB access for read queries
        return this._db;
      },
      _db: this.db,
      extensionName: name,
    };

    // Execute the extension module using a simple eval-based approach.
    // This works for TypeScript-like syntax (top-level export default, arrow functions,
    // async/await) that Bun's runtime supports natively.
    let extensionFn: (brain: BrainAPI) => void | Promise<void>;

    try {
      // Wrap source to extract the default export.
      // Supports: export default function(...) { ... }
      //           export default async function(...) { ... }
      //           export default (brain) => { ... }
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
        // Try arrow function: export default (brain) => { ... }
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
          // No recognizable export pattern — this is an error
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

    // Call the extension
    await extensionFn(brain);

    console.log(`[ExtensionLoader] Loaded extension: ${name}`);
    return ctx;
  }

  /**
   * Reload a specific extension by name.
   */
  async reload(name: string): Promise<ExtensionContext> {
    // Unload first (remove hooks — extensions are stateless, so just reload)
    const existing = this.loaded.get(name);
    if (!existing) {
      throw new Error(`Extension "${name}" not found`);
    }

    // Reload the file
    return this.loadExtension(name, existing.path);
  }

  /**
   * Get list of all loaded extensions.
   */
  list(): ExtensionContext[] {
    return Array.from(this.loaded.values());
  }

  /**
   * Get a specific extension context.
   */
  get(name: string): ExtensionContext | undefined {
    return this.loaded.get(name);
  }

  /**
   * Ensure the extensions directory exists with a sample extension.
   */
  static ensureExtensionsDir(dir?: string): string {
    const extDir = dir ?? join(homedir(), ".my-brain", "extensions");

    if (!existsSync(extDir)) {
      const { mkdirSync } = require("node:fs");
      mkdirSync(extDir, { recursive: true });

      // Create a sample extension as starting template
      const sample = `/**
 * Sample my-brain extension.
 *
 * Extensions are auto-loaded from ~/.my-brain/extensions/.
 * Export a default function that receives the BrainAPI.
 *
 * Available BrainAPI:
 *   - brain.hook(event, handler)  — subscribe to lifecycle events
 *   - brain.emit(event, ...args)  — fire hook events
 *   - brain.db                    — read-only database access
 */

export default function(brain) {
  // Example: log every time a new memory interaction is detected
  brain.hook("onInteraction", async (ctx) => {
    console.log(\`[sample] New interaction: \${ctx.interaction.prompt.slice(0, 80)}...\`);
  });

  // Example: track consolidation stats
  brain.hook("consolidate:complete", async (ctx) => {
    const { fragmentsPromoted, fragmentsDiscarded } = ctx.results;
    console.log(\`[sample] Consolidation: +\${fragmentsPromoted} -\${fragmentsDiscarded}\`);
  });
}
`;
      const { writeFileSync } = require("node:fs");
      writeFileSync(join(extDir, "sample.ts"), sample);
    }

    return extDir;
  }
}

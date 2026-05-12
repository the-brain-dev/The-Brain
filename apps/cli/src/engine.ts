/**
 * Daemon engine — extracted init logic (testable).
 * Multi-project aware: loads config.json, creates ProjectManager,
 * routes data to active project or global brain.
 */
import { BrainDB, PluginManager, createHookSystem, LayerRouter, HookEvent, MemoryLayer, ProjectManager, resolveBackends, ExtensionLoader, safeParseConfig } from "@the-brain-dev/core";
import type { PromptContext, InteractionContext, ConsolidationContext, TheBrainConfig, ContentCleanerPlugin, StorageBackend, SchedulerPlugin, OutputPlugin, BackendConfig, PipelineConfig } from "@the-brain-dev/core";
import { consola } from "consola";
import { join } from "node:path";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";

const CONFIG_DIR = join(process.env.HOME || "~", ".the-brain");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const PID_FILE = join(CONFIG_DIR, "daemon.pid");

export function getConfigDir(): string {
  return join(process.env.HOME || "~", ".the-brain");
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export function getPidFile(): string {
  return join(getConfigDir(), "daemon.pid");
}

export interface DaemonConfig {
  pollIntervalMs: number;
  server?: {
    mode: "local" | "remote";
    bindAddress: string;
    authToken?: string;
    port?: number;
  };
}

export interface DaemonEngine {
  /** Direct DB access (legacy — use storage instead) */
  db: BrainDB;
  /** Pluggable storage backend (SQLite default) */
  storage: StorageBackend;
  /** Pluggable content cleaner */
  contentCleaner: ContentCleanerPlugin;
  /** Pluggable task scheduler */
  scheduler: SchedulerPlugin;
  /** Registered output plugins */
  outputPlugins: OutputPlugin[];
  projectManager: ProjectManager;
  hooks: ReturnType<typeof createHookSystem>;
  pluginManager: PluginManager;
  layerRouter: LayerRouter;
  /** Full brain configuration (includes mlx, wiki schedules) */
  brainConfig: TheBrainConfig;
  config: DaemonConfig;
  running: boolean;
  interactionCount: number;
  lastConsolidation: number;
  activeProject: string | null;
  cleanup: () => Promise<void>;
}

// ── Config loading ──────────────────────────────────────────────

async function loadConfig(): Promise<TheBrainConfig> {
  try {
    const raw = await readFile(getConfigPath(), "utf-8");
    const parsed = JSON.parse(raw);
    const result = safeParseConfig(parsed);
    if (result.success) return result.data;
    consola.warn(`Config validation warnings: ${result.error}`);
    // Fall through to defaults
    throw new Error(`Invalid config: ${result.error}`);
  } catch {
    // No config file — create minimal default
    return {
      plugins: [],
      daemon: { pollIntervalMs: 30000, logDir: join(getConfigDir(), "logs") },
      database: { path: join(getConfigDir(), "global", "brain.db") },
      mlx: { enabled: false, loraOutputDir: join(getConfigDir(), "global", "lora-checkpoints") },
      wiki: { enabled: true, outputDir: join(getConfigDir(), "global", "wiki") },
      server: { mode: "local" as const, bindAddress: "127.0.0.1" },
      activeContext: "global",
      contexts: {},
    };
  }
}

// ── Plugin registry ──────────────────────────────────────────────

export interface PluginEntry {
  name: string;
  type: "harvester" | "layer" | "output" | "training";
  configKey?: string;        // key in pipeline.harvesters or pipeline.outputs
  layerKey?: "instant" | "selection" | "deep";
  importPath: string;
  factory: string;            // "default" for default export, or named factory function
  createArgs?: string[];      // arg names: "db" means pass db instance
  always?: boolean;           // true = always load regardless of pipeline
}

/** Shape of a loaded plugin instance (before PluginManager registration). */
interface PluginInstance {
  definition?: unknown;
  instance?: unknown;
  asOutputPlugin?: () => OutputPlugin;
}

export const PLUGIN_REGISTRY: PluginEntry[] = [
  // ── Harvesters ──
  { name: "cursor", type: "harvester", configKey: "cursor", importPath: "@the-brain-dev/plugin-harvester-cursor", factory: "default" },
  { name: "claude", type: "harvester", configKey: "claude", importPath: "@the-brain-dev/plugin-harvester-claude", factory: "default" },
  { name: "hermes", type: "harvester", configKey: "hermes", importPath: "@the-brain-dev/plugin-harvester-hermes", factory: "default" },
  { name: "lm-eval", type: "harvester", configKey: "lm-eval", importPath: "@the-brain-dev/plugin-harvester-lm-eval", factory: "default" },
  { name: "windsurf", type: "harvester", configKey: "windsurf", importPath: "@the-brain-dev/plugin-harvester-windsurf", factory: "default" },
  { name: "gemini", type: "harvester", configKey: "gemini", importPath: "@the-brain-dev/plugin-harvester-gemini", factory: "default" },
  // ── Memory layers ──
  { name: "graph-memory", type: "layer", layerKey: "instant", importPath: "@the-brain-dev/plugin-graph-memory", factory: "createGraphMemoryPlugin", createArgs: ["db"] },
  { name: "spm-curator", type: "layer", layerKey: "selection", importPath: "@the-brain-dev/plugin-spm-curator", factory: "createSpmCurator" },
  { name: "identity-anchor", type: "layer", layerKey: "deep", importPath: "@the-brain-dev/plugin-identity-anchor", factory: "createIdentityAnchorPlugin" },
  // ── Outputs ──
  { name: "auto-wiki", type: "output", configKey: "auto-wiki", importPath: "@the-brain-dev/plugin-auto-wiki", factory: "createAutoWikiPlugin", createArgs: ["db"] },
  // ── Training ──
  { name: "mlx", type: "training", importPath: "@the-brain-dev/trainer-local-mlx", factory: "createMlxTrainer" },
  // ── Always-loaded (no pipeline toggle) ──
  { name: "data-curator", type: "layer", importPath: "@the-brain-dev/plugin-data-curator", factory: "createDataCurator", always: true },
];

export function isPluginEnabled(entry: PluginEntry, pipeline: PipelineConfig | undefined): boolean {
  if (entry.always) return true;
  if (!pipeline) return true; // Backward compat: no pipeline = everything enabled

  if (entry.type === "harvester" && entry.configKey) {
    return pipeline.harvesters.includes(entry.configKey);
  }
  if (entry.type === "layer" && entry.layerKey) {
    return pipeline.layers[entry.layerKey];
  }
  if (entry.type === "output" && entry.configKey) {
    return pipeline.outputs.includes(entry.configKey);
  }
  if (entry.type === "training") {
    if (entry.name === "mlx") return pipeline.training.mlx;
  }
  return true;
}

async function loadPlugins(
  db: BrainDB,
  pipeline?: PipelineConfig
) {
  const loaded: Record<string, PluginInstance> = {};

  for (const entry of PLUGIN_REGISTRY) {
    if (!isPluginEnabled(entry, pipeline)) {
      consola.info(`  Skipping ${entry.name} (disabled in pipeline)`);
      continue;
    }

    try {
      const mod = await import(entry.importPath);
      const factoryFn = entry.factory === "default"
        ? (mod.default ?? mod)
        : mod[entry.factory];

      if (entry.createArgs) {
        const args = entry.createArgs.map(arg => arg === "db" ? db : undefined);
        loaded[entry.name] = factoryFn(...args) as PluginInstance;
      } else {
        loaded[entry.name] = factoryFn() as PluginInstance;
      }
    } catch (err) {
      consola.warn(`  Plugin ${entry.name} failed to load: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return loaded;
}

// ── Event handlers (shared state) ──────────────────────────────

function registerHandlers(engine: DaemonEngine) {
  const { hooks, layerRouter } = engine;

  hooks.hook(HookEvent.DAEMON_STOP, async () => {
    engine.running = false;
    consola.info("Daemon stop signal received");
  });

  hooks.hook(HookEvent.HARVESTER_NEW_DATA, async (ctx: InteractionContext) => {
    engine.interactionCount++;
    const prompt = ctx.interaction.prompt.slice(0, 80);
    const source = ctx.interaction.source;
    consola.debug(`#${engine.interactionCount} [${source}] "${prompt}..."`);

    // Resolve target DB based on project tag from harvester
    const projectName = (ctx.interaction.metadata as Record<string, unknown> | undefined)?.project as string | undefined;
    const targetDB = await engine.projectManager.resolveDB(projectName);

    await targetDB.insertMemory({
      id: `int-${ctx.interaction.id}`,
      layer: MemoryLayer.INSTANT,
      content: `Prompt: ${ctx.interaction.prompt}\nResponse: ${ctx.interaction.response.slice(0, 500)}`,
      timestamp: ctx.interaction.timestamp,
      source: ctx.interaction.source,
      metadata: {
        ...(ctx.interaction.metadata || {}),
        project: projectName || engine.activeProject,
      },
    });

    const promptCtx: PromptContext = {
      prompt: ctx.interaction.prompt,
      injected: [],
      metadata: { project: projectName || engine.activeProject },
      inject(text: string) { this.injected.push(text); },
    };
    await layerRouter.runInstant(promptCtx);
    await hooks.callHook(HookEvent.BEFORE_PROMPT, promptCtx);

    const selectionResults = await layerRouter.runSelection(ctx);
    for (const frag of selectionResults.promoted) {
      await targetDB.insertMemory({
        ...frag,
        metadata: { ...(frag.metadata || {}), project: projectName || engine.activeProject },
      });
    }

    await hooks.callHook(HookEvent.AFTER_RESPONSE, {
      id: ctx.interaction.id,
      timestamp: ctx.interaction.timestamp,
      prompt: ctx.interaction.prompt,
      response: ctx.interaction.response,
      source: ctx.interaction.source,
      metadata: {
        ...(ctx.interaction.metadata || {}),
        project: projectName || engine.activeProject,
      },
    });
  });
}

// ── Initialization (testable) ──────────────────────────────────

export async function initDaemon(config: DaemonConfig): Promise<DaemonEngine> {
  await mkdir(getConfigDir(), { recursive: true });
  await mkdir(join(getConfigDir(), "global"), { recursive: true });

  // Check PID
  try {
    const pidStr = await readFile(getPidFile(), "utf-8");
    const pid = parseInt(pidStr);
    try {
      process.kill(pid, 0);
      consola.warn(`Daemon already running (PID: ${pid})`);
      throw new DaemonAlreadyRunningError(pid);
    } catch (err: unknown) {
      if (err instanceof DaemonAlreadyRunningError) throw err;
      await unlink(getPidFile()).catch(() => {});
    }
  } catch (err: unknown) {
    if (err instanceof DaemonAlreadyRunningError) throw err;
    // No PID file, ok
  }

  // Load config
  const brainConfig = await loadConfig();
  const projectManager = new ProjectManager(brainConfig, getConfigDir());

  // Get active DB
  const db = await projectManager.getActiveDB();
  const activeProject = projectManager.getActiveProjectName();

  // ── Resolve backends from config (or defaults) ────────────
  const backends = await resolveBackends(
    brainConfig.backends,
    join(getConfigDir(), "global", "brain.db")
  );
  consola.info(`  Storage: ${brainConfig.backends?.storage ?? "sqlite (default)"}`);
  consola.info(`  Cleaner: ${brainConfig.backends?.cleaner ?? "default"}`);
  consola.info(`  Scheduler: ${brainConfig.backends?.scheduler ?? "interval (default)"}`);
  if (brainConfig.backends?.outputs) {
    for (const path of brainConfig.backends.outputs) {
      consola.info(`  Output: ${path}`);
    }
  }

  consola.info(`Active context: ${activeProject || "global"}`);
  if (activeProject) {
    const ctx = projectManager.getActiveContext();
    if (ctx) {
      consola.info(`  DB: ${ctx.dbPath}`);
    }
  }

  const hooks = createHookSystem();
  const pluginManager = new PluginManager(hooks);
  const layerRouter = new LayerRouter();

  consola.info("Loading plugins...");
  const plugins = await loadPlugins(db, brainConfig.pipeline);

  // ── Register loaded plugins with PluginManager ──
  for (const entry of PLUGIN_REGISTRY) {
    if (!isPluginEnabled(entry, brainConfig.pipeline)) continue;
    const plugin = plugins[entry.name];
    if (!plugin) continue;

    try {
      // MLX trainer: separate handling for Apple Silicon check
      if (entry.name === "mlx") {
        try {
          await pluginManager.load(plugin);
          consola.info("  MLX trainer loaded");
        } catch {
          consola.info("  MLX trainer skipped (requires Apple Silicon + mlx-lm)");
        }
        continue;
      }

      // Harvesters don't have .definition wrapper
      if (entry.type === "harvester") {
        await pluginManager.load(plugin);
      } else {
        // Layers/outputs may have .definition
        const def = plugin.definition ?? plugin;
        await pluginManager.load(def);
      }
    } catch (err) {
      consola.warn(`Plugin ${entry.name} failed to load: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Collect output plugins
  const outputPlugins: OutputPlugin[] = [...backends.outputs];
  const autoWiki = plugins["auto-wiki"];
  if (autoWiki?.asOutputPlugin) {
    const wikiOutput = autoWiki.asOutputPlugin();
    outputPlugins.push(wikiOutput);
    consola.info(`  Output plugin: ${wikiOutput.name}`);
  }

  consola.success(`Loaded ${pluginManager.list().length} plugins`);

  // ── Load user extensions (~/.the-brain/extensions/) ──────────
  const extensionLoader = new ExtensionLoader(
    hooks, db, backends.storage, backends.scheduler, brainConfig
  );
  const extResults = await extensionLoader.loadAll();
  if (extResults.length > 0) {
    consola.info(`Loaded ${extResults.length} extension(s):`);
    for (const ext of extResults) {
      const status = ext.error ? `FAILED: ${ext.error}` : "ok";
      consola.info(`  ${ext.name} — ${status}`);
    }
  }

  // ── Initialize TF-IDF vocabulary from existing memories ───────────
  const spmCurator = plugins["spm-curator"];
  if (spmCurator?.instance) {
    const inst = spmCurator.instance as {
      getTfidf(): { getStats(): { vocabSize: number; docCount: number } } | null;
      initTfidfFromTexts(texts: string[]): void;
      finalizeTfidf(): void;
    };
    if (inst.getTfidf()) {
      consola.info("Building TF-IDF vocabulary from existing memories...");
      const allMemories = await db.getAllMemories(2000);
      const texts = allMemories
        .filter(m => m.content && m.content.length > 20)
        .map(m => m.content);
      if (texts.length > 0) {
        inst.initTfidfFromTexts(texts);
        inst.finalizeTfidf();
        const stats = inst.getTfidf()!.getStats();
        consola.info(`  TF-IDF ready: ${stats.vocabSize} terms from ${stats.docCount} documents`);
      } else {
        consola.info("  TF-IDF deferred: no existing memories (will build vocab online)");
      }
    }
  }

  await writeFile(getPidFile(), String(process.pid));

  const engine: DaemonEngine = {
    db,
    storage: backends.storage,
    contentCleaner: backends.cleaner,
    scheduler: backends.scheduler,
    hooks, pluginManager, layerRouter, projectManager,
    brainConfig,
    config,
    running: true,
    interactionCount: 0,
    lastConsolidation: Date.now(),
    activeProject,
    outputPlugins,
    cleanup: async () => {
      engine.running = false;
      await pluginManager.shutdown();
      projectManager.close();
      await unlink(getPidFile()).catch(() => {});
      consola.info("Daemon stopped");
    },
  };

  registerHandlers(engine);

  return engine;
}

export class DaemonAlreadyRunningError extends Error {
  constructor(public readonly pid: number) {
    super(`Daemon already running (PID: ${pid})`);
    this.name = "DaemonAlreadyRunningError";
  }
}

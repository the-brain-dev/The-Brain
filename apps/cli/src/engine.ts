/**
 * Daemon engine — extracted init logic (testable).
 * Multi-project aware: loads config.json, creates ProjectManager,
 * routes data to active project or global brain.
 */
import { BrainDB, PluginManager, createHookSystem, LayerRouter, HookEvent, MemoryLayer, ProjectManager, resolveBackends, ExtensionLoader, safeParseConfig } from "@the-brain/core";
import type { PromptContext, InteractionContext, ConsolidationContext, TheBrainConfig, ContentCleanerPlugin, StorageBackend, SchedulerPlugin, OutputPlugin, BackendConfig } from "@the-brain/core";
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

// ── Plugin loading ─────────────────────────────────────────────

async function loadPlugins(hooks: ReturnType<typeof createHookSystem>, db: BrainDB) {
  const graphMemoryMod = await import("@the-brain/plugin-graph-memory");
  const graphMemory = graphMemoryMod.createGraphMemoryPlugin(db);

  const spmMod = await import("@the-brain/plugin-spm-curator");
  const spmCurator = spmMod.createSpmCurator();

  const curatorMod = await import("@the-brain/plugin-data-curator");
  const dataCurator = curatorMod.createDataCurator();

  const cursorMod = await import("@the-brain/plugin-harvester-cursor");
  const cursorHarvester = cursorMod.default ?? cursorMod;

  const claudeMod = await import("@the-brain/plugin-harvester-claude");
  const claudeHarvester = claudeMod.default ?? claudeMod;

  const identityMod = await import("@the-brain/plugin-identity-anchor");
  const identityAnchor = identityMod.createIdentityAnchorPlugin();

  const wikiMod = await import("@the-brain/plugin-auto-wiki");
  const autoWiki = wikiMod.createAutoWikiPlugin(db);

  const mlxMod = await import("@the-brain/trainer-local-mlx");
  const mlxTrainer = mlxMod.createMlxTrainer();

  const hermesMod = await import("@the-brain/plugin-harvester-hermes");
  const hermesHarvester = hermesMod.default ?? hermesMod;

  const lmEvalMod = await import("@the-brain/plugin-harvester-lm-eval");
  const lmEvalHarvester = lmEvalMod.default ?? lmEvalMod;

  return { graphMemory, spmCurator, dataCurator, cursorHarvester, claudeHarvester, hermesHarvester, lmEvalHarvester, identityAnchor, autoWiki, mlxTrainer };
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
  const plugins = await loadPlugins(hooks, db);

  for (const [name, p] of [
    ["graph-memory", () => pluginManager.load(plugins.graphMemory)],
    ["spm-curator", () => pluginManager.load(plugins.spmCurator.definition)],
    ["harvester-cursor", () => pluginManager.load(plugins.cursorHarvester)],
    ["harvester-claude", () => pluginManager.load(plugins.claudeHarvester)],
    ["identity-anchor", () => pluginManager.load(plugins.identityAnchor)],
    ["auto-wiki", () => pluginManager.load(plugins.autoWiki)],
    ["harvester-hermes", () => pluginManager.load(plugins.hermesHarvester)],
    ["harvester-lm-eval", () => pluginManager.load(plugins.lmEvalHarvester)],
  ] as const) {
    try {
      await p();
    } catch (err) {
      consola.warn(`Plugin ${name} failed to load: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Collect output plugins
  const outputPlugins: OutputPlugin[] = [...backends.outputs];
  const wikiOutput = plugins.autoWiki.asOutputPlugin();
  outputPlugins.push(wikiOutput);
  consola.info(`  Output plugin: ${wikiOutput.name}`);

  try {
    await pluginManager.load(plugins.mlxTrainer);
    consola.info("  MLX trainer loaded");
  } catch {
    consola.info("  MLX trainer skipped (requires Apple Silicon + mlx-lm)");
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
  if (plugins.spmCurator.instance.getTfidf()) {
    consola.info("Building TF-IDF vocabulary from existing memories...");
    const allMemories = await db.getAllMemories(2000);
    const texts = allMemories
      .filter(m => m.content && m.content.length > 20)
      .map(m => m.content);
    if (texts.length > 0) {
      plugins.spmCurator.instance.initTfidfFromTexts(texts);
      plugins.spmCurator.instance.finalizeTfidf();
      const stats = plugins.spmCurator.instance.getTfidf()!.getStats();
      consola.info(`  TF-IDF ready: ${stats.vocabSize} terms from ${stats.docCount} documents`);
    } else {
      consola.info("  TF-IDF deferred: no existing memories (will build vocab online)");
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

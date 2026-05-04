/**
 * Daemon engine — extracted init logic (testable).
 * Multi-project aware: loads config.json, creates ProjectManager,
 * routes data to active project or global brain.
 */
import { BrainDB, PluginManager, createHookSystem, LayerRouter, HookEvent, MemoryLayer, ProjectManager } from "@my-brain/core";
import type { PromptContext, InteractionContext, ConsolidationContext, MyBrainConfig } from "@my-brain/core";
import { consola } from "consola";
import { join } from "node:path";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";

const CONFIG_DIR = join(process.env.HOME || "~", ".my-brain");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const PID_FILE = join(CONFIG_DIR, "daemon.pid");

export function getConfigDir(): string {
  return join(process.env.HOME || "~", ".my-brain");
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export function getPidFile(): string {
  return join(getConfigDir(), "daemon.pid");
}

export interface DaemonConfig {
  pollIntervalMs: number;
}

export interface DaemonEngine {
  db: BrainDB;
  projectManager: ProjectManager;
  hooks: ReturnType<typeof createHookSystem>;
  pluginManager: PluginManager;
  layerRouter: LayerRouter;
  config: DaemonConfig;
  running: boolean;
  interactionCount: number;
  lastConsolidation: number;
  activeProject: string | null;
  cleanup: () => Promise<void>;
}

// ── Config loading ──────────────────────────────────────────────

async function loadConfig(): Promise<MyBrainConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const config: MyBrainConfig = JSON.parse(raw);
    // Ensure multi-project fields exist
    if (!config.activeContext) config.activeContext = "global";
    if (!config.contexts) config.contexts = {};
    return config;
  } catch {
    // No config file — create minimal default
    return {
      plugins: [],
      daemon: { pollIntervalMs: 30000, logDir: join(CONFIG_DIR, "logs") },
      database: { path: join(CONFIG_DIR, "global", "brain.db") },
      mlx: { enabled: false, loraOutputDir: join(CONFIG_DIR, "global", "lora-checkpoints") },
      wiki: { enabled: true, outputDir: join(CONFIG_DIR, "global", "wiki") },
      activeContext: "global",
      contexts: {},
    };
  }
}

// ── Plugin loading ─────────────────────────────────────────────

async function loadPlugins(hooks: ReturnType<typeof createHookSystem>, db: BrainDB) {
  const graphMemoryMod = await import("@my-brain/plugin-graph-memory");
  const graphMemory = graphMemoryMod.createGraphMemoryPlugin(db);

  const spmMod = await import("@my-brain/plugin-spm-curator");
  const spmCurator = spmMod.createSpmCurator();

  const cursorMod = await import("@my-brain/plugin-harvester-cursor");
  const cursorHarvester = (cursorMod.default || cursorMod) as any;

  const claudeMod = await import("@my-brain/plugin-harvester-claude");
  const claudeHarvester = (claudeMod.default || claudeMod) as any;

  const identityMod = await import("@my-brain/plugin-identity-anchor");
  const identityAnchor = identityMod.createIdentityAnchorPlugin();

  const wikiMod = await import("@my-brain/plugin-auto-wiki");
  const autoWiki = wikiMod.createAutoWikiPlugin(db);

  const mlxMod = await import("@my-brain/trainer-local-mlx");
  const mlxTrainer = mlxMod.createMlxTrainer();

  return { graphMemory, spmCurator, cursorHarvester, claudeHarvester, identityAnchor, autoWiki, mlxTrainer };
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
    const projectName = (ctx.interaction as any).project;
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
  await mkdir(CONFIG_DIR, { recursive: true });
  await mkdir(join(CONFIG_DIR, "global"), { recursive: true });

  // Check PID
  try {
    const pidStr = await readFile(PID_FILE, "utf-8");
    const pid = parseInt(pidStr);
    try {
      process.kill(pid, 0);
      consola.warn(`Daemon already running (PID: ${pid})`);
      throw new DaemonAlreadyRunningError(pid);
    } catch (err: unknown) {
      if (err instanceof DaemonAlreadyRunningError) throw err;
      await unlink(PID_FILE).catch(() => {});
    }
  } catch (err: unknown) {
    if (err instanceof DaemonAlreadyRunningError) throw err;
    // No PID file, ok
  }

  // Load config
  const brainConfig = await loadConfig();
  const projectManager = new ProjectManager(brainConfig, CONFIG_DIR);

  // Get active DB
  const db = await projectManager.getActiveDB();
  const activeProject = projectManager.getActiveProjectName();

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

  await pluginManager.load(plugins.graphMemory);
  await pluginManager.load(plugins.spmCurator.definition);
  await pluginManager.load(plugins.cursorHarvester);
  await pluginManager.load(plugins.claudeHarvester);
  await pluginManager.load(plugins.identityAnchor);
  await pluginManager.load(plugins.autoWiki);

  try {
    await pluginManager.load(plugins.mlxTrainer);
    consola.info("  MLX trainer loaded");
  } catch {
    consola.info("  MLX trainer skipped (requires Apple Silicon + mlx-lm)");
  }

  consola.success(`Loaded ${pluginManager.list().length} plugins`);

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

  await writeFile(PID_FILE, String(process.pid));

  const engine: DaemonEngine = {
    db, hooks, pluginManager, layerRouter, projectManager,
    config,
    running: true,
    interactionCount: 0,
    lastConsolidation: Date.now(),
    activeProject,
    cleanup: async () => {
      engine.running = false;
      await pluginManager.shutdown();
      projectManager.close();
      await unlink(PID_FILE).catch(() => {});
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

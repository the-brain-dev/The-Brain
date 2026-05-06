/**
 * init command — Initialize the-brain database, config, and project contexts
 */
import { consola } from "consola";
import { mkdir, writeFile, access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BrainDB, generateAuthToken, AuthDB, UserRole, safeParseConfig } from "@the-brain/core";
import type { TheBrainConfig, ProjectContext } from "@the-brain/core";

const CONFIG_DIR = join(process.env.HOME || "~", ".the-brain");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const DEFAULT_CONFIG: TheBrainConfig = {
  plugins: [
    { name: "@the-brain/plugin-graph-memory", enabled: true },
    { name: "@the-brain/plugin-spm-curator", enabled: true, config: { threshold: 0.30 } },
    { name: "@the-brain/plugin-harvester-cursor", enabled: true },
    { name: "@the-brain/plugin-identity-anchor", enabled: true },
    { name: "@the-brain/plugin-auto-wiki", enabled: true, config: { schedule: "0 9 * * 0" } },
  ],
  daemon: {
    pollIntervalMs: 30000,
    logDir: join(CONFIG_DIR, "logs"),
  },
  database: {
    path: join(CONFIG_DIR, "global", "brain.db"),
  },
  mlx: {
    enabled: true,
    modelPath: "mlx-community/Meta-Llama-3.1-8B-Instruct-4bit",
    loraOutputDir: join(CONFIG_DIR, "global", "lora-checkpoints"),
    schedule: "0 2 * * *",
  },
  wiki: {
    enabled: true,
    outputDir: join(CONFIG_DIR, "global", "wiki"),
    schedule: "0 9 * * 0",
  },
  server: {
    mode: "local" as const,
    bindAddress: "127.0.0.1",
  },
  activeContext: "global",
  contexts: {},
};

export async function initCommand(options: {
  force?: boolean;
  dbPath?: string;
  project?: string;
  workDir?: string;
  label?: string;
  remote?: boolean;
  team?: boolean;
}) {
  consola.start("Initializing the-brain...");

  try {
    // Create directories
    await mkdir(CONFIG_DIR, { recursive: true });
    await mkdir(join(CONFIG_DIR, "logs"), { recursive: true });
    await mkdir(join(CONFIG_DIR, "global"), { recursive: true });

    // Load or create config
    let config: TheBrainConfig;
    let configExists = false;
    try {
      await access(CONFIG_PATH);
      const raw = await readFile(CONFIG_PATH, "utf-8");
      const parsed = safeParseConfig(JSON.parse(raw));
      config = parsed.success ? parsed.data : { ...DEFAULT_CONFIG };
      configExists = parsed.success;

      // Upgrade old configs that don't have multi-project fields
      if (!config.activeContext) config.activeContext = "global";
      if (!config.contexts) config.contexts = {};
    } catch {
      config = { ...DEFAULT_CONFIG };
    }

    // ── Remote mode ────────────────────────────────────
    if (options.remote) {
      const token = generateAuthToken();
      config.server = {
        mode: "remote",
        bindAddress: "0.0.0.0",
        authToken: token,
        port: config.server?.port,
        mcpPort: config.server?.mcpPort,
      };
      consola.info("Remote mode enabled — auth token generated");
      consola.info(`  Token: ${token}`);
      consola.info("  Set this on your client: export THE_BRAIN_AUTH_TOKEN=<token>");
    }

    // ── Team mode ──────────────────────────────────────
    let teamAdminToken = "";
    if (options.team) {
      // Set server mode to team (enables multi-user auth)
      config.server = {
        mode: "team",
        bindAddress: "0.0.0.0",
        authToken: undefined, // Team mode uses per-user tokens, not single shared token
        port: config.server?.port,
        mcpPort: config.server?.mcpPort,
      };

      // Initialize auth database with default admin user
      const authDbPath = join(CONFIG_DIR, "auth.db");
      const authDB = new AuthDB(authDbPath);

      const adminUser = await authDB.createUser(
        "admin",
        "Administrator",
        UserRole.ADMIN,
        [], // No project restrictions — admin has full access
      );

      const adminToken = await authDB.createToken(adminUser.id, "Initial admin token");
      teamAdminToken = adminToken.token;

      consola.info("Team mode enabled — multi-user auth active");
      consola.info(`  Default admin user: ${adminUser.name}`);
      consola.info(`  Admin token: ${adminToken.token}`);
      consola.info("  Manage users: the-brain user add|list|remove|token");

      authDB.close();
    }

    // Override database path if specified
    if (options.dbPath) {
      // Prevent path traversal in user-supplied dbPath
      if (options.dbPath.includes("..")) {
        consola.error("Invalid dbPath: path traversal not allowed.");
        process.exit(1);
      }
      config.database.path = options.dbPath;
    }

    // ── Project context ──────────────────────────────────
    if (options.project) {
      const projectName = options.project;
      const projectDir = join(CONFIG_DIR, "projects", projectName);
      const projectDbPath = join(projectDir, "brain.db");

      const projectCtx: ProjectContext = {
        name: projectName,
        label: options.label ?? projectName,
        dbPath: projectDbPath,
        wikiDir: join(projectDir, "wiki"),
        loraDir: join(projectDir, "lora-checkpoints"),
        workDir: options.workDir,
        createdAt: Date.now(),
        lastActive: Date.now(),
      };

      config.contexts[projectName] = projectCtx;
      config.activeContext = projectName;

      // Create project directories
      await mkdir(projectDir, { recursive: true });
      await mkdir(projectCtx.wikiDir, { recursive: true });
      if (projectCtx.loraDir) {
        await mkdir(projectCtx.loraDir, { recursive: true });
      }

      // Initialize project DB
      const pdb = new BrainDB(projectDbPath);
      const pstats = await pdb.getStats();
      consola.success(`Project "${projectName}" database ready (${pstats.sessions} sessions)`);
      pdb.close();
    }

    // Initialize global DB (always)
    await mkdir(join(config.database.path, ".."), { recursive: true });
    const globalDbPath = config.database.path;
    const gdb = new BrainDB(globalDbPath);
    const gstats = await gdb.getStats();
    consola.info(`Global database ready (${gstats.sessions} sessions, ${gstats.memories} memories)`);
    gdb.close();

    // Save config
    await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
    consola.success(`Config written to ${CONFIG_PATH}`);

    // Wiki directory for active context
    const activeCtx = config.activeContext === "global"
      ? null
      : config.contexts[config.activeContext];
    const activeWikiDir = activeCtx?.wikiDir ?? config.wiki.outputDir;
    await mkdir(activeWikiDir, { recursive: true });

    const boxLines = [
      `🧠 the-brain initialized successfully!`,
      ``,
      `  Config:  ${CONFIG_PATH}`,
      `  Active:  ${config.activeContext}`,
      `  Global:  ${globalDbPath}`,
    ];

    if (options.project) {
      const ctx = config.contexts[options.project];
      boxLines.push(
        ``,
        `  Project "${options.project}":`,
        `    DB:     ${ctx.dbPath}`,
        `    Wiki:   ${ctx.wikiDir}`,
        `    LoRA:   ${ctx.loraDir}`,
      );
    }

    if (config.server?.mode === "remote") {
      boxLines.push(
        ``,
        `🔑 Auth token (save this!):`,
        `  ${config.server.authToken}`,
        ``,
        `Client setup:`,
        `  export THE_BRAIN_REMOTE_URL="http://<server-ip>:${config.server.port ?? 9420}"`,
        `  export THE_BRAIN_AUTH_TOKEN="${config.server.authToken}"`,
      );
    }

    if (config.server?.mode === "team") {
      boxLines.push(
        ``,
        `👥 Team mode — multi-user auth enabled`,
        ``,
        `Admin token (save this!):`,
        `  ${teamAdminToken}`,
        ``,
        `Manage your team:`,
        `  the-brain user add --name <user> --project <project> [--role admin|contributor|observer]`,
        `  the-brain user list`,
        `  the-brain user token --name <user>`,
        ``,
        `Client setup (per-user):`,
        `  export THE_BRAIN_REMOTE_URL="http://<server-ip>:${config.server?.port ?? 9420}"`,
        `  export THE_BRAIN_AUTH_TOKEN="<user-specific-token>"`,
      );
    }
    boxLines.push(
      ``,
      `Next steps:`,
      `  the-brain daemon start     Start the background daemon`,
      `  the-brain inspect --stats  Check your brain's health`,
      `  the-brain switch-context --project <name>  Switch active project`,
    );

    consola.box(boxLines.join("\n"));
  } catch (err) {
    consola.error("Initialization failed:", err);
    process.exit(1);
  }
}

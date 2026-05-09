/**
 * init command — Initialize the-brain database, config, and project contexts
 */
import { consola } from "consola";
import { mkdir, writeFile, access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BrainDB, generateAuthToken, AuthDB, UserRole, safeParseConfig } from "@the-brain/core";
import type { TheBrainConfig, ProjectContext } from "@the-brain/core";

function getConfigDir() {
  return join(process.env.HOME || "~", ".the-brain");
}
function getConfigPath() {
  return join(getConfigDir(), "config.json");
}

function getDefaultConfig(): TheBrainConfig {
  const brainDir = getConfigDir();
  return {
  plugins: [
    { name: "@the-brain/plugin-graph-memory", enabled: true },
    { name: "@the-brain/plugin-spm-curator", enabled: true, config: { threshold: 0.30 } },
    { name: "@the-brain/plugin-harvester-cursor", enabled: true },
    { name: "@the-brain/plugin-identity-anchor", enabled: true },
    { name: "@the-brain/plugin-auto-wiki", enabled: true, config: { schedule: "0 9 * * 0" } },
  ],
  daemon: {
    pollIntervalMs: 30000,
    logDir: join(brainDir, "logs"),
  },
  database: {
    path: join(brainDir, "global", "brain.db"),
  },
  mlx: {
    enabled: false,
    modelPath: "mlx-community/Meta-Llama-3.1-8B-Instruct-4bit",
    loraOutputDir: join(brainDir, "global", "lora-checkpoints"),
    schedule: "0 2 * * *",
  },
  wiki: {
    enabled: true,
    outputDir: join(brainDir, "global", "wiki"),
    schedule: "0 9 * * 0",
  },
  server: {
    mode: "local" as const,
    bindAddress: "127.0.0.1",
  },
  activeContext: "global",
  contexts: {},
  };
}

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

  // ── Auto-update tsconfig.json paths if inside a the-brain repo ──
  try {
    const tsconfigPath = join(process.cwd(), "tsconfig.json");
    await access(tsconfigPath);
    const tsconfigRaw = await readFile(tsconfigPath, "utf-8");
    const tsconfig = JSON.parse(tsconfigRaw);
    const paths = tsconfig.compilerOptions?.paths || {};

    // Scan workspace packages
    const fs = await import("node:fs/promises");
    for (const pkgRoot of ["packages", "apps"]) {
      const rootPath = join(process.cwd(), pkgRoot);
      try {
        const entries = await (await import("node:fs/promises")).readdir(rootPath, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          try {
            const pkgJsonPath = join(rootPath, entry.name, "package.json");
            const pkgRaw = await readFile(pkgJsonPath, "utf-8");
            const pkg = JSON.parse(pkgRaw);
            const name = pkg.name;
            if (!name || !name.startsWith("@the-brain/")) continue;
            if (!paths[name]) {
              paths[name] = [`./${pkgRoot}/${entry.name}/src`];
              if (!paths[`${name}/*`]) {
                paths[`${name}/*`] = [`./${pkgRoot}/${entry.name}/src/*`];
              }
            }
          } catch { /* skip packages without package.json */ }
        }
      } catch { /* skip non-existent directories */ }
    }

    tsconfig.compilerOptions.paths = paths;
    await writeFile(tsconfigPath, JSON.stringify(tsconfig, null, 2) + "\n", "utf-8");
    consola.info(`tsconfig.json updated with ${Object.keys(paths).length} paths`);
  } catch { /* not in a the-brain repo — skip */ }

  try {
    const configDir = getConfigDir();
    const configPath = getConfigPath();

    // Create directories
    await mkdir(configDir, { recursive: true });
    await mkdir(join(configDir, "logs"), { recursive: true });
    await mkdir(join(configDir, "global"), { recursive: true });

    // Load or create config
    let config: TheBrainConfig;
    let configExists = false;
    try {
      await access(configPath);
      const raw = await readFile(configPath, "utf-8");
      const parsed = safeParseConfig(JSON.parse(raw));
      config = parsed.success ? parsed.data : { ...getDefaultConfig() };
      configExists = parsed.success;

      // Upgrade old configs that don't have multi-project fields
      if (!config.activeContext) config.activeContext = "global";
      if (!config.contexts) config.contexts = {};
    } catch {
      config = { ...getDefaultConfig() };
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
      const authDbPath = join(configDir, "auth.db");
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
      const projectDir = join(configDir, "projects", projectName);
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
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
    consola.success(`Config written to ${configPath}`);

    // Wiki directory for active context
    const activeCtx = config.activeContext === "global"
      ? null
      : config.contexts[config.activeContext];
    const activeWikiDir = activeCtx?.wikiDir ?? config.wiki.outputDir;
    await mkdir(activeWikiDir, { recursive: true });

    const boxLines = [
      `🧠 the-brain initialized successfully!`,
      ``,
      `  Config:  ${configPath}`,
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

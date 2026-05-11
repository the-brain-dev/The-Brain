/**
 * ProjectManager — Multi-project context isolation with global overlay.
 *
 * Manages multiple BrainDB instances:
 *   - One per project (~/.the-brain/projects/<name>/brain.db)
 *   - One global (~/.the-brain/global/brain.db)
 *
 * Provides routing:
 *   - getProjectDB(name)  → project-specific database
 *   - getGlobalDB()       → cross-project developer-level patterns
 *   - getActiveDB()       → currently active context (global or project)
 */
import { BrainDB } from "./db/index";
import type { TheBrainConfig, ProjectContext } from "./types";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

export type DBMap = Map<string, BrainDB>;

export class ProjectManager {
  private dbs: DBMap = new Map();
  private globalDB: BrainDB;
  private config: TheBrainConfig;
  private configDir: string;

  constructor(config: TheBrainConfig, configDir?: string) {
    this.config = config;
    this.configDir = configDir ?? join(process.env.HOME || "~", ".the-brain");
    this.globalDB = new BrainDB(config.database.path);
  }

  /** Get or create the database for a specific project. */
  async getProjectDB(projectName: string): Promise<BrainDB> {
    if (this.dbs.has(projectName)) {
      return this.dbs.get(projectName)!;
    }

    const ctx = this.config.contexts[projectName];
    if (!ctx) {
      throw new Error(`No context registered for project "${projectName}". Run \`the-brain init --project ${projectName}\` first.`);
    }

    // Ensure directory exists
    const dir = join(ctx.dbPath, "..");
    await mkdir(dir, { recursive: true }).catch(() => {});

    const db = new BrainDB(ctx.dbPath);
    this.dbs.set(projectName, db);
    return db;
  }

  /** Get the global database (developer-level patterns). */
  getGlobalDB(): BrainDB {
    return this.globalDB;
  }

  /** Get the currently active database based on config.activeContext. */
  async getActiveDB(): Promise<BrainDB> {
    if (this.config.activeContext === "global" || !this.config.activeContext) {
      return this.globalDB;
    }
    return this.getProjectDB(this.config.activeContext);
  }

  /** Get currently active project context. */
  getActiveContext(): ProjectContext | null {
    const name = this.config.activeContext;
    if (!name || name === "global") {
      return null;
    }
    return this.config.contexts[name] ?? null;
  }

  /** Get the project name for the active context. */
  getActiveProjectName(): string | null {
    const ctx = this.getActiveContext();
    return ctx?.name ?? null;
  }

  /** List all registered project contexts. */
  listProjects(): ProjectContext[] {
    return Object.values(this.config.contexts);
  }

  /** Create or update a project context in the config. */
  registerProject(ctx: ProjectContext): void {
    this.config.contexts[ctx.name] = ctx;
    // Ensure parent directory
    this.config.contexts[ctx.name] = {
      ...ctx,
      createdAt: ctx.createdAt || Date.now(),
    };
  }

  /** Remove a project context (does not delete data). */
  unregisterProject(name: string): void {
    delete this.config.contexts[name];
    // Close DB if open
    const db = this.dbs.get(name);
    if (db) {
      db.close();
      this.dbs.delete(name);
    }
  }

  /** Set the active context and update config. */
  async switchContext(name: string): Promise<void> {
    if (name !== "global" && !this.config.contexts[name]) {
      throw new Error(`Project "${name}" not found. Available: ${Object.keys(this.config.contexts).join(", ") || "none"}`);
    }

    this.config.activeContext = name;

    // Update lastActive timestamp
    if (name !== "global") {
      this.config.contexts[name].lastActive = Date.now();
    }
  }

  /** Get the config (mutable reference for persistence). */
  getConfig(): TheBrainConfig {
    return this.config;
  }

  /** Get the config directory path. */
  getConfigDir(): string {
    return this.configDir;
  }

  /** Close all open databases. */
  close(): void {
    this.globalDB.close();
    for (const db of this.dbs.values()) {
      db.close();
    }
    this.dbs.clear();
  }

  /** Get the wiki directory for the active context. */
  getActiveWikiDir(): string {
    const ctx = this.getActiveContext();
    if (ctx) {
      return ctx.wikiDir;
    }
    return this.config.wiki.outputDir;
  }

  /** Get the LoRA checkpoint directory for the active context. */
  getActiveLoraDir(): string | undefined {
    const ctx = this.getActiveContext();
    if (ctx) {
      return ctx.loraDir;
    }
    return this.config.mlx.loraOutputDir;
  }

  /** Resolve which database should receive data tagged with a project name. */
  async resolveDB(projectName?: string): Promise<BrainDB> {
    if (!projectName) {
      // No project tag → active context or global fallback
      return this.getActiveDB();
    }

    // Check if this is a known project
    if (this.config.contexts[projectName]) {
      return this.getProjectDB(projectName);
    }

    // Unknown project → fallback to active
    return this.getActiveDB();
  }

  /** Determine if a memory should be promoted to global based on project count. */
  shouldPromoteToGlobal(projectCount: number): boolean {
    // Same pattern seen in 2+ different projects → global
    return projectCount >= 2;
  }
}

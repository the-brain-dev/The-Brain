#!/usr/bin/env bun
/**
 * the-brain CLI — Pluggable Cognitive Operating System for AI Agents
 *
 * Commands:
 *   the-brain init [--project <name>]    Initialize database and config
 *   the-brain daemon start|stop|status|enable|disable
 *   the-brain consolidate --now          Force memory consolidation
 *   the-brain inspect --stats [--project <name>|--global]
 *   the-brain plugins list               List loaded plugins
 *   the-brain switch-context --project <name>  Switch active context
 *   the-brain train [--dry-run] [--iterations N]  Train LoRA on DEEP memories
 *   the-brain wiki generate               Generate knowledge wiki
 *   the-brain docs <dev|build|serve>      Fumadocs documentation site
 */
import { cac } from "cac";
import { consola } from "consola";
import { initCommand } from "./commands/init";
import { daemonCommand } from "./commands/daemon";
import { consolidateCommand } from "./commands/consolidate";
import { inspectCommand } from "./commands/inspect";
import { pluginsCommand } from "./commands/plugins";
import { switchContextCommand } from "./commands/switch-context";
import { healthCommand } from "./commands/health";
import { wikiCommand } from "./commands/wiki";
import { dashboardCommand } from "./commands/dashboard";
import { contextCommand } from "./commands/context";
import { trainCommand } from "./commands/train";
import { backendCommand } from "./commands/backend";
import { mcpCommand } from "./commands/mcp";
import { agentCommand } from "./commands/agent";
import { docsCommand } from "./commands/docs";
import { userCommand } from "./commands/user";
import { getExtensionCommands } from "@the-brain-dev/core";

const cli = cac("the-brain");

// Version
cli.version("0.2.0");

// ── Init ──────────────────────────────────────────────────────────
cli
  .command("init", "Initialize the-brain database and config")
  .option("--force", "Overwrite existing config")
  .option("--db-path <path>", "Database path (default: ~/.the-brain/global/brain.db)")
  .option("--project <name>", "Create a new project context (isolated brain)")
  .option("--work-dir <path>", "Project root for auto-detection")
  .option("--label <name>", "Human-friendly project name")
  .option("--remote", "Enable remote server mode (generates auth token, binds 0.0.0.0)")
  .option("--team", "Enable team mode (multi-user auth with per-user tokens)")
  .action(async (options) => {
    await initCommand(options);
  });

// ── Daemon ────────────────────────────────────────────────────────
cli
  .command("daemon <action>", "Manage the background daemon")
  .option("--poll-interval <ms>", "Poll interval in ms (default: 30000)")
  .action(async (action: string, options) => {
    await daemonCommand(action, options);
  });

// ── Consolidate ───────────────────────────────────────────────────
cli
  .command("consolidate", "Force memory consolidation (Layer 2 -> Layer 3)")
  .option("--now", "Run consolidation immediately")
  .option("--reprocess", "Run all INSTANT memories through SPM first")
  .option("--layer <layer>", "Target layer: selection|deep")
  .option("--project <name>", "Target a specific project")
  .option("--global", "Target global brain")
  .action(async (options) => {
    await consolidateCommand(options);
  });

// ── Inspect ───────────────────────────────────────────────────────
cli
  .command("inspect", "Inspect your brain's state")
  .option("--stats", "Show statistics (default)")
  .option("--memories [layer]", "Show memories (optionally filter by layer)")
  .option("--graph", "Show knowledge graph summary")
  .option("--recent", "Show recent interactions")
  .option("--search <query>", "Search graph nodes by keyword")
  .option("--top <type>", "Show top nodes by type (concept|correction|preference|pattern|all)")
  .option("--sources", "Show data source breakdown")
  .option("--project <name>", "Show stats for a specific project")
  .option("--global", "Show global brain stats")
  .action(async (options) => {
    await inspectCommand(options);
  });

// ── Train ────────────────────────────────────────────────────────
cli
  .command("train", "Trigger LoRA training on DEEP-layer memories")
  .option("--dry-run", "Show what would be trained, don't execute")
  .option("--iterations <n>", "Override training iterations (default: 50)")
  .option("--project <name>", "Train on a specific project's DEEP memories")
  .option("--global", "Train on global brain DEEP memories")
  .action(async (options) => {
    await trainCommand(options);
  });

// ── Plugins ───────────────────────────────────────────────────────
cli
  .command("plugins <action>", "Manage plugins")
  .action(async (action: string) => {
    await pluginsCommand(action);
  });

// ── Switch Context ────────────────────────────────────────────────
cli
  .command("switch-context", "Switch active project/context")
  .option("--project <name>", "Project name to switch to")
  .option("--global", "Switch to global context")
  .action(async (options) => {
    await switchContextCommand(options);
  });

// ── Health ────────────────────────────────────────────────────────
cli
  .command("health", "Show daemon health and brain statistics")
  .option("--project <name>", "Show health for a specific project")
  .option("--global", "Show global brain health")
  .action(async (options) => {
    await healthCommand(options);
  });

// ── Wiki ──────────────────────────────────────────────────────────
cli
  .command("wiki <action>", "Browse the knowledge wiki (open|serve|path|generate)")
  .option("--port <number>", "Server port (default: 3333)")
  .option("--project <name>", "Target specific project wiki")
  .option("--global", "Target global wiki")
  .action(async (action: string, options) => {
    await wikiCommand({ action, ...options });
  });

// ── Dashboard ──────────────────────────────────────────────────────
cli
  .command("dashboard", "Live Terminal UI dashboard for the-brain")
  .option("--project <name>", "Dashboard for specific project")
  .option("--global", "Dashboard for global brain")
  .option("--interval <seconds>", "Refresh interval (default: 2)")
  .action(async (options) => {
    await dashboardCommand(options);
  });

// ── Context ───────────────────────────────────────────────────────
cli
  .command("context", "Export brain context for external AI agents (Hermes)")
  .option("--json", "Output structured JSON (default)")
  .option("--markdown", "Output human-readable markdown")
  .option("--project <name>", "Context from specific project")
  .option("--global", "Context from global brain")
  .option("--query <term>", "Filter graph nodes by keyword")
  .option("--user <name>", "Include user identity anchor data")
  .option("--limit <n>", "Max results per section (default: 10)")
  .action(async (options) => {
    await contextCommand(options);
  });

// ── Backend ────────────────────────────────────────────────────────
cli
  .command("backend <action>", "Manage pluggable backends (list|set|unset)")
  .option("--slot <slot>", "Backend slot: storage|cleaner|scheduler")
  .option("--module <path>", "Module path or npm package name")
  .action(async (action: string, options) => {
    await backendCommand(action, options);
  });

// ── Docs (Fumadocs) ────────────────────────────────────────────────
cli
  .command("docs <action>", "Manage documentation site (dev|build|serve)")
  .option("--port <number>", "Port for dev/server (default: 3001)")
  .action(async (action: string, options) => {
    await docsCommand(action, options);
  });

// ── MCP Server ────────────────────────────────────────────────────
cli
  .command("mcp <action>", "Start MCP server (serve)")
  .option("--transport <transport>", "Transport: stdio (default) | sse")
  .option("--port <number>", "Port for HTTP/SSE transport (default: 9422)")
  .option("--project <name>", "Target specific project context")
  .option("--global", "Target global context")
  .action(async (action: string, options) => {
    await mcpCommand(action, options);
  });

// ── Agent (remote client) ──────────────────────────────────────────
cli
  .command("agent", "Run remote client agent — polls IDE logs and pushes to server")
  .option("--once", "Run one poll cycle and exit")
  .option("--interval <seconds>", "Poll interval in seconds (default: 60)")
  .action(async (options) => {
    await agentCommand(options);
  });

// ── Extension commands ─────────────────────────────────────────────
cli
  .command("ext <cmd> [args...]", "Run a command registered by an extension")
  .action(async (cmd: string, args: string[]) => {
    const commands = getExtensionCommands();
    const handler = commands.get(cmd);
    if (!handler) {
      console.error(`Unknown extension command: "${cmd}"`);
      console.error(`Available: ${[...commands.keys()].join(", ") || "(none)"}`);
      process.exit(1);
    }
    await handler(args);
  });

// ── Timeline ───────────────────────────────────────────────────────
import { timelineCommand } from "./commands/timeline";

cli
  .command("timeline", "Open brain activity timeline in browser")
  .action(async () => {
    await timelineCommand();
  });

// ── User (team mode) ─────────────────────────────────────────────
cli
  .command("user <action>", "Manage users (team mode)")
  .option("--name <name>", "User name")
  .option("--project <project>", "Project name for permission")
  .option("--role <role>", "Role: admin, contributor, observer")
  .option("--label <label>", "Token label")
  .option("--revoke <token-id>", "Revoke a token")
  .action(async (action: string, options) => {
    await userCommand(action, options);
  });

// Parse
cli.help();
cli.parse();

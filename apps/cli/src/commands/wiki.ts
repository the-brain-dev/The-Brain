/**
 * wiki command — Browse, serve, and generate the the-brain knowledge wiki.
 *
 *   the-brain wiki open              Open wiki in Obsidian (if installed)
 *   the-brain wiki serve [--port N]   Start local HTTP server to browse wiki
 *   the-brain wiki path               Print wiki directory path
 *   the-brain wiki generate           Generate wiki from graph nodes + memories
 */
import { consola } from "consola";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { TheBrainConfig } from "@the-brain-dev/core";
import { safeParseConfig } from "@the-brain-dev/core";

const CONFIG_PATH = join(process.env.HOME || "~", ".the-brain", "config.json");

async function getWikiDir(options: { project?: string; global?: boolean }): Promise<string> {
  const defaults = join(process.env.HOME || "~", ".the-brain", "wiki");
  if (!existsSync(CONFIG_PATH)) return defaults;
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const parsed = safeParseConfig(JSON.parse(raw));
    const config: TheBrainConfig | null = parsed.success ? parsed.data : null;
    if (!config) return defaults;
    if (options.project) return config.contexts?.[options.project]?.wikiDir || defaults;
    if (options.global) return config.wiki.outputDir || defaults;
    const active = config.activeContext || "global";
    if (active !== "global" && config.contexts?.[active]) return config.contexts[active].wikiDir;
    return config.wiki.outputDir || defaults;
  } catch {
    return defaults;
  }
}

export async function wikiCommand(options: {
  action: string;
  port?: number;
  project?: string;
  global?: boolean;
}) {
  const wikiDir = await getWikiDir(options);

  switch (options.action) {
    case "path":
      consola.info(wikiDir);
      break;

    case "open":
      await openWiki(wikiDir);
      break;

    case "serve": {
      const port = options.port;
      if (port !== undefined && (typeof port !== "number" || Number.isNaN(port) || port < 1 || port > 65535)) {
        consola.error("Invalid port: " + port + ". Must be a number between 1-65535.");
        return;
      }
      await serveWiki(wikiDir, port || 3333);
      break;
    }

    case "generate":
      await generateWikiFromBrain(options);
      break;

    default:
      consola.error("Unknown wiki action: " + options.action + '. Use "open", "serve", "path", or "generate".');
      process.exit(1);
  }
}

async function openWiki(wikiDir: string) {
  if (!existsSync(wikiDir)) {
    consola.warn("Wiki directory not found: " + wikiDir);
    consola.info("Run the daemon to let auto-wiki generate content.");
    return;
  }
  const obsidianPaths = [
    "/Applications/Obsidian.app",
    join(process.env.HOME || "~", "Applications", "Obsidian.app"),
  ];
  let obsidianFound = false;
  for (const p of obsidianPaths) {
    if (existsSync(p)) {
      const { execSync } = await import("node:child_process");
      try {
        execSync('open -a Obsidian "' + wikiDir + '"', { stdio: "pipe" });
        obsidianFound = true;
        consola.success("Opened wiki in Obsidian: " + wikiDir);
        break;
      } catch { /* fall through */ }
    }
  }
  if (!obsidianFound) {
    const { execSync } = await import("node:child_process");
    execSync('open "' + wikiDir + '"', { stdio: "ignore" });
    consola.info("Opened wiki in Finder: " + wikiDir);
    consola.info("Install Obsidian for a better browsing experience.");
  }
}

async function serveWiki(wikiDir: string, port: number) {
  if (!existsSync(wikiDir)) {
    consola.warn("Wiki directory not found: " + wikiDir);
    consola.info("Run the daemon to let auto-wiki generate content.");
    return;
  }

  consola.start("Serving wiki on http://localhost:" + port);

  const serverOptions = {
    port,
    hostname: "127.0.0.1" as const,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      let filePath = join(wikiDir, url.pathname === "/" ? "index.md" : url.pathname);
      if (filePath.includes("..")) return new Response("Forbidden", { status: 403 });
      if (!filePath.includes(".") && existsSync(filePath + ".md")) filePath += ".md";
      if (!existsSync(filePath)) return new Response("Not found", { status: 404 });
      const content = await Bun.file(filePath).text();
      const html = renderMarkdownToHTML(content, wikiDir);
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    },
  };

  const { execSync } = await import("node:child_process");
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve(serverOptions);
  } catch (err: any) {
    if (err?.code === "EADDRINUSE") {
      const pid = execSync("lsof -ti :" + port, { encoding: "utf-8" }).trim();
      if (pid && pid !== String(process.pid)) {
        consola.warn("Port " + port + " in use by PID " + pid + ", releasing...");
        execSync("kill -9 " + pid);
        Bun.sleepSync(1000);
        server = Bun.serve(serverOptions);
      } else { throw err; }
    } else { throw err; }
  }

  consola.success("Wiki available at http://localhost:" + port);
  consola.info("Browse: http://localhost:" + port + "/index.md");
  consola.info("Press Ctrl+C to stop");
  await new Promise(() => {});
}

function renderMarkdownToHTML(md: string, baseDir: string): string {
  let html = md
    .replace(/^#### (.+)$/gm, "<h4>$1</h4>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[\[([^\]]+)\]\]/g, (_: string, link: string) => {
      const [slug, label] = link.includes("|") ? link.split("|") : [link, link];
      const escapedLabel = label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const encodedSlug = slug.replace(/ /g, "%20").replace(/#/g, "%23");
      return '<a href="/' + encodedSlug + '.md">' + escapedLabel + "</a>";
    })
    .replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>")
    .replace(/^---$/gm, "<hr>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/\n\n/g, "</p><p>");

  return '<!DOCTYPE html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>the-brain wiki</title>\n  <style>\n    body { font-family: -apple-system, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; color: #333; }\n    h1 { border-bottom: 2px solid #eee; padding-bottom: 8px; }\n    h2 { border-bottom: 1px solid #eee; padding-bottom: 4px; margin-top: 30px; }\n    code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }\n    blockquote { border-left: 3px solid #ddd; margin: 10px 0; padding: 5px 15px; color: #666; }\n    a { color: #2563eb; text-decoration: none; }\n    a:hover { text-decoration: underline; }\n    hr { border: none; border-top: 1px solid #eee; }\n  </style>\n</head>\n<body>\n<p>' + html + "</p>\n</body>\n</html>";
}

// ── Wiki Generation (the-brain wiki generate) ──────────────────

async function generateWikiFromBrain(options: { project?: string; global?: boolean }) {
  const consola = (await import("consola")).consola;
  const { BrainDB } = await import("@the-brain-dev/core");
  const { createAutoWikiPlugin } = await import("@the-brain-dev/plugin-auto-wiki");

  const DB_PATH = join(process.env.HOME || "~", ".the-brain", "global", "brain.db");
  let dbPath = DB_PATH;
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = await readFile(CONFIG_PATH, "utf-8");
      const parsed = safeParseConfig(JSON.parse(raw));
      if (parsed.success) {
        const config = parsed.data;
        if (options.project) {
          const ctx = config.contexts?.[options.project];
          if (ctx) dbPath = ctx.dbPath;
        } else if (!options.global && config.database?.path) {
          dbPath = config.database.path;
        }
      }
    } catch {}
  }

  const db = new BrainDB(dbPath);
  try {
    consola.start("Generating wiki...");
    const wiki = createAutoWikiPlugin(db, {
      outputDir: join(process.env.HOME || "~", ".the-brain", "wiki"),
      title: "the-brain Wiki",
    });
    const result = await wiki.generateWiki();
    consola.success("Wiki generated: " + result.filepath);
    consola.info("Browse with: the-brain wiki serve");
  } catch (err) {
    consola.error("Wiki generation failed:", err);
    process.exit(1);
  } finally {
    db.close();
  }
}

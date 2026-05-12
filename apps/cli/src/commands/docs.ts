/**
 * docs command — Run the Fumadocs documentation site
 */
import { consola } from "consola";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";

const DOCS_DIR = (() => {
  const fromSource = join(import.meta.dir, "..", "..", "apps", "docs");
  if (existsSync(join(fromSource, "package.json"))) return fromSource;
  const fromCwd = join(process.cwd(), "apps", "docs");
  if (existsSync(join(fromCwd, "package.json"))) return fromCwd;
  return fromSource;
})();

const BUN_BIN = process.execPath;

export async function docsCommand(action: string, options: { port?: number }) {
  if (!existsSync(join(DOCS_DIR, "package.json"))) {
    consola.error("Docs directory not found. Run from the the-brain repo root.");
    consola.info("Expected at: " + DOCS_DIR);
    process.exit(1);
  }
  const port = Math.max(1, Math.min(65535, options.port ?? 3001));
  switch (action) {
    case "dev":
      consola.start("Starting docs dev server on http://localhost:" + port + "...");
      spawn(BUN_BIN, ["run", "dev", "--port", String(port)], { cwd: DOCS_DIR, stdio: "inherit" });
      break;
    case "build":
      consola.start("Building docs (Fumadocs + Next.js)...");
      const build = spawn(BUN_BIN, ["run", "build"], { cwd: DOCS_DIR, stdio: "inherit" });
      await new Promise<void>((resolve, reject) => {
        build.on("close", (code) => { if (code === 0) resolve(); else reject(new Error("Build exited with code " + code)); });
      });
      consola.success("Docs built → apps/docs/.next/");
      break;
    case "serve":
      consola.start("Serving docs on http://localhost:" + port + "...");
      spawn(BUN_BIN, ["run", "start", "--port", String(port)], { cwd: DOCS_DIR, stdio: "inherit" });
      break;
    default:
      consola.error('Unknown docs action: "' + action + '"');
      consola.info("Available: the-brain docs dev | build | serve");
      process.exit(1);
  }
}
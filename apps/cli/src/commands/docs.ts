/**
 * docs command — Run the Fumadocs documentation site
 *
 *   the-brain docs <action>   Action: dev|build|serve
 *     Options:
 *       --port <number>       Dev/server port (default: 3001)
 */
import { consola } from "consola";
import { spawn } from "node:child_process";
import { join } from "node:path";

const DOCS_DIR = join(import.meta.dir, "..", "..", "apps", "docs");

export async function docsCommand(action: string, options: { port?: number }) {
  const port = Math.max(1, Math.min(65535, options.port ?? 3001));

  switch (action) {
    case "dev":
      consola.start(`Starting docs dev server on http://localhost:${port}...`);
      spawn("bun", ["run", "dev", "--port", String(port)], {
        cwd: DOCS_DIR,
        stdio: "inherit",
      });
      break;

    case "build":
      consola.start("Building docs (Fumadocs + Next.js)...");
      const build = spawn("bun", ["run", "build"], {
        cwd: DOCS_DIR,
        stdio: "inherit",
      });
      await new Promise<void>((resolve, reject) => {
        build.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Build exited with code ${code}`));
        });
      });
      consola.success("Docs built → apps/docs/.next/");
      break;

    case "serve":
      consola.start(`Serving docs on http://localhost:${port}...`);
      spawn("bun", ["run", "start", "--port", String(port)], {
        cwd: DOCS_DIR,
        stdio: "inherit",
      });
      break;

    default:
      consola.error(`Unknown docs action: "${action}"`);
      consola.info("Available: the-brain docs dev | build | serve");
      process.exit(1);
  }
}

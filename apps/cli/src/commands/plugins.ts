/**
 * plugins command — List and manage loaded plugins
 */
import { consola } from "consola";

export async function pluginsCommand(action: string) {
  switch (action) {
    case "list":
    case "ls": {
      consola.info("🧩 my-brain Built-in Plugins:\n");

      const plugins = [
        { name: "@my-brain/plugin-graph-memory", layer: "Instant", desc: "Fast relational graph for context injection" },
        { name: "@my-brain/plugin-spm-curator", layer: "Selection", desc: "Surprise-gated prediction error filtering" },
        { name: "@my-brain/plugin-harvester-cursor", layer: "Input", desc: "Polls Cursor IDE logs for interactions" },
        { name: "@my-brain/plugin-identity-anchor", layer: "Deep", desc: "Stable Self-Vector to prevent catastrophic forgetting" },
        { name: "@my-brain/plugin-auto-wiki", layer: "Output", desc: "Static Markdown Wiki generator (Sundays)" },
        { name: "@my-brain/trainer-local-mlx", layer: "Deep", desc: "Local LoRA training on Apple Silicon (MLX)" },
      ];

      for (const p of plugins) {
        consola.info(`  ${p.name.padEnd(40)} [${p.layer}] ${p.desc}`);
      }

      consola.info("\n💡 Write your own: implement definePlugin from @my-brain/core");
      break;
    }
    default: {
      consola.error(`Unknown action: ${action}. Use "list".`);
      process.exit(1);
    }
  }
}

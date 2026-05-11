/**
 * plugins command — List and manage loaded plugins
 */
import { consola } from "consola";

export async function pluginsCommand(action: string) {
  switch (action) {
    case "list":
    case "ls": {
      consola.info("🧩 the-brain Built-in Plugins:\n");

      const plugins = [
        { name: "@the-brain-dev/plugin-graph-memory", layer: "Instant", desc: "Fast relational graph for context injection" },
        { name: "@the-brain-dev/plugin-spm-curator", layer: "Selection", desc: "Surprise-gated prediction error filtering" },
        { name: "@the-brain-dev/plugin-harvester-cursor", layer: "Input", desc: "Polls Cursor IDE logs for interactions" },
        { name: "@the-brain-dev/plugin-identity-anchor", layer: "Deep", desc: "Stable Self-Vector to prevent catastrophic forgetting" },
        { name: "@the-brain-dev/plugin-auto-wiki", layer: "Output", desc: "Static Markdown Wiki generator (Sundays)" },
        { name: "@the-brain-dev/plugin-harvester-hermes", layer: "Input", desc: "Harvests Hermes Agent conversations from state.db" },
        { name: "@the-brain-dev/plugin-harvester-lm-eval", layer: "Input", desc: "Harvests lm-evaluation-harness benchmark results" },
        { name: "@the-brain-dev/trainer-local-mlx", layer: "Deep", desc: "Local LoRA training on Apple Silicon (MLX)" },
      ];

      for (const p of plugins) {
        consola.info(`  ${p.name.padEnd(40)} [${p.layer}] ${p.desc}`);
      }

      consola.info("\n💡 Write your own: implement definePlugin from @the-brain-dev/core");
      break;
    }
    default: {
      consola.error(`Unknown action: ${action}. Use "list".`);
      process.exit(1);
    }
  }
}

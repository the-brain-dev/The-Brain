/**
 * setup command — Interactive pipeline configurator for the-brain.
 *
 * Usage:
 *   the-brain setup                  Interactive TUI wizard
 *   the-brain setup --status         Show current pipeline config
 *   the-brain setup --enable cursor  Quick-enable a harvester
 *   the-brain setup --disable hermes Quick-disable a harvester
 */
import { consola } from "consola";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { safeParseConfig } from "@the-brain-dev/core";
import type { TheBrainConfig, PipelineConfig } from "@the-brain-dev/core";

function getConfigDir(): string {
  return join(process.env.HOME || "~", ".the-brain");
}

function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export function getDefaultPipeline(): PipelineConfig {
  return {
    harvesters: ["cursor", "claude"],
    layers: { instant: true, selection: true, deep: true },
    outputs: ["auto-wiki"],
    training: { mlx: false },
    llm: true,
  };
}

// ── Helpers ────────────────────────────────────────────────────
// Exported for tests

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      resolve(answer.trim());
    });
  });
}

export function yesNo(input: string, defaultYes: boolean): boolean {
  if (input === "") return defaultYes;
  return /^[yY]/.test(input);
}

export const HARVESTER_LABELS: Record<string, string> = {
  cursor: "Cursor IDE",
  claude: "Claude Code CLI",
  hermes: "Hermes Agent",
  gemini: "Gemini CLI",
  windsurf: "Windsurf IDE",
  "lm-eval": "LM Eval Harness",
};

const ALL_HARVESTERS = Object.keys(HARVESTER_LABELS);

// ── Step: Harvesters ───────────────────────────────────────────

async function stepHarvesters(
  rl: ReturnType<typeof createInterface>,
  current: PipelineConfig
): Promise<string[]> {
  consola.info("");
  consola.info("Step 1/5: Harvesters — which AI tools do you use?");
  consola.info("");

  let idx = 1;
  const map: Record<number, string> = {};
  for (const key of ALL_HARVESTERS) {
    const enabled = current.harvesters.includes(key);
    const mark = enabled ? "x" : " ";
    consola.info(`  [${mark}] ${idx}. ${HARVESTER_LABELS[key]}`);
    map[idx] = key;
    idx++;
  }

  consola.info("");
  const answer = await ask(
    rl,
    `  Toggle (e.g., "1 3" for Cursor+Gemini, "a" for all, Enter to keep current): `
  );

  if (answer === "") return current.harvesters;
  if (answer.toLowerCase() === "a") return [...ALL_HARVESTERS];
  if (answer.toLowerCase() === "n") return [];

  // Toggle mode: numbers select specific harvesters
  const selected: string[] = [];
  for (const part of answer.split(/\s+/)) {
    const num = parseInt(part);
    if (map[num]) selected.push(map[num]);
  }
  return selected.length > 0 ? selected : current.harvesters;
}

// ── Step: Layers ───────────────────────────────────────────────

async function stepLayers(
  rl: ReturnType<typeof createInterface>,
  current: PipelineConfig
): Promise<PipelineConfig["layers"]> {
  consola.info("");
  consola.info("Step 2/5: Memory Pipeline Layers");
  consola.info("");

  const labels = {
    instant: "Layer 1 — Graph Memory (instant corrections)",
    selection: "Layer 2 — SPM Curator  (surprise-gated filtering)",
    deep: "Layer 3 — Identity Anchor (stable self-vector)",
  };

  for (const [key, label] of Object.entries(labels)) {
    const enabled = current.layers[key as keyof typeof current.layers];
    const mark = enabled ? "x" : " ";
    consola.info(`  [${mark}] ${label}`);
  }

  consola.info("");
  const answer = await ask(
    rl,
    `  Disable any? (e.g., "3" to disable Deep, Enter to keep all): `
  );

  if (answer === "") return { ...current.layers };

  const disabled = new Set(answer.split(/\s+/).map(Number));
  return {
    instant: !disabled.has(1),
    selection: !disabled.has(2),
    deep: !disabled.has(3),
  };
}

// ── Step: LLM Backend ──────────────────────────────────────────

async function stepLlm(
  rl: ReturnType<typeof createInterface>,
  current: PipelineConfig,
  config: TheBrainConfig
): Promise<{ llmEnabled: boolean; llmConfig?: TheBrainConfig["llm"] }> {
  consola.info("");
  consola.info("Step 3/5: LLM Backend (for data classification)");
  consola.info("");

  const answer = await ask(rl, `  Enable LLM backend? [Y/n]: `);
  const llmEnabled = yesNo(answer, true);

  if (!llmEnabled) return { llmEnabled: false, llmConfig: config.llm };

  // Sub-steps: provider, model, key
  consola.info("");
  consola.info("  --- LLM Backend Configuration ---");
  consola.info("");

  const provider = await ask(
    rl,
    `  Provider [1] OpenAI [2] Ollama [3] Anthropic [4] Custom\n  Choose [1-4] (default: 1): `
  );
  const providerChoice = provider || "1";

  let defaultModel: string;
  let baseUrl: string;
  let backendName: string;

  switch (providerChoice) {
    case "1":
    default:
      backendName = "openai";
      defaultModel = "gpt-4o-mini";
      baseUrl = "https://api.openai.com/v1";
      break;
    case "2":
      backendName = "ollama";
      defaultModel = "llama3.2";
      baseUrl = "http://localhost:11434/v1";
      break;
    case "3":
      backendName = "anthropic";
      defaultModel = "claude-sonnet-4";
      baseUrl = "https://api.anthropic.com/v1";
      break;
    case "4":
      backendName = await ask(rl, `  Backend name: `) || "custom";
      baseUrl = await ask(rl, `  Base URL: `) || "http://localhost:11434/v1";
      defaultModel = await ask(rl, `  Default model: `) || "llama3.2";
      break;
  }

  let userModel = await ask(
    rl,
    `  Model [${defaultModel}]: `
  );
  const model = userModel || defaultModel;

  const apiKey = await ask(
    rl,
    `  API Key (or env var, e.g., "sk-..."): `
  );

  const llmConfig: TheBrainConfig["llm"] = {
    default: backendName,
    backends: {
      [backendName]: {
        provider: backendName,
        baseUrl,
        defaultModel: model,
        ...(apiKey ? { apiKey } : {}),
      },
    },
  };

  // Merge with existing LLM config if present
  if (config.llm) {
    llmConfig.default = config.llm.default || backendName;
    llmConfig.backends = { ...config.llm.backends, ...llmConfig.backends };
  }

  consola.info(`  LLM configured: ${backendName}/${model}`);
  return { llmEnabled: true, llmConfig };
}

// ── Step: MLX Training ─────────────────────────────────────────

async function stepMlx(
  rl: ReturnType<typeof createInterface>,
  current: PipelineConfig
): Promise<boolean> {
  const isAppleSilicon =
    process.arch === "arm64" && process.platform === "darwin";

  if (!isAppleSilicon) return false;

  consola.info("");
  consola.info("Step 4/5: MLX LoRA Training");
  consola.info("  Apple Silicon detected — enables overnight fine-tuning");
  consola.info("");

  const answer = await ask(rl, `  Enable MLX LoRA training? [y/N]: `);
  return yesNo(answer, false);
}

// ── Step: Outputs ──────────────────────────────────────────────

async function stepOutputs(
  rl: ReturnType<typeof createInterface>,
  current: PipelineConfig
): Promise<string[]> {
  consola.info("");
  consola.info("Step 5/5: Outputs");
  consola.info("");

  const wikiEnabled = current.outputs.includes("auto-wiki");
  const mark = wikiEnabled ? "x" : " ";
  consola.info(`  [${mark}] Auto Wiki (weekly digest in ~/.the-brain/wiki/)`);

  consola.info("");
  const answer = await ask(
    rl,
    `  Enable Auto Wiki? [Y/n]: `
  );

  return yesNo(answer, true) ? ["auto-wiki"] : [];
}

// ── Review ─────────────────────────────────────────────────────

export async function showReview(
  rl: ReturnType<typeof createInterface>,
  pipeline: PipelineConfig
): Promise<boolean> {
  consola.info("");
  consola.info("══════════════════════════════════════════");
  consola.info("  Configuration Review");
  consola.info("══════════════════════════════════════════");
  consola.info("");

  const harvesterDisplay =
    pipeline.harvesters.length > 0
      ? pipeline.harvesters.map((h) => HARVESTER_LABELS[h] || h).join(", ")
      : "(none)";

  const layerDisplay = [
    pipeline.layers.instant ? "Instant ✓" : "Instant ✗",
    pipeline.layers.selection ? "Selection ✓" : "Selection ✗",
    pipeline.layers.deep ? "Deep ✓" : "Deep ✗",
  ].join(", ");

  consola.info(`  Harvesters:  ${harvesterDisplay}`);
  consola.info(`  Layers:      ${layerDisplay}`);
  consola.info(`  LLM:         ${pipeline.llm ? "enabled" : "disabled"}`);
  consola.info(
    `  Training:    MLX ${pipeline.training.mlx ? "enabled" : "off"}`
  );
  consola.info(
    `  Outputs:     ${pipeline.outputs.length > 0 ? pipeline.outputs.join(", ") : "(none)"}`
  );
  consola.info("");

  const answer = await ask(
    rl,
    `  [Enter] save  [b] back  [q] quit: `
  );

  if (answer.toLowerCase() === "q") {
    consola.info("Configuration cancelled.");
    return false;
  }
  if (answer.toLowerCase() === "b") {
    return false; // caller handles re-running
  }
  return true;
}

// ── Interactive wizard ─────────────────────────────────────────

async function interactiveWizard(config: TheBrainConfig): Promise<TheBrainConfig> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    let pipeline = config.pipeline || getDefaultPipeline();

    consola.info("");
    consola.info("╔══════════════════════════════════════════╗");
    consola.info("║  🧠 the-brain — Interactive Setup       ║");
    consola.info("╚══════════════════════════════════════════╝");

    // Run steps — allow back/retry
    let done = false;
    let llmConfig: TheBrainConfig["llm"] = config.llm;
    while (!done) {
      const harvesters = await stepHarvesters(rl, pipeline);
      const layers = await stepLayers(rl, pipeline);
      const llmResult = await stepLlm(rl, pipeline, config);
      llmConfig = llmResult.llmConfig;

      const isAppleSilicon =
        process.arch === "arm64" && process.platform === "darwin";
      const mlxEnabled = isAppleSilicon ? await stepMlx(rl, pipeline) : false;

      const outputs = await stepOutputs(rl, pipeline);

      pipeline = {
        harvesters,
        layers,
        outputs,
        training: { mlx: mlxEnabled },
        llm: llmResult.llmEnabled,
      };

      done = await showReview(rl, pipeline);
    }

    config.pipeline = pipeline;
    if (llmConfig) {
      config.llm = llmConfig;
    }

    consola.success("Configuration saved.");
    return config;
  } finally {
    rl.close();
  }
}

// ── Non-interactive helpers ────────────────────────────────────

function showStatus(config: TheBrainConfig): void {
  const pipeline = config.pipeline;

  consola.info("");
  consola.info("═══ Current Pipeline Configuration ═══");
  consola.info("");

  if (!pipeline) {
    consola.info("  No pipeline configured. Run `the-brain setup` to create one.");
    consola.info("  Default: all plugins enabled (backward compat mode).");
    return;
  }

  const harvesterDisplay =
    pipeline.harvesters.length > 0
      ? pipeline.harvesters.join(", ")
      : "(none)";

  consola.info(`  Harvesters:  ${harvesterDisplay}`);
  consola.info(
    `  Layers:      instant=${pipeline.layers.instant}, selection=${pipeline.layers.selection}, deep=${pipeline.layers.deep}`
  );
  consola.info(`  LLM backend: ${pipeline.llm ? "on" : "off"}`);
  consola.info(`  MLX training: ${pipeline.training.mlx ? "on" : "off"}`);
  consola.info(
    `  Outputs:     ${pipeline.outputs.length > 0 ? pipeline.outputs.join(", ") : "(none)"}`
  );

  if (config.llm) {
    consola.info("");
    consola.info(`  LLM default: ${config.llm.default}`);
    for (const [name, backend] of Object.entries(config.llm.backends)) {
      consola.info(`    ${name}: ${backend.defaultModel} @ ${backend.baseUrl}`);
    }
  }
  consola.info("");
}

// ── Main command ───────────────────────────────────────────────

function validateOnOff(value: string | undefined, flagName: string): boolean {
  if (value === undefined) return true; // not passed at all — fine
  if (value === "on" || value === "off") return true;
  consola.error(`Invalid value for ${flagName}: "${value}". Must be "on" or "off".`);
  return false;
}

export async function setupCommand(options: {
  status?: boolean;
  enable?: string;
  disable?: string;
  layerInstant?: "on" | "off";
  layerSelection?: "on" | "off";
  layerDeep?: "on" | "off";
  mlx?: "on" | "off";
  llm?: "on" | "off";
  output?: string;
}) {
  // Validate on/off flags
  if (!validateOnOff(options.layerInstant, "--layer-instant")) return;
  if (!validateOnOff(options.layerSelection, "--layer-selection")) return;
  if (!validateOnOff(options.layerDeep, "--layer-deep")) return;
  if (!validateOnOff(options.mlx, "--mlx")) return;
  if (!validateOnOff(options.llm, "--llm")) return;
  const configPath = getConfigPath();

  // Load config
  let config: TheBrainConfig;
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = safeParseConfig(JSON.parse(raw));
    config = parsed.success ? parsed.data : (() => {
      consola.error("Config is invalid. Run `the-brain init` first.");
      process.exit(1);
    })() as never;
  } catch {
    consola.error("No config found. Run `the-brain init` first.");
    process.exit(1);
  }

  // Ensure pipeline exists
  if (!config.pipeline) {
    config.pipeline = getDefaultPipeline();
  }

  // ── Non-interactive modes ──
  if (options.status) {
    showStatus(config);
    return;
  }

  let changed = false;

  if (options.enable) {
    const toAdd = options.enable.split(",").map((s) => s.trim());
    for (const h of toAdd) {
      if (!ALL_HARVESTERS.includes(h)) {
        consola.warn(`Unknown harvester: "${h}"`);
        continue;
      }
      if (!config.pipeline.harvesters.includes(h)) {
        config.pipeline.harvesters.push(h);
        consola.info(`Enabled harvester: ${h}`);
        changed = true;
      }
    }
  }

  if (options.disable) {
    const toRemove = options.disable.split(",").map((s) => s.trim());
    config.pipeline.harvesters = config.pipeline.harvesters.filter(
      (h) => !toRemove.includes(h)
    );
    consola.info(`Disabled harvesters: ${toRemove.join(", ")}`);
    changed = true;
  }

  if (options.layerInstant) {
    config.pipeline.layers.instant = options.layerInstant === "on";
    consola.info(`Instant layer: ${options.layerInstant}`);
    changed = true;
  }

  if (options.layerSelection) {
    config.pipeline.layers.selection = options.layerSelection === "on";
    consola.info(`Selection layer: ${options.layerSelection}`);
    changed = true;
  }

  if (options.layerDeep) {
    config.pipeline.layers.deep = options.layerDeep === "on";
    consola.info(`Deep layer: ${options.layerDeep}`);
    changed = true;
  }

  if (options.mlx) {
    config.pipeline.training.mlx = options.mlx === "on";
    consola.info(`MLX training: ${options.mlx}`);
    changed = true;
  }

  if (options.llm) {
    config.pipeline.llm = options.llm === "on";
    consola.info(`LLM backend: ${options.llm}`);
    changed = true;
  }

  if (options.output !== undefined) {
    config.pipeline.outputs = options.output
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    consola.info(`Outputs set: ${config.pipeline.outputs.join(", ") || "(none)"}`);
    changed = true;
  }

  // ── Interactive mode (default) ──
  const hasNonInteractiveFlags =
    options.status === true ||
    options.enable !== undefined ||
    options.disable !== undefined ||
    options.layerInstant !== undefined ||
    options.layerSelection !== undefined ||
    options.layerDeep !== undefined ||
    options.mlx !== undefined ||
    options.llm !== undefined ||
    options.output !== undefined;

  if (!hasNonInteractiveFlags) {
    if (!process.stdout.isTTY) {
      consola.warn("Interactive setup requires a terminal. Use non-interactive flags instead:");
      consola.info("  the-brain setup --help");
      consola.info("  the-brain setup --status");
      consola.info("  the-brain setup --enable <harvester> --disable <harvester>");
      consola.info("  the-brain setup --layer-instant on|off --layer-selection on|off --layer-deep on|off");
      consola.info("  the-brain setup --mlx on|off --llm on|off --output <names>");
      return;
    }
    config = await interactiveWizard(config);
    changed = true;
  }

  // Save
  if (changed) {
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
    consola.success(`Config written to ${configPath}`);

    if (!hasNonInteractiveFlags) {
      consola.info("");
      consola.info("  Next: restart daemon to apply changes");
      consola.info("    the-brain daemon stop && the-brain daemon start");
    }
  }
}

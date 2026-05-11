import { z } from "zod";

// ── Memory Layers ──────────────────────────────────────────────
export enum MemoryLayer {
  INSTANT = "instant",   // Working memory — immediate context injection
  SELECTION = "selection", // The Gatekeeper — filters noise from signal
  DEEP = "deep",          // Long-term consolidation (LoRA, Vector DB, Wiki)
}

// ── Hook Events ─────────────────────────────────────────────────
export const HookEvent = {
  // Data pipeline hooks
  BEFORE_PROMPT: "beforePrompt",
  AFTER_RESPONSE: "afterResponse",
  ON_INTERACTION: "onInteraction",

  // Memory layer hooks
  INSTANT_INJECT: "instant:inject",
  SELECTION_EVALUATE: "selection:evaluate",
  SELECTION_PROMOTE: "selection:promote",
  DEEP_CONSOLIDATE: "deep:consolidate",

  // Lifecycle hooks
  DAEMON_START: "daemon:start",
  DAEMON_STOP: "daemon:stop",
  CONSOLIDATE_START: "consolidate:start",
  CONSOLIDATE_COMPLETE: "consolidate:complete",
  PLUGIN_LOADED: "plugin:loaded",
  PLUGIN_ERROR: "plugin:error",

  // Harvester hooks
  HARVESTER_POLL: "harvester:poll",
  HARVESTER_NEW_DATA: "harvester:newData",

  // Training hooks
  TRAINING_START: "training:start",
  TRAINING_COMPLETE: "training:complete",
  TRAINING_ERROR: "training:error",
} as const;

export type HookEventName =
  | (typeof HookEvent)[keyof typeof HookEvent]
  | (string & {});

// ── Core Types ──────────────────────────────────────────────────

export interface Interaction {
  id: string;
  timestamp: number;
  prompt: string;
  response: string;
  context?: string;
  metadata?: Record<string, unknown>;
  source: string; // e.g., "cursor", "windsurf", "copilot"
}

export interface MemoryFragment {
  id: string;
  layer: MemoryLayer;
  content: string;
  embedding?: number[];
  surpriseScore?: number;
  timestamp: number;
  source: string;
  metadata?: Record<string, unknown>;
}

export interface GraphNode {
  id: string;
  label: string;
  type: "concept" | "correction" | "preference" | "pattern";
  content: string;
  embedding?: number[];
  connections: string[]; // IDs of connected nodes
  weight: number;       // 0-1 relevance
  timestamp: number;
}

export interface SurpriseGateResult {
  isSurprising: boolean;
  score: number;        // 0-1, higher = more surprising/valuable
  predictionError: number;
  reason?: string;
}

export interface ConsolidationResult {
  layer: MemoryLayer;
  fragmentsPromoted: number;
  fragmentsDiscarded: number;
  duration: number;
  errors?: string[];
}

// ── Context for hooks ───────────────────────────────────────────

export interface PromptContext {
  prompt: string;
  injected: string[];
  metadata: Record<string, unknown>;
  inject(text: string): void;
}

export interface InteractionContext {
  interaction: Interaction;
  fragments: MemoryFragment[];
  promoteToDeep(fragment: MemoryFragment): void;
}

export interface ConsolidationContext {
  targetLayer: MemoryLayer;
  fragments: MemoryFragment[];
  results: ConsolidationResult;
  /** Runtime plugin data — plugins can attach extra context during hooks */
  [key: string]: unknown;
}

// ── Plugin Definition ───────────────────────────────────────────

export interface PluginHooks {
  hook(event: HookEventName, handler: (...args: unknown[]) => Promise<void> | void): void;
  callHook(event: HookEventName, ...args: unknown[]): Promise<void>;
  getHandlers(event: HookEventName): Array<(...args: unknown[]) => Promise<void> | void>;
}

export interface PluginDefinition {
  name: string;
  version?: string;
  description?: string;
  setup(hooks: PluginHooks): void | Promise<void>;
  teardown?(): void | Promise<void>;
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  hooks: HookEventName[];
  status: "active" | "inactive" | "error";
  loadedAt?: number;
  error?: string;
}

// ── Database Schema Types ────────────────────────────────────────

export const SessionSchema = z.object({
  id: z.string(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  source: z.string(),
  interactionCount: z.number().default(0),
  metadata: z.record(z.unknown()).optional(),
});

export const MemorySchema = z.object({
  id: z.string(),
  layer: z.nativeEnum(MemoryLayer),
  content: z.string(),
  embedding: z.array(z.number()).optional(),
  surpriseScore: z.number().optional(),
  timestamp: z.number(),
  source: z.string(),
  sessionId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const GraphNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(["concept", "correction", "preference", "pattern"]),
  content: z.string(),
  connections: z.array(z.string()),
  weight: z.number().min(0).max(1),
  timestamp: z.number(),
  source: z.string(),
});

export type Session = z.infer<typeof SessionSchema>;
export type Memory = z.infer<typeof MemorySchema>;
export type GraphNodeRecord = z.infer<typeof GraphNodeSchema>;

// ── Plugin Config ───────────────────────────────────────────────

export interface PluginConfig {
  name: string;
  enabled: boolean;
  config?: Record<string, unknown>;
}

// ── LLM Backend ──────────────────────────────────────────────────

export interface LLMBackend {
  /** Provider identifier: "ollama", "lmstudio", "vllm", "openai", "openai-compatible" */
  provider: string;

  /** Base URL including /v1 prefix.
   *  "http://localhost:11434/v1" (Ollama)
   *  "http://localhost:1234/v1" (LM Studio)
   *  "https://api.openai.com/v1" (OpenAI) */
  baseUrl: string;

  /** API key for cloud providers. Undefined = no auth (local). */
  apiKey?: string;

  /** Primary model to use when not specified per-call */
  defaultModel: string;

  /** Fallback cascade — tried in order if primary fails.
   *  Example: ["qwen2.5:7b", "qwen2.5:3b"] */
  fallbackModels?: string[];

  /** Request timeout in ms (default: 30000) */
  timeoutMs?: number;
}

export interface LLMConfig {
  /** Name of the default backend to use */
  default: string;
  /** Named backends — plugins reference by name */
  backends: Record<string, LLMBackend>;
}

export interface ProjectContext {
  name: string;           // Machine-friendly slug (e.g., "e-commerce", "ml-research")
  label?: string;         // Human-friendly name (e.g., "E-Commerce App")
  dbPath: string;         // Path to SQLite database
  wikiDir: string;        // Path to wiki output
  loraDir?: string;       // Path to LoRA checkpoints
  workDir?: string;       // Root directory for project detection
  createdAt: number;      // Timestamp of creation
  lastActive?: number;    // Timestamp of last context switch
}

export interface TheBrainConfig {
  plugins: PluginConfig[];
  /** Pluggable backend overrides (config-driven swapping) */
  backends?: {
    storage?: string;       // module path for StorageBackend factory
    cleaner?: string;       // module path for ContentCleanerPlugin factory
    scheduler?: string;     // module path for SchedulerPlugin factory
    outputs?: string[];     // module paths for OutputPlugin factories
  };
  daemon: {
    pollIntervalMs: number;
    logDir: string;
  };
  database: {
    path: string;         // Default/legacy database path
  };
  mlx: {
    enabled: boolean;
    modelPath?: string;
    loraOutputDir?: string;
    schedule?: string;
  };
  wiki: {
    enabled: boolean;
    outputDir: string;
    schedule?: string;
  };
  // Server config (remote mode)
  server: {
    /** "local" (default) or "remote" — enables auth + network binding */
    mode: "local" | "remote";
    /** Bind address for the API server (default: 127.0.0.1 for local, 0.0.0.0 for remote) */
    bindAddress: string;
    /** Auth token for remote API access. Auto-generated on init. */
    authToken?: string;
    /** Override daemon API port (default: 9420) */
    port?: number;
    /** Override MCP SSE port (default: 9422) */
    mcpPort?: number;
  };
  // Multi-project support
  activeContext: string;                    // "global" or project name
  contexts: Record<string, ProjectContext>; // Map of context name → config
  /** Explicitly enabled extension names (empty = none loaded by default) */
  extensions?: string[];
  /** LLM backends for plugins that need AI inference (data-curator, trainers, etc.) */
  llm?: LLMConfig;
}

// ── Zod Schemas (runtime validation) ────────

export const ProjectContextSchema = z.object({
  name: z.string(),
  label: z.string().optional(),
  dbPath: z.string(),
  wikiDir: z.string(),
  loraDir: z.string().optional(),
  workDir: z.string().optional(),
  createdAt: z.number(),
  lastActive: z.number().optional(),
});

export const LLMBackendSchema = z.object({
  provider: z.string(),
  baseUrl: z.string(),
  apiKey: z.string().optional(),
  defaultModel: z.string(),
  fallbackModels: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const LLMConfigSchema = z.object({
  default: z.string(),
  backends: z.record(LLMBackendSchema),
});

export const TheBrainConfigSchema = z.object({
  plugins: z.array(z.object({
    name: z.string(),
    enabled: z.boolean(),
    config: z.record(z.unknown()).optional(),
  })),
  backends: z.object({
    storage: z.string().optional(),
    cleaner: z.string().optional(),
    scheduler: z.string().optional(),
    outputs: z.array(z.string()).optional(),
  }).optional(),
  daemon: z.object({
    pollIntervalMs: z.number().positive(),
    logDir: z.string(),
  }),
  database: z.object({
    path: z.string(),
  }),
  mlx: z.object({
    enabled: z.boolean(),
    modelPath: z.string().optional(),
    loraOutputDir: z.string().optional(),
    schedule: z.string().optional(),
  }),
  wiki: z.object({
    enabled: z.boolean(),
    outputDir: z.string(),
    schedule: z.string().optional(),
  }),
  server: z.object({
    mode: z.enum(["local", "remote"]).default("local"),
    bindAddress: z.string().default("127.0.0.1"),
    authToken: z.string().optional(),
    port: z.number().int().positive().optional(),
    mcpPort: z.number().int().positive().optional(),
  }).default({}),
  extensions: z.array(z.string()).optional(),
  llm: LLMConfigSchema.optional(),
  activeContext: z.string().default("global"),
  contexts: z.record(ProjectContextSchema).default({}),
});

/** Parse and validate config.json at runtime. Returns parsed config or throws ZodError. */
export function parseConfig(raw: unknown): TheBrainConfig {
  return TheBrainConfigSchema.parse(raw);
}

/**
 * Generate a cryptographically secure auth token.
 * Format: mb_<32-char-hex>
 */
export function generateAuthToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  return `mb_${hex}`;
}

// ── Meta-Harness Integration Types ──────────────────────────────

/** Per-model per-benchmark performance fingerprint (Phase 2: Regression Fingerprinting) */
export interface BenchmarkFingerprintData {
  modelName: string;
  benchmark: string;
  metric: string;
  mean: number;
  std: number;
  n: number;
  lastUpdated: number;
  values: number[];
}

/** Prediction for how a harness edit should affect benchmark scores */
export interface RegressionPrediction {
  modelName: string;
  benchmark: string;
  metric: string;
  /** Predicted score range (±2σ) */
  predictedRange: [number, number];
  /** Confidence in prediction (0-1, grows with sample count) */
  confidence: number;
  /** Is this model+benchmark new (no baseline yet)? */
  isColdStart: boolean;
  /** Standard deviation of the baseline */
  baselineStd: number;
}

/** Result of comparing actual score against prediction */
export interface SurpriseAssessment {
  prediction: RegressionPrediction;
  observed: number;
  zScore: number;
  isAnomalous: boolean;
  /** Surprise score (0-1) for SPM curator */
  surpriseScore: number;
}

/** Harness edit metadata attached to interactions */
export interface HarnessEditMetadata {
  editId: string;
  description: string;
  component: "tools" | "middleware" | "memory" | "system_prompt" | "other";
  prediction?: RegressionPrediction;
  previousScore?: number;
}

/** Safe parse — returns result object with success/error, never throws. */
export function safeParseConfig(raw: unknown): { success: true; data: TheBrainConfig } | { success: false; error: string } {
  const result = TheBrainConfigSchema.safeParse(raw);
  if (result.success) return result;
  return { success: false, error: result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") };
}

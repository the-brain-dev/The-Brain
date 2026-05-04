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

export type HookEventName = (typeof HookEvent)[keyof typeof HookEvent];

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
}

// ── Plugin Definition ───────────────────────────────────────────

export interface PluginHooks {
  hook(event: HookEventName, handler: (...args: any[]) => Promise<void> | void): void;
  callHook(event: HookEventName, ...args: any[]): Promise<void>;
  getHandlers(event: HookEventName): Array<(...args: any[]) => Promise<void> | void>;
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

export interface MyBrainConfig {
  plugins: PluginConfig[];
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
  // Multi-project support
  activeContext: string;                    // "global" or project name
  contexts: Record<string, ProjectContext>; // Map of context name → config
}

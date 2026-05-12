// @the-brain-dev/core — Main entry point
export { createHookSystem } from "./hooks";
export { PluginManager, definePlugin } from "./plugin";
export { BrainDB } from "./db/index";
export { AuthDB } from "./auth-db";
export { LayerRouter } from "./layers/index";
export { ProjectManager } from "./context";
export { TheBrainConfigSchema, ProjectContextSchema, LLMBackendSchema, LLMConfigSchema, parseConfig, safeParseConfig, generateAuthToken } from "./types";
export { TestHarness } from "./test-harness";
export type { HarnessOptions, HarnessState } from "./test-harness";
export { loadPrompt, listPrompts, renderPrompt } from "./prompts";
export type { PromptFrontmatter, LoadedPrompt } from "./prompts";
export { ExtensionLoader, getExtensionCommands } from "./extensions";
export type { BrainAPI, ExtensionContext } from "./extensions";
export { LocalBrainDir } from "./local-brain";
export type { LocalBrainState } from "./local-brain";
export { MemoryLayer, HookEvent } from "./types";
export { UserRole, UserScope } from "./auth-types";
export { PermissionResolver } from "./auth-permissions";
export type {
  HookEventName,
  Interaction,
  MemoryFragment,
  GraphNode,
  SurpriseGateResult,
  ConsolidationResult,
  PromptContext,
  InteractionContext,
  ConsolidationContext,
  PluginHooks,
  PluginDefinition,
  PluginManifest,
  PluginConfig,
  TheBrainConfig,
  PipelineConfig,
  LLMBackend,
  LLMConfig,
  Session,
  Memory,
  GraphNodeRecord,
  ProjectContext,
} from "./types";
export type {
  InstantLayerPlugin,
  SelectionLayerPlugin,
  DeepLayerPlugin,
  HarvesterPlugin,
  ContentCleanerPlugin,
  CleanedContent,
  StorageBackend,
  SchedulerPlugin,
  SchedulerHandle,
  OutputPlugin,
  OutputGenerateContext,
  OutputResult,
} from "./layers/index";
export type {
  User,
  UserPermission,
  AuthToken,
  AuditEntry,
} from "./auth-types";
export { createDefaultCleaner } from "./cleaner-default";
export { createSqliteBackend } from "./storage-sqlite";
export { createIntervalScheduler } from "./scheduler-interval";
export { resolveBackends } from "./backend-resolver";
export type { BackendConfig } from "./backend-resolver";
export type { DBMap } from "./context";
export { cleanMemoryContent, cleanGraphNodeLabel, deduplicateContents } from "./content-cleaner";
export type { CleanedContent as ContentCleanerLegacy } from "./content-cleaner";
export { generateText } from "./llm-client";
export type { GenerateOptions } from "./llm-client";

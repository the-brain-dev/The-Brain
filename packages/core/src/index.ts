// @my-brain/core — Main entry point
export { createHookSystem } from "./hooks";
export { PluginManager, definePlugin } from "./plugin";
export { BrainDB } from "./db/index";
export { LayerRouter } from "./layers/index";
export { ProjectManager } from "./context";
export { TestHarness } from "./test-harness";
export type { HarnessOptions, HarnessState } from "./test-harness";
export { loadPrompt, listPrompts, renderPrompt } from "./prompts";
export type { PromptFrontmatter, LoadedPrompt } from "./prompts";
export { ExtensionLoader } from "./extensions";
export type { BrainAPI, ExtensionContext } from "./extensions";
export { LocalBrainDir } from "./local-brain";
export type { LocalBrainState } from "./local-brain";
export { MemoryLayer, HookEvent } from "./types";
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
  MyBrainConfig,
  ProjectContext,
  Session,
  Memory,
  GraphNodeRecord,
  InstantLayerPlugin,
  SelectionLayerPlugin,
  DeepLayerPlugin,
  HarvesterPlugin,
} from "./types";
export type { DBMap } from "./context";
export { cleanMemoryContent, cleanGraphNodeLabel, deduplicateContents } from "./content-cleaner";
export type { CleanedContent } from "./content-cleaner";

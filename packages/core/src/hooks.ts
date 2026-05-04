import { createHooks } from "hookable";
import type { HookEventName, PluginHooks } from "./types";

/**
 * Hook system wrapping hookable with type-safe event dispatch.
 * This is the central nervous system of my-brain — all plugins
 * communicate through this hook bus.
 */
export function createHookSystem(): PluginHooks {
  const hooks = createHooks();

  return {
    hook(
      event: HookEventName,
      handler: (...args: any[]) => Promise<void> | void
    ): void {
      hooks.hook(event, handler as any);
    },

    async callHook(
      event: HookEventName,
      ...args: any[]
    ): Promise<void> {
      await hooks.callHook(event, ...args);
    },

    getHandlers(
      event: HookEventName
    ): Array<(...args: any[]) => Promise<void> | void> {
      // hookable stores handlers internally; this is a convenience wrapper
      return (hooks as any)._hooks?.[event] ?? [];
    },
  };
}

export type { PluginHooks };

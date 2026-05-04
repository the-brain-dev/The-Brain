import type {
  PluginDefinition,
  PluginManifest,
  PluginHooks,
  MyBrainConfig,
} from "./types";

/**
 * PluginManager — loads, activates, and manages lifecycle
 * of all plugins in the my-brain ecosystem.
 */
export class PluginManager {
  private plugins = new Map<string, { definition: PluginDefinition; manifest: PluginManifest }>();
  private hooks: PluginHooks;

  constructor(hooks: PluginHooks) {
    this.hooks = hooks;
  }

  /**
   * Register and activate a plugin.
   */
  async load(plugin: PluginDefinition): Promise<PluginManifest> {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already loaded`);
    }

    const manifest: PluginManifest = {
      name: plugin.name,
      version: plugin.version ?? "0.0.0",
      description: plugin.description ?? "",
      hooks: [],
      status: "active",
      loadedAt: Date.now(),
    };

    try {
      // Create scoped hooks that track which hooks this plugin registers
      const scopedHooks = this.createScopedHooks(plugin.name, manifest);

      // Let the plugin set up its hooks
      await plugin.setup(scopedHooks);

      this.plugins.set(plugin.name, { definition: plugin, manifest });

      // Emit plugin loaded event
      await this.hooks.callHook("plugin:loaded" as any, manifest);

      return manifest;
    } catch (error) {
      manifest.status = "error";
      manifest.error = error instanceof Error ? error.message : String(error);
      await this.hooks.callHook("plugin:error" as any, manifest, error);
      throw error;
    }
  }

  /**
   * Unload a plugin and call its teardown.
   */
  async unload(name: string): Promise<void> {
    const entry = this.plugins.get(name);
    if (!entry) return;

    if (entry.definition.teardown) {
      await entry.definition.teardown();
    }

    entry.manifest.status = "inactive";
    this.plugins.delete(name);
  }

  /**
   * Get all loaded plugin manifests.
   */
  list(): PluginManifest[] {
    return Array.from(this.plugins.values()).map((e) => e.manifest);
  }

  /**
   * Get a specific plugin manifest.
   */
  get(name: string): PluginManifest | undefined {
    return this.plugins.get(name)?.manifest;
  }

  /**
   * Activate plugins based on config (enable/disable).
   */
  async loadFromConfig(
    plugins: PluginDefinition[],
    config: MyBrainConfig
  ): Promise<PluginManifest[]> {
    const manifests: PluginManifest[] = [];
    const configMap = new Map(
      config.plugins.map((p) => [p.name, p])
    );

    for (const plugin of plugins) {
      const pluginConfig = configMap.get(plugin.name);
      if (pluginConfig?.enabled !== false) {
        manifests.push(await this.load(plugin));
      }
    }

    return manifests;
  }

  /**
   * Create scoped hooks that automatically track which events
   * this plugin subscribes to, for introspection and debugging.
   */
  private createScopedHooks(
    pluginName: string,
    manifest: PluginManifest
  ): PluginHooks {
    const self = this;

    return {
      hook(event, handler) {
        if (!manifest.hooks.includes(event)) {
          manifest.hooks.push(event);
        }
        self.hooks.hook(event, handler);
      },
      callHook(event, ...args) {
        return self.hooks.callHook(event, ...args);
      },
      getHandlers(event) {
        return self.hooks.getHandlers(event);
      },
    };
  }

  /**
   * Cleanly shutdown all plugins.
   */
  async shutdown(): Promise<void> {
    for (const [name] of this.plugins) {
      await this.unload(name);
    }
  }
}

/**
 * Helper to define a plugin with full type safety.
 * Usage:
 *   export default definePlugin({
 *     name: 'my-plugin',
 *     setup(hooks) { ... }
 *   })
 */
export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def;
}

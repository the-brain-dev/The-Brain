import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
  createHookSystem,
  PluginManager,
  definePlugin,
  LayerRouter,
  MemoryLayer,
  HookEvent,
} from "@the-brain/core";
import type {
  PluginDefinition,
  PluginManifest,
  PluginHooks,
  TheBrainConfig,
  PromptContext,
  InteractionContext,
  ConsolidationContext,
  MemoryFragment,
  SurpriseGateResult,
  InstantLayerPlugin,
  SelectionLayerPlugin,
  DeepLayerPlugin,
} from "@the-brain/core";

// ── Helpers ─────────────────────────────────────────────────────

function makePromptContext(
  overrides: Partial<PromptContext> = {}
): PromptContext {
  const injected: string[] = [];
  return {
    prompt: "test prompt",
    injected,
    metadata: {},
    inject(text: string): void {
      injected.push(text);
    },
    ...overrides,
  };
}

function makeInteractionContext(
  overrides: Partial<InteractionContext> = {}
): InteractionContext {
  const promoted: MemoryFragment[] = [];
  return {
    interaction: {
      id: "int-1",
      timestamp: Date.now(),
      prompt: "test",
      response: "test response",
      source: "test",
    },
    fragments: [],
    promoteToDeep(fragment: MemoryFragment): void {
      promoted.push(fragment);
    },
    ...overrides,
  };
}

function makeConsolidationContext(
  overrides: Partial<ConsolidationContext> = {}
): ConsolidationContext {
  return {
    targetLayer: MemoryLayer.DEEP,
    fragments: [],
    results: {
      layer: MemoryLayer.DEEP,
      fragmentsPromoted: 0,
      fragmentsDiscarded: 0,
      duration: 0,
    },
    ...overrides,
  };
}

function defaultConfig(overrides: Partial<TheBrainConfig> = {}): TheBrainConfig {
  return {
    plugins: [],
    daemon: { pollIntervalMs: 5000, logDir: "/tmp" },
    database: { path: ":memory:" },
    mlx: { enabled: false },
    wiki: { enabled: false, outputDir: "/tmp" },
    ...overrides,
  };
}

// ── createHookSystem ────────────────────────────────────────────

describe("createHookSystem", () => {
  let hooks: PluginHooks;

  beforeEach(() => {
    hooks = createHookSystem();
  });

  test("getHandlers on non-existent event returns []", () => {
    expect(hooks.getHandlers("beforePrompt" as any)).toEqual([]);
    expect(hooks.getHandlers("plugin:loaded" as any)).toEqual([]);
  });

  test("hook() registers a handler and getHandlers returns it", () => {
    const handler = () => {};
    hooks.hook("beforePrompt" as any, handler);
    const handlers = hooks.getHandlers("beforePrompt" as any);
    expect(handlers).toHaveLength(1);
    expect(handlers[0]).toBe(handler);
  });

  test("callHook invokes handler with args", async () => {
    const received: unknown[] = [];
    hooks.hook("beforePrompt" as any, async (...args: any[]) => {
      received.push(args);
    });
    await hooks.callHook("beforePrompt" as any, "hello", 42);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(["hello", 42]);
  });

  test("multiple handlers for same event are all called", async () => {
    const calls: string[] = [];
    hooks.hook("onInteraction" as any, async () => {
      calls.push("A");
    });
    hooks.hook("onInteraction" as any, async () => {
      calls.push("B");
    });
    hooks.hook("onInteraction" as any, async () => {
      calls.push("C");
    });

    await hooks.callHook("onInteraction" as any);

    // All three handlers should have been called
    expect(calls).toHaveLength(3);
    expect(calls).toContain("A");
    expect(calls).toContain("B");
    expect(calls).toContain("C");
  });

  test("getHandlers returns all handlers for an event", () => {
    const h1 = () => {};
    const h2 = () => {};
    hooks.hook("beforePrompt" as any, h1);
    hooks.hook("beforePrompt" as any, h2);
    expect(hooks.getHandlers("beforePrompt" as any)).toEqual([h1, h2]);
  });

  test("async handlers complete before callHook resolves", async () => {
    const order: string[] = [];
    let resolveDelayed: (() => void) | null = null;
    const delayed = new Promise<void>((r) => { resolveDelayed = r; });

    hooks.hook("test:event" as any, async () => {
      order.push("start");
      await delayed;
      order.push("end");
    });

    const callPromise = hooks.callHook("test:event" as any);
    // Give the handler a chance to start
    await new Promise((r) => setTimeout(r, 10));

    expect(order).toEqual(["start"]);
    // Handler hasn't finished yet
    resolveDelayed!();
    await callPromise;
    expect(order).toEqual(["start", "end"]);
  });

  test("handlers are called serially (default hookable behavior)", async () => {
    const order: string[] = [];
    // Use promises to control timing
    const resolves: Array<() => void> = [];

    hooks.hook("serial:test" as any, async () => {
      order.push("first-enter");
      await new Promise<void>((r) => { resolves.push(r); });
      order.push("first-exit");
    });
    hooks.hook("serial:test" as any, async () => {
      order.push("second-enter");
      await new Promise<void>((r) => { resolves.push(r); });
      order.push("second-exit");
    });

    const done = hooks.callHook("serial:test" as any);

    // Wait a tick so first handler starts
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["first-enter"]);

    // Resolve first handler
    resolves[0]();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);

    // Resolve second handler
    resolves[1]();
    await done;
    expect(order).toEqual([
      "first-enter",
      "first-exit",
      "second-enter",
      "second-exit",
    ]);
  });

  test("handlers for different events are independent", async () => {
    const calls: string[] = [];
    hooks.hook("event:A" as any, async () => { calls.push("A"); });
    hooks.hook("event:B" as any, async () => { calls.push("B"); });

    await hooks.callHook("event:A" as any);
    expect(calls).toEqual(["A"]);

    await hooks.callHook("event:B" as any);
    expect(calls).toEqual(["A", "B"]);
  });

  test("callHook with no registered handlers does not throw", async () => {
    await expect(
      hooks.callHook("nonexistent" as any)
    ).resolves.toBeUndefined();
  });

  test("synchronous handlers are supported", async () => {
    const calls: string[] = [];
    hooks.hook("sync:test" as any, () => {
      calls.push("sync");
    });
    await hooks.callHook("sync:test" as any);
    expect(calls).toEqual(["sync"]);
  });

  test("hook returns void (wrapper drops hookable's unregister fn)", () => {
    const handler = mock(() => {});
    const result = hooks.hook("test:event" as any, handler);

    // createHookSystem wraps hookable.hook() but declares void return
    // and does not pass through the unregister function — this is by design
    expect(result).toBeUndefined();
  });
});

// ── PluginManager ───────────────────────────────────────────────

describe("PluginManager", () => {
  let hooks: PluginHooks;
  let manager: PluginManager;

  beforeEach(() => {
    hooks = createHookSystem();
    manager = new PluginManager(hooks);
  });

  describe("constructor", () => {
    test("accepts PluginHooks and stores them", () => {
      const m = new PluginManager(hooks);
      expect(m).toBeInstanceOf(PluginManager);
    });
  });

  describe("load()", () => {
    test("returns manifest with correct fields", async () => {
      const plugin: PluginDefinition = {
        name: "test-plugin",
        version: "1.2.3",
        description: "A test plugin",
        setup(_hooks: PluginHooks) {},
      };

      const manifest = await manager.load(plugin);

      expect(manifest.name).toBe("test-plugin");
      expect(manifest.version).toBe("1.2.3");
      expect(manifest.description).toBe("A test plugin");
      expect(manifest.status).toBe("active");
      expect(manifest.hooks).toEqual([]);
      expect(typeof manifest.loadedAt).toBe("number");
      expect(manifest.loadedAt).toBeGreaterThan(0);
      expect(manifest.error).toBeUndefined();
    });

    test("uses defaults when version and description are missing", async () => {
      const plugin: PluginDefinition = {
        name: "minimal",
        setup() {},
      };

      const manifest = await manager.load(plugin);
      expect(manifest.version).toBe("0.0.0");
      expect(manifest.description).toBe("");
    });

    test("emits 'plugin:loaded' hook with manifest", async () => {
      const loadedEvents: PluginManifest[] = [];
      hooks.hook("plugin:loaded" as any, async (m: PluginManifest) => {
        loadedEvents.push(m);
      });

      const plugin: PluginDefinition = {
        name: "loaded-plugin",
        setup() {},
      };

      await manager.load(plugin);
      expect(loadedEvents).toHaveLength(1);
      expect(loadedEvents[0].name).toBe("loaded-plugin");
      expect(loadedEvents[0].status).toBe("active");
    });

    test("duplicate name throws Error", async () => {
      const plugin: PluginDefinition = {
        name: "dup",
        setup() {},
      };

      await manager.load(plugin);
      await expect(manager.load(plugin)).rejects.toThrow(
        'Plugin "dup" is already loaded'
      );
    });

    test("duplicate name does not emit a second loaded event", async () => {
      const loadedEvents: PluginManifest[] = [];
      hooks.hook("plugin:loaded" as any, async (m: PluginManifest) => {
        loadedEvents.push(m);
      });

      const plugin: PluginDefinition = {
        name: "once",
        setup() {},
      };

      await manager.load(plugin);
      expect(loadedEvents).toHaveLength(1);

      await expect(manager.load(plugin)).rejects.toThrow();
      expect(loadedEvents).toHaveLength(1); // no second event
    });

    test("setup that throws → manifest.status='error', emits 'plugin:error', rethrows", async () => {
      const errorEvents: Array<{ manifest: PluginManifest; error: unknown }> =
        [];
      hooks.hook(
        "plugin:error" as any,
        async (m: PluginManifest, err: unknown) => {
          errorEvents.push({ manifest: m, error: err });
        }
      );

      const plugin: PluginDefinition = {
        name: "faulty",
        setup() {
          throw new Error("Setup exploded");
        },
      };

      await expect(manager.load(plugin)).rejects.toThrow("Setup exploded");

      // Check error event was emitted
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].manifest.name).toBe("faulty");
      expect(errorEvents[0].manifest.status).toBe("error");
      expect(errorEvents[0].manifest.error).toBe("Setup exploded");
      expect(errorEvents[0].error).toBeInstanceOf(Error);
    });

    test("setup that throws async → same error handling", async () => {
      const errorEvents: PluginManifest[] = [];
      hooks.hook("plugin:error" as any, async (m: PluginManifest) => {
        errorEvents.push(m);
      });

      const plugin: PluginDefinition = {
        name: "async-fault",
        async setup() {
          throw new Error("Async boom");
        },
      };

      await expect(manager.load(plugin)).rejects.toThrow("Async boom");
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].name).toBe("async-fault");
      expect(errorEvents[0].status).toBe("error");
      expect(errorEvents[0].error).toBe("Async boom");
    });

    test("setup with non-Error throw → error message as string", async () => {
      const errorEvents: PluginManifest[] = [];
      hooks.hook("plugin:error" as any, async (m: PluginManifest) => {
        errorEvents.push(m);
      });

      const plugin: PluginDefinition = {
        name: "raw-throw",
        setup() {
          throw "raw string error";
        },
      };

      await expect(manager.load(plugin)).rejects.toBe("raw string error");
      expect(errorEvents[0].error).toBe("raw string error");
    });

    test("scoped hooks track subscribed events in manifest", async () => {
      const plugin: PluginDefinition = {
        name: "tracked",
        setup(h: PluginHooks) {
          h.hook("beforePrompt" as any, () => {});
          h.hook("afterResponse" as any, () => {});
          h.hook("beforePrompt" as any, () => {}); // duplicate should not be added again
        },
      };

      const manifest = await manager.load(plugin);
      // Only unique event names should be tracked
      expect(manifest.hooks).toEqual(["beforePrompt", "afterResponse"]);
    });

    test("scoped hooks callHook delegates to main hooks", async () => {
      const calls: string[] = [];
      hooks.hook("test:delegated" as any, async (msg: string) => {
        calls.push(msg);
      });

      const plugin: PluginDefinition = {
        name: "delegator",
        async setup(h: PluginHooks) {
          await h.callHook("test:delegated" as any, "from-plugin");
        },
      };

      await manager.load(plugin);
      expect(calls).toEqual(["from-plugin"]);
    });

    test("scoped hooks getHandlers delegates to main hooks", async () => {
      const handler = () => {};
      hooks.hook("test:lookup" as any, handler);

      let retrieved: Array<(...args: any[]) => Promise<void> | void> = [];
      const plugin: PluginDefinition = {
        name: "lookup",
        setup(h: PluginHooks) {
          retrieved = h.getHandlers("test:lookup" as any);
        },
      };

      await manager.load(plugin);
      expect(retrieved).toContain(handler);
    });
  });

  describe("unload()", () => {
    test("calls teardown, sets inactive, removes from list", async () => {
      let teardownCalled = false;
      const plugin: PluginDefinition = {
        name: "to-unload",
        setup() {},
        teardown() {
          teardownCalled = true;
        },
      };

      await manager.load(plugin);
      expect(manager.list()).toHaveLength(1);

      await manager.unload("to-unload");
      expect(teardownCalled).toBe(true);
      expect(manager.list()).toHaveLength(0);
      expect(manager.get("to-unload")).toBeUndefined();
    });

    test("on unknown name is no-op (does not throw)", async () => {
      await expect(
        manager.unload("nonexistent")
      ).resolves.toBeUndefined();
      expect(manager.list()).toHaveLength(0);
    });

    test("plugin without teardown function unloads cleanly", async () => {
      const plugin: PluginDefinition = {
        name: "no-teardown",
        setup() {},
        // no teardown
      };

      await manager.load(plugin);
      expect(manager.list()).toHaveLength(1);

      await manager.unload("no-teardown");
      expect(manager.list()).toHaveLength(0);
    });

    test("async teardown is awaited", async () => {
      const order: string[] = [];
      const plugin: PluginDefinition = {
        name: "async-teardown",
        setup() {},
        async teardown() {
          order.push("teardown-start");
          await new Promise((r) => setTimeout(r, 50));
          order.push("teardown-end");
        },
      };

      await manager.load(plugin);
      order.push("before-unload");
      await manager.unload("async-teardown");
      order.push("after-unload");

      // teardown should complete before after-unload
      expect(order).toEqual([
        "before-unload",
        "teardown-start",
        "teardown-end",
        "after-unload",
      ]);
    });

    test("manifest status is set to 'inactive' after unload", async () => {
      const plugin: PluginDefinition = {
        name: "status-check",
        setup() {},
      };

      const manifest = await manager.load(plugin);
      expect(manifest.status).toBe("active");

      await manager.unload("status-check");
      expect(manifest.status).toBe("inactive");
    });
  });

  describe("list()", () => {
    test("returns empty array with no plugins", () => {
      expect(manager.list()).toEqual([]);
    });

    test("returns all manifests", async () => {
      await manager.load({ name: "p1", setup() {} });
      await manager.load({ name: "p2", setup() {} });
      await manager.load({ name: "p3", setup() {} });

      const list = manager.list();
      expect(list).toHaveLength(3);
      expect(list.map((m) => m.name).sort()).toEqual(["p1", "p2", "p3"]);
    });

    test("does not include unloaded plugins", async () => {
      await manager.load({ name: "keep", setup() {} });
      await manager.load({ name: "remove", setup() {} });
      await manager.unload("remove");

      const list = manager.list();
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe("keep");
    });
  });

  describe("get()", () => {
    test("returns undefined for unknown plugin", () => {
      expect(manager.get("nope")).toBeUndefined();
    });

    test("returns manifest for known plugin", async () => {
      await manager.load({ name: "known", setup() {} });
      const m = manager.get("known");
      expect(m).toBeDefined();
      expect(m!.name).toBe("known");
      expect(m!.status).toBe("active");
    });

    test("returns undefined after plugin is unloaded", async () => {
      await manager.load({ name: "transient", setup() {} });
      expect(manager.get("transient")).toBeDefined();
      await manager.unload("transient");
      expect(manager.get("transient")).toBeUndefined();
    });
  });

  describe("loadFromConfig()", () => {
    test("only loads enabled plugins", async () => {
      const plugins: PluginDefinition[] = [
        { name: "enabled-1", setup() {} },
        { name: "disabled-1", setup() {} },
        { name: "enabled-2", setup() {} },
      ];

      const config = defaultConfig({
        plugins: [
          { name: "enabled-1", enabled: true },
          { name: "disabled-1", enabled: false },
          { name: "enabled-2", enabled: true },
        ],
      });

      const manifests = await manager.loadFromConfig(plugins, config);
      expect(manifests).toHaveLength(2);
      expect(manifests.map((m) => m.name).sort()).toEqual([
        "enabled-1",
        "enabled-2",
      ]);
    });

    test("loads plugins not in config (enabled by default)", async () => {
      const plugins: PluginDefinition[] = [
        { name: "in-config", setup() {} },
        { name: "not-in-config", setup() {} },
      ];

      const config = defaultConfig({
        plugins: [{ name: "in-config", enabled: true }],
      });

      const manifests = await manager.loadFromConfig(plugins, config);
      expect(manifests).toHaveLength(2);
      expect(manifests.map((m) => m.name).sort()).toEqual([
        "in-config",
        "not-in-config",
      ]);
    });

    test("returns empty array when all are disabled", async () => {
      const plugins: PluginDefinition[] = [
        { name: "off-1", setup() {} },
        { name: "off-2", setup() {} },
      ];

      const config = defaultConfig({
        plugins: [
          { name: "off-1", enabled: false },
          { name: "off-2", enabled: false },
        ],
      });

      const manifests = await manager.loadFromConfig(plugins, config);
      expect(manifests).toEqual([]);
    });

    test("returns empty array when no plugins provided", async () => {
      const manifests = await manager.loadFromConfig([], defaultConfig());
      expect(manifests).toEqual([]);
    });

    test("partial config — only some plugins have config entries", async () => {
      const plugins: PluginDefinition[] = [
        { name: "a", setup() {} },
        { name: "b", setup() {} },
        { name: "c", setup() {} },
      ];

      const config = defaultConfig({
        plugins: [{ name: "b", enabled: false }],
      });

      const manifests = await manager.loadFromConfig(plugins, config);
      expect(manifests).toHaveLength(2);
      expect(manifests.map((m) => m.name).sort()).toEqual(["a", "c"]);
    });
  });

  describe("shutdown()", () => {
    test("unloads all plugins", async () => {
      const teardowns: string[] = [];
      const plugins: PluginDefinition[] = [
        {
          name: "s1",
          setup() {},
          teardown() { teardowns.push("s1"); },
        },
        {
          name: "s2",
          setup() {},
          teardown() { teardowns.push("s2"); },
        },
        {
          name: "s3",
          setup() {},
          teardown() { teardowns.push("s3"); },
        },
      ];

      for (const p of plugins) {
        await manager.load(p);
      }
      expect(manager.list()).toHaveLength(3);

      await manager.shutdown();
      expect(manager.list()).toHaveLength(0);
      expect(teardowns.sort()).toEqual(["s1", "s2", "s3"]);
    });

    test("shutdown with no plugins is a no-op", async () => {
      await expect(manager.shutdown()).resolves.toBeUndefined();
    });

    test("shutdown with already unloaded plugins does not throw", async () => {
      await manager.load({ name: "keep", setup() {} });
      await manager.unload("keep");
      await manager.shutdown(); // should not throw
    });
  });
});

// ── definePlugin ────────────────────────────────────────────────

describe("definePlugin", () => {
  test("returns the same object", () => {
    const def: PluginDefinition = {
      name: "my-plugin",
      version: "1.0.0",
      description: "desc",
      setup() {},
      teardown() {},
    };

    const result = definePlugin(def);
    expect(result).toBe(def);
    expect(result.name).toBe("my-plugin");
    expect(result.version).toBe("1.0.0");
    expect(result.description).toBe("desc");
  });

  test("returns minimal plugin definition as-is", () => {
    const def: PluginDefinition = {
      name: "minimal",
      setup() {},
    };

    expect(definePlugin(def)).toBe(def);
  });
});

// ── LayerRouter ─────────────────────────────────────────────────

describe("LayerRouter", () => {
  let router: LayerRouter;

  beforeEach(() => {
    router = new LayerRouter();
  });

  describe("registerInstant", () => {
    test("adds plugin to instant layer", () => {
      const plugin: InstantLayerPlugin = {
        layer: MemoryLayer.INSTANT,
        async beforePrompt(_ctx: PromptContext) {},
      };
      router.registerInstant(plugin);
      expect(router.getStats().instant).toBe(1);
    });

    test("supports multiple instant plugins", () => {
      const p1: InstantLayerPlugin = {
        layer: MemoryLayer.INSTANT,
        async beforePrompt() {},
      };
      const p2: InstantLayerPlugin = {
        layer: MemoryLayer.INSTANT,
        async beforePrompt() {},
      };
      router.registerInstant(p1);
      router.registerInstant(p2);
      expect(router.getStats().instant).toBe(2);
    });
  });

  describe("registerSelection", () => {
    test("adds plugin to selection layer", () => {
      const plugin: SelectionLayerPlugin = {
        layer: MemoryLayer.SELECTION,
        async evaluate(_ctx: InteractionContext): Promise<SurpriseGateResult> {
          return { isSurprising: false, score: 0, predictionError: 0 };
        },
        async promote(_ctx: InteractionContext): Promise<MemoryFragment[]> {
          return [];
        },
      };
      router.registerSelection(plugin);
      expect(router.getStats().selection).toBe(1);
    });
  });

  describe("registerDeep", () => {
    test("adds plugin to deep layer", () => {
      const plugin: DeepLayerPlugin = {
        layer: MemoryLayer.DEEP,
        async consolidate(_ctx: ConsolidationContext) {},
      };
      router.registerDeep(plugin);
      expect(router.getStats().deep).toBe(1);
    });
  });

  describe("runInstant", () => {
    test("calls beforePrompt on all instant plugins", async () => {
      const calls: string[] = [];
      const p1: InstantLayerPlugin = {
        layer: MemoryLayer.INSTANT,
        async beforePrompt(ctx: PromptContext) {
          calls.push("p1:" + ctx.prompt);
        },
      };
      const p2: InstantLayerPlugin = {
        layer: MemoryLayer.INSTANT,
        async beforePrompt(ctx: PromptContext) {
          calls.push("p2:" + ctx.prompt);
        },
      };

      router.registerInstant(p1);
      router.registerInstant(p2);

      const ctx = makePromptContext({ prompt: "hello world" });
      const result = await router.runInstant(ctx);

      expect(calls).toEqual(["p1:hello world", "p2:hello world"]);
      expect(result).toBe(ctx);
    });

    test("returns context even with no instant plugins", async () => {
      const ctx = makePromptContext();
      const result = await router.runInstant(ctx);
      expect(result).toBe(ctx);
    });

    test("instant plugin can inject into context", async () => {
      const plugin: InstantLayerPlugin = {
        layer: MemoryLayer.INSTANT,
        async beforePrompt(ctx: PromptContext) {
          ctx.inject("injected context");
        },
      };

      router.registerInstant(plugin);
      const ctx = makePromptContext();
      await router.runInstant(ctx);

      expect(ctx.injected).toEqual(["injected context"]);
    });

    test("plugins run serially (first completes before second starts)", async () => {
      const order: string[] = [];
      const resolves: Array<() => void> = [];

      const p1: InstantLayerPlugin = {
        layer: MemoryLayer.INSTANT,
        async beforePrompt() {
          order.push("p1-enter");
          await new Promise<void>((r) => { resolves.push(r); });
          order.push("p1-exit");
        },
      };
      const p2: InstantLayerPlugin = {
        layer: MemoryLayer.INSTANT,
        async beforePrompt() {
          order.push("p2-enter");
          await new Promise<void>((r) => { resolves.push(r); });
          order.push("p2-exit");
        },
      };

      router.registerInstant(p1);
      router.registerInstant(p2);

      const done = router.runInstant(makePromptContext());

      await new Promise((r) => setTimeout(r, 10));
      expect(order).toEqual(["p1-enter"]);

      resolves[0]();
      await new Promise((r) => setTimeout(r, 10));
      expect(order).toEqual(["p1-enter", "p1-exit", "p2-enter"]);

      resolves[1]();
      await done;
      expect(order).toEqual([
        "p1-enter",
        "p1-exit",
        "p2-enter",
        "p2-exit",
      ]);
    });
  });

  describe("runSelection", () => {
    test("evaluates all selection plugins", async () => {
      const evaluates: string[] = [];
      const p1: SelectionLayerPlugin = {
        layer: MemoryLayer.SELECTION,
        async evaluate(ctx: InteractionContext) {
          evaluates.push("p1:" + ctx.interaction.id);
          return { isSurprising: false, score: 0, predictionError: 0 };
        },
        async promote() {
          return [];
        },
      };
      const p2: SelectionLayerPlugin = {
        layer: MemoryLayer.SELECTION,
        async evaluate(ctx: InteractionContext) {
          evaluates.push("p2:" + ctx.interaction.id);
          return { isSurprising: false, score: 0, predictionError: 0 };
        },
        async promote() {
          return [];
        },
      };

      router.registerSelection(p1);
      router.registerSelection(p2);

      const ctx = makeInteractionContext({
        interaction: {
          id: "int-42",
          timestamp: Date.now(),
          prompt: "test",
          response: "resp",
          source: "test",
        },
      });

      const { results, promoted } = await router.runSelection(ctx);

      expect(evaluates).toEqual(["p1:int-42", "p2:int-42"]);
      expect(results).toHaveLength(2);
      expect(results[0].isSurprising).toBe(false);
      expect(results[1].isSurprising).toBe(false);
      expect(promoted).toEqual([]);
    });

    test("promotes fragments from surprising evaluations only", async () => {
      const frag1: MemoryFragment = {
        id: "f1",
        layer: MemoryLayer.INSTANT,
        content: "frag1",
        timestamp: Date.now(),
        source: "test",
      };
      const frag2: MemoryFragment = {
        id: "f2",
        layer: MemoryLayer.INSTANT,
        content: "frag2",
        timestamp: Date.now(),
        source: "test",
      };

      const surprising: SelectionLayerPlugin = {
        layer: MemoryLayer.SELECTION,
        async evaluate() {
          return { isSurprising: true, score: 0.9, predictionError: 0.5 };
        },
        async promote() {
          return [frag1];
        },
      };
      const notSurprising: SelectionLayerPlugin = {
        layer: MemoryLayer.SELECTION,
        async evaluate() {
          return { isSurprising: false, score: 0.1, predictionError: 0.05 };
        },
        async promote() {
          return [frag2];
        },
      };

      router.registerSelection(surprising);
      router.registerSelection(notSurprising);

      const ctx = makeInteractionContext();
      const { results, promoted } = await router.runSelection(ctx);

      expect(results).toHaveLength(2);
      expect(results[0].isSurprising).toBe(true);
      expect(results[1].isSurprising).toBe(false);
      expect(promoted).toEqual([frag1]); // only surprising one promoted
      expect(promoted).not.toContain(frag2);
    });

    test("does not call promote on non-surprising evaluations", async () => {
      let promoteCalled = false;
      const plugin: SelectionLayerPlugin = {
        layer: MemoryLayer.SELECTION,
        async evaluate() {
          return { isSurprising: false, score: 0, predictionError: 0 };
        },
        async promote() {
          promoteCalled = true;
          return [];
        },
      };

      router.registerSelection(plugin);
      const ctx = makeInteractionContext();
      await router.runSelection(ctx);

      expect(promoteCalled).toBe(false);
    });

    test("returns empty promoted when no selection plugins registered", async () => {
      const ctx = makeInteractionContext();
      const { results, promoted } = await router.runSelection(ctx);

      expect(results).toEqual([]);
      expect(promoted).toEqual([]);
    });

    test("multiple surprising plugins: all promoted fragments merged", async () => {
      const f1: MemoryFragment = {
        id: "a",
        layer: MemoryLayer.INSTANT,
        content: "a",
        timestamp: 1,
        source: "t",
      };
      const f2: MemoryFragment = {
        id: "b",
        layer: MemoryLayer.INSTANT,
        content: "b",
        timestamp: 2,
        source: "t",
      };

      const p1: SelectionLayerPlugin = {
        layer: MemoryLayer.SELECTION,
        async evaluate() {
          return { isSurprising: true, score: 0.8, predictionError: 0.3 };
        },
        async promote() {
          return [f1];
        },
      };
      const p2: SelectionLayerPlugin = {
        layer: MemoryLayer.SELECTION,
        async evaluate() {
          return { isSurprising: true, score: 0.7, predictionError: 0.2 };
        },
        async promote() {
          return [f2];
        },
      };

      router.registerSelection(p1);
      router.registerSelection(p2);

      const ctx = makeInteractionContext();
      const { promoted } = await router.runSelection(ctx);

      expect(promoted).toHaveLength(2);
      expect(promoted).toContain(f1);
      expect(promoted).toContain(f2);
    });
  });

  describe("runDeep", () => {
    test("calls consolidate on all deep plugins", async () => {
      const calls: string[] = [];
      const p1: DeepLayerPlugin = {
        layer: MemoryLayer.DEEP,
        async consolidate(ctx: ConsolidationContext) {
          calls.push("p1:" + ctx.targetLayer);
        },
      };
      const p2: DeepLayerPlugin = {
        layer: MemoryLayer.DEEP,
        async consolidate(ctx: ConsolidationContext) {
          calls.push("p2:" + ctx.fragments.length);
        },
      };

      router.registerDeep(p1);
      router.registerDeep(p2);

      const ctx = makeConsolidationContext({
        targetLayer: MemoryLayer.DEEP,
        fragments: [
          { id: "f1", layer: MemoryLayer.INSTANT, content: "x", timestamp: 1, source: "t" },
          { id: "f2", layer: MemoryLayer.INSTANT, content: "y", timestamp: 2, source: "t" },
        ],
      });

      await router.runDeep(ctx);
      expect(calls).toEqual(["p1:deep", "p2:2"]);
    });

    test("returns void (undefined)", async () => {
      const p: DeepLayerPlugin = {
        layer: MemoryLayer.DEEP,
        async consolidate() {},
      };
      router.registerDeep(p);

      const result = await router.runDeep(makeConsolidationContext());
      expect(result).toBeUndefined();
    });

    test("no-op with no deep plugins registered", async () => {
      await expect(
        router.runDeep(makeConsolidationContext())
      ).resolves.toBeUndefined();
    });

    test("deep plugins run serially", async () => {
      const order: string[] = [];
      const resolves: Array<() => void> = [];

      const p1: DeepLayerPlugin = {
        layer: MemoryLayer.DEEP,
        async consolidate() {
          order.push("d1-enter");
          await new Promise<void>((r) => { resolves.push(r); });
          order.push("d1-exit");
        },
      };
      const p2: DeepLayerPlugin = {
        layer: MemoryLayer.DEEP,
        async consolidate() {
          order.push("d2-enter");
          await new Promise<void>((r) => { resolves.push(r); });
          order.push("d2-exit");
        },
      };

      router.registerDeep(p1);
      router.registerDeep(p2);

      const done = router.runDeep(makeConsolidationContext());

      await new Promise((r) => setTimeout(r, 10));
      expect(order).toEqual(["d1-enter"]);

      resolves[0]();
      await new Promise((r) => setTimeout(r, 10));
      expect(order).toEqual(["d1-enter", "d1-exit", "d2-enter"]);

      resolves[1]();
      await done;
      expect(order).toEqual(["d1-enter", "d1-exit", "d2-enter", "d2-exit"]);
    });
  });

  describe("getStats", () => {
    test("empty router returns all zeros", () => {
      expect(router.getStats()).toEqual({
        instant: 0,
        selection: 0,
        deep: 0,
      });
    });

    test("returns counts per layer after registration", () => {
      const inst: InstantLayerPlugin = {
        layer: MemoryLayer.INSTANT,
        async beforePrompt() {},
      };
      const sel: SelectionLayerPlugin = {
        layer: MemoryLayer.SELECTION,
        async evaluate() {
          return { isSurprising: false, score: 0, predictionError: 0 };
        },
        async promote() {
          return [];
        },
      };
      const dp: DeepLayerPlugin = {
        layer: MemoryLayer.DEEP,
        async consolidate() {},
      };

      router.registerInstant(inst);
      router.registerInstant(inst); // duplicate on purpose
      router.registerSelection(sel);
      router.registerDeep(dp);

      expect(router.getStats()).toEqual({
        instant: 2,
        selection: 1,
        deep: 1,
      });
    });
  });
});

// ── MemoryLayer enum ────────────────────────────────────────────

describe("MemoryLayer", () => {
  test("has INSTANT, SELECTION, DEEP values", () => {
    expect(MemoryLayer.INSTANT).toBe("instant");
    expect(MemoryLayer.SELECTION).toBe("selection");
    expect(MemoryLayer.DEEP).toBe("deep");
  });

  test("enum values are distinct", () => {
    const values = Object.values(MemoryLayer);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  test("enum values are the expected strings", () => {
    expect(MemoryLayer.INSTANT).toBeString();
    expect(MemoryLayer.SELECTION).toBeString();
    expect(MemoryLayer.DEEP).toBeString();
  });
});

// ── HookEvent constants ─────────────────────────────────────────

describe("HookEvent", () => {
  test("contains expected hook event names", () => {
    expect(HookEvent.BEFORE_PROMPT).toBe("beforePrompt");
    expect(HookEvent.AFTER_RESPONSE).toBe("afterResponse");
    expect(HookEvent.ON_INTERACTION).toBe("onInteraction");
    expect(HookEvent.INSTANT_INJECT).toBe("instant:inject");
    expect(HookEvent.SELECTION_EVALUATE).toBe("selection:evaluate");
    expect(HookEvent.SELECTION_PROMOTE).toBe("selection:promote");
    expect(HookEvent.DEEP_CONSOLIDATE).toBe("deep:consolidate");
    expect(HookEvent.DAEMON_START).toBe("daemon:start");
    expect(HookEvent.DAEMON_STOP).toBe("daemon:stop");
    expect(HookEvent.CONSOLIDATE_START).toBe("consolidate:start");
    expect(HookEvent.CONSOLIDATE_COMPLETE).toBe("consolidate:complete");
    expect(HookEvent.PLUGIN_LOADED).toBe("plugin:loaded");
    expect(HookEvent.PLUGIN_ERROR).toBe("plugin:error");
    expect(HookEvent.HARVESTER_POLL).toBe("harvester:poll");
    expect(HookEvent.HARVESTER_NEW_DATA).toBe("harvester:newData");
    expect(HookEvent.TRAINING_START).toBe("training:start");
    expect(HookEvent.TRAINING_COMPLETE).toBe("training:complete");
    expect(HookEvent.TRAINING_ERROR).toBe("training:error");
  });

  test("all values are unique strings", () => {
    const values = Object.values(HookEvent);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  test("is frozen / readonly", () => {
    // The object is `as const` (readonly). In TypeScript this is checked
    // at compile time; at runtime, properties can still be overridden
    // unless Object.freeze is used. We just verify the frozen behavior
    // or lack thereof doesn't break expectations.
    expect(() => {
      (HookEvent as any).PLUGIN_LOADED = "other";
    }).not.toThrow();
  });
});

// ── Integration-style: PluginManager + Layers + Hooks ───────────

describe("integration: PluginManager with LayerRouter and HookSystem", () => {
  test("plugin loaded via manager can interact with layer router", async () => {
    const hooks = createHookSystem();
    const manager = new PluginManager(hooks);
    const router = new LayerRouter();

    // Register an instant plugin via the manager's hook system
    const injections: string[] = [];

    const plugin: PluginDefinition = {
      name: "context-injector",
      setup(h: PluginHooks) {
        h.hook("beforePrompt" as any, async (ctx: PromptContext) => {
          injections.push("injected by plugin");
          ctx.inject("from-plugin");
        });
      },
    };

    await manager.load(plugin);

    // Now wire up the hooks to the layer router manually:
    // When beforePrompt is called, the instant layer should trigger
    hooks.hook("beforePrompt" as any, async (ctx: PromptContext) => {
      const instantPlugin: InstantLayerPlugin = {
        layer: MemoryLayer.INSTANT,
        async beforePrompt(c: PromptContext) {
          c.inject("from-router");
        },
      };
      router.registerInstant(instantPlugin);
      await router.runInstant(ctx);
    });

    const ctx = makePromptContext({ prompt: "test integration" });
    await hooks.callHook("beforePrompt" as any, ctx);

    expect(injections).toContain("injected by plugin");
    expect(ctx.injected).toContain("from-plugin");
    expect(ctx.injected).toContain("from-router");
  });

  test("full pipeline: load → hook → run layer", async () => {
    const hooks = createHookSystem();
    const manager = new PluginManager(hooks);
    const router = new LayerRouter();

    // Setup instant layer plugin in router
    router.registerInstant({
      layer: MemoryLayer.INSTANT,
      async beforePrompt(ctx: PromptContext) {
        ctx.inject("instant: working memory");
      },
    });

    // Plugin registers itself to hook into beforePrompt → calls router
    const plugin: PluginDefinition = {
      name: "pipeline-plugin",
      setup(h: PluginHooks) {
        h.hook("beforePrompt" as any, async (ctx: PromptContext) => {
          await router.runInstant(ctx);
        });
      },
    };

    await manager.load(plugin);

    const ctx = makePromptContext({ prompt: "pipeline test" });
    await hooks.callHook("beforePrompt" as any, ctx);

    expect(ctx.injected).toEqual(["instant: working memory"]);
  });

  test("shutdown removes all plugins, layer router unaffected", async () => {
    const hooks = createHookSystem();
    const manager = new PluginManager(hooks);
    const router = new LayerRouter();

    router.registerInstant({
      layer: MemoryLayer.INSTANT,
      async beforePrompt() {},
    });

    await manager.load({ name: "p1", setup() {} });
    await manager.load({ name: "p2", setup() {} });

    expect(manager.list()).toHaveLength(2);
    expect(router.getStats().instant).toBe(1);

    await manager.shutdown();
    expect(manager.list()).toHaveLength(0);
    // Layer router plugins are independent — they persist
    expect(router.getStats().instant).toBe(1);
  });
});

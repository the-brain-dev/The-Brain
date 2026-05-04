/**
 * Tests for @my-brain/plugin-harvester-cursor — Data Harvester
 */
import { describe, test, expect, mock } from "bun:test";
import { HookEvent } from "@my-brain/core";

// Import the default export (it's a definePlugin call)
// We need to handle the dynamic import
describe("createCursorHarvester", () => {
  test("plugin definition has expected shape", async () => {
    const mod = await import("../index");
    const plugin = mod.default || mod;
    expect(plugin.name).toBeDefined();
    expect(typeof plugin.setup).toBe("function");
  });

  test("setup registers harvester and lifecycle hooks", async () => {
    const mod = await import("../index");
    const plugin = mod.default || mod;
    const registered: string[] = [];
    const hooks = {
      hook: (event: string, _fn: Function) => { registered.push(event); },
      callHook: async () => {},
      getHandlers: () => [],
    };

    plugin.setup(hooks as any);
    expect(registered).toContain(HookEvent.DAEMON_START);
    expect(registered).toContain(HookEvent.DAEMON_STOP);
  });
});

describe("@my-brain/plugin-identity-anchor", () => {
  test("createIdentityAnchorPlugin returns plugin definition", async () => {
    const { createIdentityAnchorPlugin } = await import("@my-brain/plugin-identity-anchor");
    const plugin = createIdentityAnchorPlugin();
    expect(plugin.name).toBe("@my-brain/plugin-identity-anchor");
    expect(typeof plugin.setup).toBe("function");
  });

  test("setup registers selection and deep hooks", async () => {
    const { createIdentityAnchorPlugin } = await import("@my-brain/plugin-identity-anchor");
    const plugin = createIdentityAnchorPlugin();
    const registered: string[] = [];
    const hooks = {
      hook: (event: string, _fn: Function) => { registered.push(event); },
      callHook: async () => {},
      getHandlers: () => [],
    };

    plugin.setup(hooks as any);
    expect(registered).toContain(HookEvent.SELECTION_PROMOTE);
    expect(registered).toContain(HookEvent.DEEP_CONSOLIDATE);
  });

  test("accepts custom config", async () => {
    const { createIdentityAnchorPlugin } = await import("@my-brain/plugin-identity-anchor");
    const plugin = createIdentityAnchorPlugin({ minIdentityScore: 0.8, maxAnchorFragments: 20 });
    expect(plugin.name).toBeDefined();
    expect(typeof plugin.teardown).toBe("function");
  });

  test("teardown clears state", async () => {
    const { createIdentityAnchorPlugin } = await import("@my-brain/plugin-identity-anchor");
    const plugin = createIdentityAnchorPlugin();
    expect(() => plugin.teardown!()).not.toThrow();
  });
});

describe("@my-brain/plugin-auto-wiki", () => {
  test("createAutoWikiPlugin returns plugin definition", async () => {
    const { BrainDB } = await import("@my-brain/core");
    const db = new BrainDB(":memory:");
    const { createAutoWikiPlugin } = await import("@my-brain/plugin-auto-wiki");
    const plugin = createAutoWikiPlugin(db);
    expect(plugin.name).toBe("@my-brain/plugin-auto-wiki");
    db.close();
  });

  test("setup registers consolidation hook", async () => {
    const { BrainDB } = await import("@my-brain/core");
    const db = new BrainDB(":memory:");
    const { createAutoWikiPlugin } = await import("@my-brain/plugin-auto-wiki");
    const plugin = createAutoWikiPlugin(db);
    const registered: string[] = [];
    const hooks = {
      hook: (event: string, _fn: Function) => { registered.push(event); },
      callHook: async () => {},
      getHandlers: () => [],
    };

    plugin.setup(hooks as any);
    expect(registered).toContain(HookEvent.CONSOLIDATE_COMPLETE);
    db.close();
  });

  test("accepts custom output directory", async () => {
    const { BrainDB } = await import("@my-brain/core");
    const db = new BrainDB(":memory:");
    const { createAutoWikiPlugin } = await import("@my-brain/plugin-auto-wiki");
    const plugin = createAutoWikiPlugin(db, { outputDir: "/tmp/test-wiki", title: "Test Wiki" });
    expect(plugin.name).toBeDefined();
    db.close();
  });
});

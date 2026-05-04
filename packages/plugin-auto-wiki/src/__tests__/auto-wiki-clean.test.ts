/**
 * Clean auto-wiki tests — no mock.module(), use real in-memory BrainDB
 */
import { describe, test, expect } from "bun:test";
import { BrainDB, MemoryLayer, HookEvent } from "@my-brain/core";
import { createAutoWikiPlugin } from "../index";

describe("auto-wiki plugin", () => {
  test("createAutoWikiPlugin returns plugin definition", () => {
    const db = new BrainDB(":memory:");
    const plugin = createAutoWikiPlugin(db);
    expect(plugin.name).toBe("@my-brain/plugin-auto-wiki");
    expect(typeof plugin.setup).toBe("function");
    db.close();
  });

  test("accepts custom config", () => {
    const db = new BrainDB(":memory:");
    const plugin = createAutoWikiPlugin(db, {
      outputDir: "/tmp/my-wiki",
      title: "Custom Title",
      includeStats: false,
    });
    expect(plugin.name).toBeDefined();
    db.close();
  });

  test("setup registers CONSOLIDATE_COMPLETE hook", () => {
    const db = new BrainDB(":memory:");
    const plugin = createAutoWikiPlugin(db);
    const registered: string[] = [];
    plugin.setup({
      hook: (event: string, _fn: Function) => registered.push(event),
      callHook: async () => {},
      getHandlers: () => [],
    } as any);
    expect(registered).toContain(HookEvent.CONSOLIDATE_COMPLETE);
    db.close();
  });

  test("wiki:generate custom hook is registered", () => {
    const db = new BrainDB(":memory:");
    const plugin = createAutoWikiPlugin(db);
    const registered: string[] = [];
    plugin.setup({
      hook: (event: string, _fn: Function) => registered.push(event),
      callHook: async () => {},
      getHandlers: () => [],
    } as any);
    expect(registered).toContain("wiki:generate");
    db.close();
  });

  test("wiki generation produces markdown output", async () => {
    const db = new BrainDB(":memory:");

    // Seed some data
    await db.insertMemory({
      id: "m1", layer: MemoryLayer.SELECTION, content: "User prefers TypeScript",
      surpriseScore: 0.85, timestamp: Date.now(), source: "cursor",
    });
    await db.insertMemory({
      id: "m2", layer: MemoryLayer.DEEP, content: "Deep consolidated pattern",
      surpriseScore: 0.9, timestamp: Date.now(), source: "cursor",
    });

    const plugin = createAutoWikiPlugin(db, { outputDir: "/tmp/test-wiki", includeStats: true });

    let consolidateHandler: Function | null = null;
    let wikiGenHandler: Function | null = null;
    plugin.setup({
      hook: (event: string, fn: Function) => {
        if (event === HookEvent.CONSOLIDATE_COMPLETE) consolidateHandler = fn;
        if (event === "wiki:generate") wikiGenHandler = fn;
      },
      callHook: async () => {},
      getHandlers: () => [],
    } as any);

    // Trigger wiki generation
    expect(consolidateHandler).not.toBeNull();
    await consolidateHandler!();

    // Trigger manual wiki generation
    const result = await wikiGenHandler!();
    expect(result).toBeDefined();
    expect(result.filepath).toContain("wiki-");
    expect(result.filename).toContain("wiki-");

    db.close();
  });

  test("handles empty database gracefully", async () => {
    const db = new BrainDB(":memory:");
    const plugin = createAutoWikiPlugin(db, { outputDir: "/tmp/test-wiki-empty" });

    let handler: Function | null = null;
    plugin.setup({
      hook: (event: string, fn: Function) => {
        if (event === HookEvent.CONSOLIDATE_COMPLETE) handler = fn;
      },
      callHook: async () => {},
      getHandlers: () => [],
    } as any);

    await handler!();
    // Should not throw
    db.close();
  });
});

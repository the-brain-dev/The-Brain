/**
 * ProjectManager tests — multi-project isolation, context switching, cross-project promotion.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ProjectManager, BrainDB, MemoryLayer } from "@the-brain/core";
import type { TheBrainConfig, ProjectContext } from "@the-brain/core";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";

const TMP_DIR = "/tmp/test-the-brain-context";

beforeAll(async () => {
  await mkdir(TMP_DIR, { recursive: true });
  await mkdir(join(TMP_DIR, "global"), { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

function makeConfig(overrides?: Partial<TheBrainConfig>): TheBrainConfig {
  return {
    plugins: [],
    daemon: { pollIntervalMs: 30000, logDir: join(TMP_DIR, "logs") },
    database: { path: ":memory:" },
    mlx: { enabled: false, loraOutputDir: join(TMP_DIR, "global", "lora") },
    wiki: { enabled: true, outputDir: join(TMP_DIR, "global", "wiki") },
    activeContext: "global",
    contexts: {},
    ...overrides,
  };
}

async function ensureProjectDir(name: string) {
  const dir = join(TMP_DIR, "projects", name);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("ProjectManager", () => {
  test("default context is global", () => {
    const config = makeConfig();
    const pm = new ProjectManager(config);
    expect(pm.getActiveProjectName()).toBeNull();
    pm.close();
  });

  test("registerProject adds to contexts", () => {
    const config = makeConfig();
    const pm = new ProjectManager(config);

    const ctx: ProjectContext = {
      name: "test-project",
      label: "Test Project",
      dbPath: join(TMP_DIR, "projects", "test-project", "brain.db"),
      wikiDir: join(TMP_DIR, "projects", "test-project", "wiki"),
      createdAt: Date.now(),
    };

    pm.registerProject(ctx);
    expect(config.contexts["test-project"]).toBeDefined();
    expect(pm.listProjects()).toHaveLength(1);
    pm.close();
  });

  test("switchContext changes active context", async () => {
    const config = makeConfig();
    const pm = new ProjectManager(config);

    await ensureProjectDir("proj-a");
    await ensureProjectDir("proj-b");

    pm.registerProject({
      name: "proj-a",
      label: "Project A",
      dbPath: join(TMP_DIR, "projects", "proj-a", "brain.db"),
      wikiDir: join(TMP_DIR, "projects", "proj-a", "wiki"),
      createdAt: Date.now(),
    });

    pm.registerProject({
      name: "proj-b",
      label: "Project B",
      dbPath: join(TMP_DIR, "projects", "proj-b", "brain.db"),
      wikiDir: join(TMP_DIR, "projects", "proj-b", "wiki"),
      createdAt: Date.now(),
    });

    await pm.switchContext("proj-a");
    expect(config.activeContext).toBe("proj-a");
    expect(pm.getActiveProjectName()).toBe("proj-a");

    await pm.switchContext("proj-b");
    expect(config.activeContext).toBe("proj-b");

    await pm.switchContext("global");
    expect(config.activeContext).toBe("global");
    expect(pm.getActiveProjectName()).toBeNull();

    pm.close();
  });

  test("switchContext throws for unknown project", async () => {
    const config = makeConfig();
    const pm = new ProjectManager(config);

    await expect(pm.switchContext("nonexistent")).rejects.toThrow("not found");
    pm.close();
  });

  test("getProjectDB returns the same instance for same project", async () => {
    await ensureProjectDir("duplicate");
    const config = makeConfig();
    config.contexts["duplicate"] = {
      name: "duplicate",
      dbPath: join(TMP_DIR, "projects", "duplicate", "brain.db"),
      wikiDir: join(TMP_DIR, "projects", "duplicate", "wiki"),
      createdAt: Date.now(),
    };
    config.activeContext = "duplicate";

    const pm = new ProjectManager(config);
    const db1 = await pm.getProjectDB("duplicate");
    const db2 = await pm.getProjectDB("duplicate");
    expect(db1).toBe(db2);
    pm.close();
  });

  test("getActiveDB returns global when activeContext is global", async () => {
    const config = makeConfig();
    const pm = new ProjectManager(config);
    const db = await pm.getActiveDB();
    expect(db).toBeDefined();
    const globalDB = pm.getGlobalDB();
    expect(db).toBe(globalDB);
    pm.close();
  });

  test("getActiveDB returns project DB when activeContext is project", async () => {
    await ensureProjectDir("active-proj");
    const config = makeConfig();
    config.contexts["active-proj"] = {
      name: "active-proj",
      dbPath: join(TMP_DIR, "projects", "active-proj", "brain.db"),
      wikiDir: join(TMP_DIR, "projects", "active-proj", "wiki"),
      createdAt: Date.now(),
    };
    config.activeContext = "active-proj";

    const pm = new ProjectManager(config);
    const db = await pm.getActiveDB();
    expect(db).toBeDefined();

    const projectDB = await pm.getProjectDB("active-proj");
    expect(db).toBe(projectDB);
    pm.close();
  });

  test("resolveDB routes to project when project matches", async () => {
    await ensureProjectDir("known");
    const config = makeConfig();
    config.contexts["known"] = {
      name: "known",
      dbPath: join(TMP_DIR, "projects", "known", "brain.db"),
      wikiDir: join(TMP_DIR, "projects", "known", "wiki"),
      createdAt: Date.now(),
    };
    config.activeContext = "global";

    const pm = new ProjectManager(config);
    const db = await pm.resolveDB("known");
    expect(db).toBeDefined();

    const globalDB = pm.getGlobalDB();
    expect(db).not.toBe(globalDB);
    pm.close();
  });

  test("resolveDB falls back to active context for unknown project", async () => {
    const config = makeConfig();
    config.activeContext = "global";
    const pm = new ProjectManager(config);

    const db = await pm.resolveDB("nonexistent-project");
    const globalDB = pm.getGlobalDB();
    expect(db).toBe(globalDB);
    pm.close();
  });

  test("shouldPromoteToGlobal returns true for 2+ projects", () => {
    const config = makeConfig();
    const pm = new ProjectManager(config);
    expect(pm.shouldPromoteToGlobal(2)).toBe(true);
    expect(pm.shouldPromoteToGlobal(1)).toBe(false);
    expect(pm.shouldPromoteToGlobal(3)).toBe(true);
    pm.close();
  });

  test("getActiveWikiDir returns project wiki when active", () => {
    const config = makeConfig();
    config.contexts["wiki-test"] = {
      name: "wiki-test",
      dbPath: join(TMP_DIR, "projects", "wiki-test", "brain.db"),
      wikiDir: join(TMP_DIR, "projects", "wiki-test", "wiki"),
      createdAt: Date.now(),
    };
    config.activeContext = "wiki-test";

    const pm = new ProjectManager(config);
    expect(pm.getActiveWikiDir()).toContain("wiki-test");
    pm.close();
  });

  test("getActiveWikiDir returns global wiki when no project active", () => {
    const config = makeConfig();
    config.activeContext = "global";
    const pm = new ProjectManager(config);
    expect(pm.getActiveWikiDir()).toBe(config.wiki.outputDir);
    pm.close();
  });

  test("close shuts down all databases", async () => {
    await ensureProjectDir("close-test");
    const config = makeConfig();
    config.contexts["close-test"] = {
      name: "close-test",
      dbPath: join(TMP_DIR, "projects", "close-test", "brain.db"),
      wikiDir: join(TMP_DIR, "projects", "close-test", "wiki"),
      createdAt: Date.now(),
    };
    config.activeContext = "close-test";

    const pm = new ProjectManager(config);
    await pm.getProjectDB("close-test");

    pm.close();
  });

  test("unregisterProject removes from config and closes DB", async () => {
    await ensureProjectDir("to-remove");
    const config = makeConfig();
    config.contexts["to-remove"] = {
      name: "to-remove",
      dbPath: join(TMP_DIR, "projects", "to-remove", "brain.db"),
      wikiDir: join(TMP_DIR, "projects", "to-remove", "wiki"),
      createdAt: Date.now(),
    };

    const pm = new ProjectManager(config);
    await pm.getProjectDB("to-remove");

    pm.unregisterProject("to-remove");
    expect(config.contexts["to-remove"]).toBeUndefined();
    expect(pm.listProjects()).toHaveLength(0);
    pm.close();
  });

  test("getConfig returns the mutable config reference", () => {
    const config = makeConfig();
    const pm = new ProjectManager(config);
    const returned = pm.getConfig();
    expect(returned).toBe(config);
    // Mutations through the returned reference affect the original
    returned.activeContext = "modified";
    expect(config.activeContext).toBe("modified");
    pm.close();
  });

  test("getConfigDir returns the config directory path", () => {
    const config = makeConfig();
    const customDir = join(TMP_DIR, "custom-config");
    const pm = new ProjectManager(config, customDir);
    expect(pm.getConfigDir()).toBe(customDir);
    pm.close();
  });

  test("getActiveLoraDir returns project loraDir when project is active", () => {
    const config = makeConfig();
    config.contexts["lora-proj"] = {
      name: "lora-proj",
      dbPath: join(TMP_DIR, "projects", "lora-proj", "brain.db"),
      wikiDir: join(TMP_DIR, "projects", "lora-proj", "wiki"),
      loraDir: join(TMP_DIR, "projects", "lora-proj", "lora"),
      createdAt: Date.now(),
    };
    config.activeContext = "lora-proj";

    const pm = new ProjectManager(config);
    expect(pm.getActiveLoraDir()).toBe(
      join(TMP_DIR, "projects", "lora-proj", "lora"),
    );
    pm.close();
  });

  test("getActiveLoraDir falls back to global mlx.loraOutputDir when no project is active", () => {
    const config = makeConfig();
    config.activeContext = "global";

    const pm = new ProjectManager(config);
    expect(pm.getActiveLoraDir()).toBe(config.mlx.loraOutputDir);
    pm.close();
  });
});

describe("ProjectManager — data isolation", () => {
  test("two projects have independent databases", async () => {
    await ensureProjectDir("iso-a");
    await ensureProjectDir("iso-b");

    const config = makeConfig();
    config.contexts["iso-a"] = {
      name: "iso-a",
      dbPath: join(TMP_DIR, "projects", "iso-a", "brain.db"),
      wikiDir: join(TMP_DIR, "projects", "iso-a", "wiki"),
      createdAt: Date.now(),
    };
    config.contexts["iso-b"] = {
      name: "iso-b",
      dbPath: join(TMP_DIR, "projects", "iso-b", "brain.db"),
      wikiDir: join(TMP_DIR, "projects", "iso-b", "wiki"),
      createdAt: Date.now(),
    };

    const pm = new ProjectManager(config);

    // Seed project A
    const dbA = await pm.getProjectDB("iso-a");
    await dbA.insertMemory({
      id: "a1", layer: MemoryLayer.SELECTION,
      content: "Project A specific pattern",
      timestamp: Date.now(), source: "cursor",
    });
    await dbA.upsertGraphNode({
      id: "na1", label: "A Pattern", type: "pattern",
      content: "Only in project A",
      connections: [], weight: 0.9,
      timestamp: Date.now(), source: "cursor",
    });

    // Seed project B
    const dbB = await pm.getProjectDB("iso-b");
    await dbB.insertMemory({
      id: "b1", layer: MemoryLayer.SELECTION,
      content: "Project B specific pattern",
      timestamp: Date.now(), source: "cursor",
    });

    // Verify isolation
    const statsA = await dbA.getStats();
    const statsB = await dbB.getStats();

    expect(statsA.memories).toBe(1);
    expect(statsA.graphNodes).toBe(1);
    expect(statsB.memories).toBe(1);
    expect(statsB.graphNodes).toBe(0);

    const globalDB = pm.getGlobalDB();
    const globalStats = await globalDB.getStats();
    expect(globalStats.memories).toBe(0);
    expect(globalStats.graphNodes).toBe(0);

    pm.close();
  });
});

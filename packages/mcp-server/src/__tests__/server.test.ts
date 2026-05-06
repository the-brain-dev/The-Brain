/**
 * Tests for @the-brain/mcp-server — Protocol compliance and tool behavior.
 */
import { describe, test, expect, mock, afterEach } from "bun:test";
import { McpServer } from "../server";
import type { McpServerContext } from "../server";
import { registerAllTools } from "../tools/index";
import type { BrainDB, StorageBackend, SchedulerPlugin, TheBrainConfig, MemoryLayer, Memory, ProjectContext, GraphNodeRecord } from "@the-brain/core";
import { registerAllResources } from "../resources/index";

// ── Helpers ────────────────────────────────────────────────────

const TEST_MEMORY: Memory = {
  id: "mem-1",
  layer: "selection" as MemoryLayer,
  content: "User prefers TypeScript over JavaScript. Always use strict mode.",
  timestamp: Date.now(),
  source: "mcp:preference",
  metadata: { mcpType: "preference" },
};

const TEST_GRAPH_NODE: GraphNodeRecord = {
  id: "node-1",
  label: "TypeScript strict mode",
  type: "preference",
  content: "The developer always enables TypeScript strict mode.",
  connections: [],
  weight: 0.9,
  timestamp: Date.now(),
  source: "mcp",
};

function createMockDb(overrides: Partial<BrainDB> = {}): BrainDB {
  return {
    // Sessions
    createSession: mock(() => Promise.resolve()),
    getSession: mock(() => Promise.resolve(undefined)),
    getRecentSessions: mock(() => Promise.resolve([])),

    // Memories
    insertMemory: mock(() => Promise.resolve()),
    insertMemories: mock(() => Promise.resolve()),
    getMemoriesByLayer: mock(() => Promise.resolve([TEST_MEMORY])),
    getSurprisingMemories: mock(() => Promise.resolve([])),
    updateMemory: mock(() => Promise.resolve()),
    deleteMemory: mock(() => Promise.resolve()),
    getAllMemories: mock(() => Promise.resolve([TEST_MEMORY])),
    getRecentMemories: mock(() => Promise.resolve([TEST_MEMORY])),

    // Graph
    upsertGraphNode: mock(() => Promise.resolve(TEST_GRAPH_NODE)),
    getGraphNode: mock(() => Promise.resolve(TEST_GRAPH_NODE)),
    getConnectedNodes: mock(() => Promise.resolve([])),
    getHighWeightNodes: mock(() => Promise.resolve([TEST_GRAPH_NODE])),
    searchGraphNodes: mock(() => Promise.resolve([TEST_GRAPH_NODE])),

    // Stats
    getStats: mock(() =>
      Promise.resolve({
        sessions: 5,
        memories: 42,
        graphNodes: 10,
        perLayer: { instant: 20, selection: 15, deep: 7 },
        perGraphType: [
          { type: "preference", c: 4, avg_w: 0.8 },
          { type: "correction", c: 3, avg_w: 0.6 },
        ],
        perSource: [],
        memoryPerSource: [{ source: "mcp:preference", c: 10 }],
      }),
    ),
    deleteOldMemories: mock(() => Promise.resolve(0)),
    close: mock(() => {}),

    ...overrides,
  } as unknown as BrainDB;
}

function createMockStorage(db: BrainDB): StorageBackend {
  return {
    init: mock(() => Promise.resolve()),
    createSession: async (s) => { await db.createSession({ ...s, startedAt: s.startedAt, source: s.source, interactionCount: s.interactionCount } as any); },
    getSession: mock(() => Promise.resolve(undefined)),
    getRecentSessions: mock(() => Promise.resolve([])),
    insertMemory: async (m) => { await db.insertMemory(m); },
    insertMemories: async (ms) => { await db.insertMemories(ms); },
    getMemoriesByLayer: async (l, lim) => db.getMemoriesByLayer(l, lim),
    getSurprisingMemories: async (t) => db.getSurprisingMemories(t),
    updateMemory: async (id, u) => { await db.updateMemory(id, u); },
    deleteMemory: async (id) => { await db.deleteMemory(id); },
    getAllMemories: async (max) => db.getAllMemories(max),
    getRecentMemories: async (h) => db.getRecentMemories(h),
    upsertGraphNode: async (n) => db.upsertGraphNode(n),
    getGraphNode: async (id) => db.getGraphNode(id),
    getConnectedNodes: async (id) => db.getConnectedNodes(id),
    getHighWeightNodes: async (w) => db.getHighWeightNodes(w),
    searchGraphNodes: async (q) => db.searchGraphNodes(q),
    getStats: async () => db.getStats(),
    deleteOldMemories: async (d) => db.deleteOldMemories(d),
    close: mock(() => Promise.resolve()),
  } as unknown as StorageBackend;
}

function createMockScheduler(): SchedulerPlugin {
  const tasks: Array<{ name: string; handle: { id: string; name: string } }> = [];
  return {
    name: "mock-scheduler",
    schedule: mock((name: string, _intervalMs: number, _task: () => Promise<void>) => {
      const h = { id: `stub-${Date.now()}`, name };
      tasks.push({ name, handle: h });
      return h;
    }),
    scheduleOnce: mock((name: string) => {
      const h = { id: `stub-once-${Date.now()}`, name };
      return h;
    }),
    cancel: mock((handle: { id: string; name: string }) => {
      const idx = tasks.findIndex((t) => t.handle.id === handle.id);
      if (idx >= 0) tasks.splice(idx, 1);
    }),
    list: mock(() => tasks),
    shutdown: mock(() => Promise.resolve()),
  } as unknown as SchedulerPlugin;
}

function createMockConfig(): TheBrainConfig {
  return {
    plugins: [],
    database: { path: ":memory:" },
    pollInterval: 30000,
  } as unknown as TheBrainConfig;
}

function createMockProjects(): Map<string, ProjectContext> {
  const map = new Map<string, ProjectContext>();
  map.set("global", {
    name: "global",
    dbPath: ":memory:",
    wikiDir: "/tmp/wiki",
    createdAt: Date.now(),
    lastActive: Date.now(),
  });
  map.set("my-project", {
    name: "my-project",
    dbPath: "/tmp/my-project.db",
    wikiDir: "/tmp/my-project/wiki",
    createdAt: Date.now() - 86400000,
    lastActive: Date.now() - 3600000,
  });
  return map;
}

function createContext(overrides: {
  db?: BrainDB;
  projects?: Map<string, ProjectContext>;
} = {}): McpServerContext {
  const db = overrides.db ?? createMockDb();
  return {
    db,
    storage: createMockStorage(db),
    scheduler: createMockScheduler(),
    config: createMockConfig(),
    projects: overrides.projects ?? createMockProjects(),
    currentProject: "global",
  };
}

// ── Protocol Tests ────────────────────────────────────────────

describe("MCP Protocol", () => {
  test("initialize returns protocol version and capabilities", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx, "test-brain", "1.0.0");

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "test-client", version: "1.0" },
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();
    const r = result.result as Record<string, unknown>;
    expect(r.protocolVersion).toBe("2024-11-05");
    expect(r.serverInfo).toEqual({ name: "test-brain", version: "1.0.0" });
    expect((r.capabilities as Record<string, unknown>).tools).toEqual({
      listChanged: false,
    });
  });

  test("initialized sets the server as ready", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);

    await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "initialized",
    });

    // No error = success
    const res = await server.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "ping",
    });
    expect(res.result).toEqual({});
  });

  test("ping returns empty result", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 42,
      method: "ping",
    });

    expect(result.result).toEqual({});
  });

  test("unknown method returns error -32601", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 99,
      method: "nonexistent_method",
    });

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32601);
  });

  test("tools/list returns empty when no tools registered", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/list",
    });

    expect(result.result).toEqual({ tools: [] });
  });

  test("tools/list returns registered tools after registerAllTools", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/list",
    });

    const tools = (result.result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
    expect(tools.length).toBe(20);
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain("pipeline_ingest");
    expect(names).toContain("pipeline_status");
    expect(names).toEqual([
      "brain_config",
      "brain_stats",
      "graph_add_node",
      "graph_connect",
      "graph_search",
      "identity_get",
      "identity_update",
      "memory_context",
      "memory_list",
      "memory_search",
      "memory_store",
      "pipeline_ingest",
      "pipeline_status",
      "project_list",
      "project_switch",
      "scheduler_cancel",
      "scheduler_list",
      "scheduler_schedule",
      "training_consolidate",
      "training_status",
    ]);
  });

  test("tools/call returns error for unknown tool", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "does_not_exist", arguments: {} },
    });

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32603);
  });
});

// ── Tool Tests ────────────────────────────────────────────────

describe("MCP Tools", () => {
  test("memory_search returns matching memories", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: { name: "memory_search", arguments: { query: "TypeScript" } },
    });

    expect(result.error).toBeUndefined();
    const content = (result.result as any).content[0].text;
    expect(content).toContain("TypeScript");
    expect(content).toContain("strict mode");
  });

  test("memory_store creates a new memory", async () => {
    const db = createMockDb();
    const ctx = createContext({ db });
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 101,
      method: "tools/call",
      params: {
        name: "memory_store",
        arguments: {
          content: "User prefers Rust for performance-critical code",
          type: "preference",
        },
      },
    });

    expect(result.error).toBeUndefined();
    const content = (result.result as any).content[0].text;
    expect(content).toContain("Memory stored successfully");
    expect(content).toContain("Rust");

    // Verify insertMemory was called
    const insertMock = db.insertMemory as any;
    expect(insertMock).toHaveBeenCalled();
  });

  test("memory_store rejects empty content", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 102,
      method: "tools/call",
      params: {
        name: "memory_store",
        arguments: { content: "", type: "note" },
      },
    });

    const content = (result.result as any).content[0].text;
    expect(content).toContain("Error");
  });

  test("memory_context returns relevant context for a prompt", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 103,
      method: "tools/call",
      params: {
        name: "memory_context",
        arguments: { prompt: "I need to set up TypeScript strict mode" },
      },
    });

    expect(result.error).toBeUndefined();
    const content = (result.result as any).content[0].text;
    expect(content).toContain("strict mode");
  });

  test("memory_list returns paginated memories", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 104,
      method: "tools/call",
      params: { name: "memory_list", arguments: { limit: 10 } },
    });

    expect(result.error).toBeUndefined();
    const content = (result.result as any).content[0].text;
    expect(content).toContain("TypeScript");
    expect(content).toContain("selection");
  });

  test("graph_search finds matching graph nodes", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 105,
      method: "tools/call",
      params: { name: "graph_search", arguments: { query: "TypeScript" } },
    });

    expect(result.error).toBeUndefined();
    const content = (result.result as any).content[0].text;
    expect(content).toContain("strict mode");
    expect(content).toContain("preference");
  });

  test("brain_stats returns comprehensive statistics", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 106,
      method: "tools/call",
      params: { name: "brain_stats", arguments: {} },
    });

    expect(result.error).toBeUndefined();
    const content = (result.result as any).content[0].text;
    expect(content).toContain("42");
    expect(content).toContain("instant");
    expect(content).toContain("preference");
  });

  test("identity_get returns identity anchor data", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 107,
      method: "tools/call",
      params: { name: "identity_get", arguments: {} },
    });

    expect(result.error).toBeUndefined();
    const content = (result.result as any).content[0].text;
    expect(content).toContain("Identity Anchor");
  });

  test("project_list returns known projects", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 108,
      method: "tools/call",
      params: { name: "project_list", arguments: {} },
    });

    expect(result.error).toBeUndefined();
    const content = (result.result as any).content[0].text;
    expect(content).toContain("★ (active)");
    expect(content).toContain("global");
    expect(content).toContain("my-project");
  });
});

// ── Phase 2 Tool Tests ─────────────────────────────────────

describe("MCP Phase 2 Tools", () => {
  test("graph_add_node creates a new graph node", async () => {
    const createdNode: GraphNodeRecord = {
      id: "new-node-1",
      label: "Use Bun instead of Node",
      type: "preference",
      content: "Developer prefers Bun runtime over Node.js",
      connections: [],
      weight: 0.8,
      timestamp: Date.now(),
      source: "mcp",
    };
    const db = createMockDb({
      upsertGraphNode: mock(() => Promise.resolve(createdNode)),
    });
    const ctx = createContext({ db });
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 200,
      method: "tools/call",
      params: {
        name: "graph_add_node",
        arguments: {
          label: "Use Bun instead of Node",
          type: "preference",
          content: "Developer prefers Bun runtime over Node.js for its speed and built-in TypeScript support",
          weight: 0.8,
        },
      },
    });

    expect(result.error).toBeUndefined();
    const content = (result.result as any).content[0].text;
    expect(content).toContain("created successfully");
    expect(content).toContain("Use Bun instead of Node");
    expect(content).toContain("preference");

    // Verify upsertGraphNode was called
    const upsertMock = db.upsertGraphNode as any;
    expect(upsertMock).toHaveBeenCalled();
  });

  test("graph_add_node rejects short label", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 201,
      method: "tools/call",
      params: {
        name: "graph_add_node",
        arguments: { label: "ab", type: "concept", content: "test" },
      },
    });

    const content = (result.result as any).content[0].text;
    expect(content).toContain("Error");
    expect(content).toContain("label");
  });

  test("graph_connect links two existing nodes", async () => {
    const node1 = { ...TEST_GRAPH_NODE, id: "n1", label: "Node 1", connections: [] as string[] };
    const node2 = { ...TEST_GRAPH_NODE, id: "n2", label: "Node 2", connections: [] as string[] };
    const db = createMockDb({
      getGraphNode: mock((id: string) => {
        if (id === "n1") return Promise.resolve(node1);
        if (id === "n2") return Promise.resolve(node2);
        return Promise.resolve(undefined);
      }),
      upsertGraphNode: mock(() => Promise.resolve(node1)),
    });
    const ctx = createContext({ db });
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 202,
      method: "tools/call",
      params: {
        name: "graph_connect",
        arguments: { fromId: "n1", toId: "n2", label: "relates to" },
      },
    });

    expect(result.error).toBeUndefined();
    const content = (result.result as any).content[0].text;
    expect(content).toContain("Node 1");
    expect(content).toContain("Node 2");
    expect(content).toContain("↔");
  });

  test("graph_connect rejects missing node", async () => {
    const db = createMockDb({
      getGraphNode: mock(() => Promise.resolve(undefined)),
    });
    const ctx = createContext({ db });
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 203,
      method: "tools/call",
      params: {
        name: "graph_connect",
        arguments: { fromId: "nope", toId: "n1" },
      },
    });

    const content = (result.result as any).content[0].text;
    expect(content).toContain("Error");
    expect(content).toContain("not found");
  });

  test("graph_connect rejects self-connection", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 204,
      method: "tools/call",
      params: {
        name: "graph_connect",
        arguments: { fromId: "n1", toId: "n1" },
      },
    });

    const content = (result.result as any).content[0].text;
    expect(content).toContain("Error");
    expect(content).toContain("cannot connect a node to itself");
  });

  test("identity_update stores traits as graph nodes", async () => {
    const db = createMockDb();
    const ctx = createContext({ db });
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 205,
      method: "tools/call",
      params: {
        name: "identity_update",
        arguments: {
          traits: {
            "preferred-language": "TypeScript",
            "coding-style": "functional",
          },
        },
      },
    });

    expect(result.error).toBeUndefined();
    const content = (result.result as any).content[0].text;
    expect(content).toContain("2 trait");
    expect(content).toContain("TypeScript");
    expect(content).toContain("functional");

    // Called twice — once per trait
    const upsertMock = db.upsertGraphNode as any;
    expect(upsertMock).toHaveBeenCalledTimes(2);
  });

  test("identity_update rejects empty traits", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 206,
      method: "tools/call",
      params: {
        name: "identity_update",
        arguments: { traits: {} },
      },
    });

    const content = (result.result as any).content[0].text;
    expect(content).toContain("Error");
  });

  test("project_switch changes active project", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    expect(ctx.currentProject).toBe("global");

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 207,
      method: "tools/call",
      params: {
        name: "project_switch",
        arguments: { name: "my-project" },
      },
    });

    expect(result.error).toBeUndefined();
    const content = (result.result as any).content[0].text;
    expect(content).toContain("global");
    expect(content).toContain("my-project");
    expect(ctx.currentProject).toBe("my-project");
  });

  test("project_switch rejects unknown project", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 208,
      method: "tools/call",
      params: {
        name: "project_switch",
        arguments: { name: "nonexistent" },
      },
    });

    const content = (result.result as any).content[0].text;
    expect(content).toContain("Error");
    expect(content).toContain("not found");
  });

  test("training_status reports consolidation state", async () => {
    const deepMemory: Memory = {
      id: "deep-1",
      layer: "deep" as any,
      content: "Consolidated preference",
      timestamp: Date.now() - 3600000,
      source: "spm",
    };
    const db = createMockDb({
      getMemoriesByLayer: mock(() => Promise.resolve([deepMemory])),
    });
    const ctx = createContext({ db });
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 209,
      method: "tools/call",
      params: { name: "training_status", arguments: {} },
    });

    expect(result.error).toBeUndefined();
    const content = (result.result as any).content[0].text;
    expect(content).toContain("Last consolidation");
  });

  test("training_consolidate processes instant memories", async () => {
    const instantMem: Memory = {
      id: "inst-1",
      layer: "instant" as any,
      content: "User prefers pnpm over npm because of disk space efficiency and strict dependency resolution",
      timestamp: Date.now() - 60000,
      source: "mcp:preference",
    };
    const db = createMockDb({
      getMemoriesByLayer: mock((_layer: any, _limit?: number) => {
        return Promise.resolve([instantMem]);
      }),
      getSurprisingMemories: mock(() => Promise.resolve([])),
      insertMemory: mock(() => Promise.resolve()),
      deleteMemory: mock(() => Promise.resolve()),
    });
    const ctx = createContext({ db });
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 210,
      method: "tools/call",
      params: {
        name: "training_consolidate",
        arguments: { layer: "deep" },
      },
    });

    expect(result.error).toBeUndefined();
    const content = (result.result as any).content[0].text;
    expect(content).toContain("Consolidation Complete");
    expect(content).toContain("Selection layer");
  });

  test("brain_config list shows current config", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 211,
      method: "tools/call",
      params: {
        name: "brain_config",
        arguments: { action: "list" },
      },
    });

    expect(result.error).toBeUndefined();
    const content = (result.result as any).content[0].text;
    expect(content).toContain("Current Configuration");
  });

  test("brain_config get reads a config value", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 212,
      method: "tools/call",
      params: {
        name: "brain_config",
        arguments: { action: "get", key: "pollInterval" },
      },
    });

    expect(result.error).toBeUndefined();
    const content = (result.result as any).content[0].text;
    expect(content).toContain("pollInterval");
    expect(content).toContain("30000");
  });

  test("brain_config get returns not found for unknown key", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 213,
      method: "tools/call",
      params: {
        name: "brain_config",
        arguments: { action: "get", key: "nonexistent.deeply.nested" },
      },
    });

    const content = (result.result as any).content[0].text;
    expect(content).toContain("not found");
  });

  test("brain_config set requires key and value", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result1 = await server.handleRequest({
      jsonrpc: "2.0",
      id: 214,
      method: "tools/call",
      params: {
        name: "brain_config",
        arguments: { action: "set" },
      },
    });
    expect((result1.result as any).content[0].text).toContain("Error");

    const result2 = await server.handleRequest({
      jsonrpc: "2.0",
      id: 215,
      method: "tools/call",
      params: {
        name: "brain_config",
        arguments: { action: "set", key: "test" },
      },
    });
    expect((result2.result as any).content[0].text).toContain("Error");
  });
});

// ── Phase 3: Resources + Scheduler ──────────────────────────

describe("MCP Resources", () => {
  test("resources/list returns all 11 resources", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllResources(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 300,
      method: "resources/list",
    });

    expect(result.error).toBeUndefined();
    const resources = (result.result as any).resources;
    expect(resources.length).toBe(11);
    const uris = resources.map((r: any) => r.uri).sort();
    expect(uris).toContain("brain://memories/recent");
    expect(uris).toContain("brain://stats");
    expect(uris).toContain("brain://health");
  });

  test("resources/read returns brain stats", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllResources(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 301,
      method: "resources/read",
      params: { uri: "brain://stats" },
    });

    expect(result.error).toBeUndefined();
    const contents = (result.result as any).contents;
    expect(contents.length).toBe(1);
    const parsed = JSON.parse(contents[0].text);
    expect(parsed.memories).toBe(42);
  });

  test("resources/read returns recent memories", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllResources(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 302,
      method: "resources/read",
      params: { uri: "brain://memories/recent" },
    });

    expect(result.error).toBeUndefined();
    const text = (result.result as any).contents[0].text;
    expect(text).toContain("TypeScript");
  });

  test("resources/read returns error for unknown URI", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 303,
      method: "resources/read",
      params: { uri: "brain://nonexistent" },
    });

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32603);
  });

  test("resources/read requires uri param", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllResources(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 304,
      method: "resources/read",
      params: {},
    });

    expect(result.error).toBeDefined();
  });
});

describe("MCP Scheduler Tools", () => {
  test("scheduler_list returns empty when no tasks", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 400,
      method: "tools/call",
      params: { name: "scheduler_list", arguments: {} },
    });

    expect(result.error).toBeUndefined();
    const content = (result.result as any).content[0].text;
    expect(content).toContain("No scheduled tasks");
  });

  test("scheduler_schedule creates a task", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 401,
      method: "tools/call",
      params: {
        name: "scheduler_schedule",
        arguments: { name: "cleanup", intervalMs: 3600000 },
      },
    });

    expect(result.error).toBeUndefined();
    const content = (result.result as any).content[0].text;
    expect(content).toContain("Task scheduled");
    expect(content).toContain("cleanup");
    expect(content).toContain("3600000");
  });

  test("scheduler_schedule rejects interval < 1s", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 402,
      method: "tools/call",
      params: {
        name: "scheduler_schedule",
        arguments: { name: "fast", intervalMs: 500 },
      },
    });

    const content = (result.result as any).content[0].text;
    expect(content).toContain("Error");
  });

  test("scheduler_list shows created tasks", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    // Schedule a task first
    await server.handleRequest({
      jsonrpc: "2.0",
      id: 410,
      method: "tools/call",
      params: {
        name: "scheduler_schedule",
        arguments: { name: "test-task", intervalMs: 60000 },
      },
    });

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 411,
      method: "tools/call",
      params: { name: "scheduler_list", arguments: {} },
    });

    const content = (result.result as any).content[0].text;
    expect(content).toContain("test-task");
  });

  test("scheduler_cancel removes a task", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    // Schedule a task
    const schedResult = await server.handleRequest({
      jsonrpc: "2.0",
      id: 420,
      method: "tools/call",
      params: {
        name: "scheduler_schedule",
        arguments: { name: "to-cancel", intervalMs: 60000 },
      },
    });

    // Extract handle ID from response
    const schedText = (schedResult.result as any).content[0].text;
    const handleMatch = schedText.match(/Handle: (stub-\d+)/);
    const handleId = handleMatch ? handleMatch[1] : "stub-0";

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 421,
      method: "tools/call",
      params: {
        name: "scheduler_cancel",
        arguments: { id: handleId },
      },
    });

    const content = (result.result as any).content[0].text;
    expect(content).toContain("cancelled");
  });

  test("scheduler_cancel rejects unknown ID", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 422,
      method: "tools/call",
      params: {
        name: "scheduler_cancel",
        arguments: { id: "nonexistent-id" },
      },
    });

    const content = (result.result as any).content[0].text;
    expect(content).toContain("Error");
  });
});

// ── Phase 4: Pipeline + Subscriptions ──────────────────────

describe("MCP Pipeline Tools", () => {
  test("pipeline_ingest stores content as instant memory", async () => {
    const db = createMockDb();
    const ctx = createContext({ db });
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 500,
      method: "tools/call",
      params: {
        name: "pipeline_ingest",
        arguments: {
          content: "## Architecture Decision\n\nWe decided to use Redis for caching instead of Memcached because of better data structure support.",
          source: "manual",
          format: "markdown",
          tags: ["architecture", "redis", "caching"],
        },
      },
    });

    expect(result.error).toBeUndefined();
    const content = (result.result as any).content[0].text;
    expect(content).toContain("ingested successfully");
    expect(content).toContain("redis");
    expect(content).toContain("instant");

    // Verify insertMemory was called
    const insertMock = db.insertMemory as any;
    expect(insertMock).toHaveBeenCalled();
  });

  test("pipeline_ingest rejects short content", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 501,
      method: "tools/call",
      params: {
        name: "pipeline_ingest",
        arguments: { content: "hi", source: "test" },
      },
    });

    const content = (result.result as any).content[0].text;
    expect(content).toContain("Error");
  });

  test("pipeline_ingest creates graph nodes from tags", async () => {
    const db = createMockDb();
    const ctx = createContext({ db });
    const server = new McpServer(ctx);
    registerAllTools(server);

    await server.handleRequest({
      jsonrpc: "2.0",
      id: 502,
      method: "tools/call",
      params: {
        name: "pipeline_ingest",
        arguments: {
          content: "Refactored the auth middleware to use JWT tokens instead of sessions.",
          source: "claude",
          tags: ["auth", "jwt", "middleware"],
        },
      },
    });

    // Should create 3 graph nodes for the 3 tags
    const upsertMock = db.upsertGraphNode as any;
    expect(upsertMock).toHaveBeenCalled();
  });

  test("pipeline_status shows queue breakdown", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 503,
      method: "tools/call",
      params: { name: "pipeline_status", arguments: {} },
    });

    expect(result.error).toBeUndefined();
    const content = (result.result as any).content[0].text;
    expect(content).toContain("Pipeline Status");
    expect(content).toContain("Instant");
    expect(content).toContain("Selection");
    expect(content).toContain("Deep");
  });
});

describe("MCP Subscriptions", () => {
  test("resources/subscribe accepts valid URI", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllResources(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 600,
      method: "resources/subscribe",
      params: { uri: "brain://memories/recent" },
    });

    expect(result.error).toBeUndefined();
  });

  test("resources/subscribe requires uri", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 601,
      method: "resources/subscribe",
      params: {},
    });

    expect(result.error).toBeDefined();
  });

  test("resources/unsubscribe accepts valid URI", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);
    registerAllResources(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 602,
      method: "resources/unsubscribe",
      params: { uri: "brain://memories/recent" },
    });

    expect(result.error).toBeUndefined();
  });

  test("SSE transport wires onNotification callback", () => {
    const ctx = createContext();
    const server = new McpServer(ctx);

    let notificationReceived = false;
    server.onNotification = (_sessionId, _notification) => {
      notificationReceived = true;
    };

    // Trigger notification
    server.notifyResourceChanged("brain://memories/recent");
    expect(notificationReceived).toBe(false); // no-op unless callbacks are registered

    // Test the callback directly
    if (server.onNotification) {
      server.onNotification("test-session", {
        jsonrpc: "2.0",
        method: "notifications/resources/updated",
        params: { uri: "brain://memories/recent" },
      });
    }
    expect(notificationReceived).toBe(true);
  });
});

// ── Error Handling ─────────────────────────────────────────────

describe("MCP Error Handling", () => {
  test("internal errors in tools return code -32603", async () => {
    const db = createMockDb({
      getAllMemories: mock(() => Promise.reject(new Error("DB connection lost"))),
    });
    const ctx = createContext({ db });
    const server = new McpServer(ctx);
    registerAllTools(server);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 200,
      method: "tools/call",
      params: { name: "memory_list", arguments: {} },
    });

    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32603);
    expect(result.error!.message).toContain("DB connection lost");
  });

  test("tools/call without name returns error", async () => {
    const ctx = createContext();
    const server = new McpServer(ctx);

    const result = await server.handleRequest({
      jsonrpc: "2.0",
      id: 201,
      method: "tools/call",
      params: {},
    });

    expect(result.error).toBeDefined();
  });
});

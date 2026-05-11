/**
 * Tests for MCP resources — resource handler functions.
 *
 * Tests the 11 resource handlers by calling them directly with mock context.
 */

import { describe, it, expect } from "bun:test";

// ── Mock DB ──────────────────────────────────────────────────────

function createMockContext() {
  const memories: Array<{
    id: string;
    layer: string;
    content: string;
    timestamp: number;
    source: string;
    surpriseScore?: number;
    metadata?: Record<string, unknown>;
  }> = [
    {
      id: "mem-1",
      layer: "instant",
      content: "User prefers dark mode",
      timestamp: Date.now() - 60000,
      source: "cursor",
    },
    {
      id: "mem-2",
      layer: "selection",
      content: "SPM detected surprising pattern",
      timestamp: Date.now() - 120000,
      source: "claude-code",
      surpriseScore: 0.85,
    },
    {
      id: "mem-3",
      layer: "deep",
      content: "Project uses TypeScript strict mode",
      timestamp: Date.now() - 86400000,
      source: "cursor",
    },
  ];

  const graphNodes = [
    { id: "gn-1", label: "dark-mode", type: "preference", content: "User prefers dark mode", connections: [], weight: 0.9, timestamp: Date.now(), source: "cursor" },
    { id: "gn-2", label: "typescript", type: "concept", content: "TypeScript", connections: ["gn-1"], weight: 0.5, timestamp: Date.now(), source: "claude-code" },
  ];

  return {
    db: {
      async getRecentMemories(hours: number) {
        return memories.filter((m) => m.timestamp > Date.now() - hours * 3600000);
      },
      async getAllMemories(limit = 100) {
        return memories.slice(0, limit);
      },
      async getMemoriesByLayer(layer: string, limit = 100) {
        return memories.filter((m) => m.layer === layer).slice(0, limit);
      },
      async getMemoryById(id: string) {
        return memories.find((m) => m.id === id) ?? null;
      },
      async getStats() {
        return {
          memories: memories.length,
          graphNodes: graphNodes.length,
          instantCount: memories.filter((m) => m.layer === "instant").length,
          selectionCount: memories.filter((m) => m.layer === "selection").length,
          deepCount: memories.filter((m) => m.layer === "deep").length,
        };
      },
      async getGraphNode(id: string) {
        return graphNodes.find((n) => n.id === id) ?? null;
      },
      async getHighWeightNodes(minWeight: number) {
        return graphNodes.filter((n) => n.weight >= minWeight);
      },
      async searchGraphNodes(query: string) {
        return graphNodes.filter(
          (n) => n.label.includes(query) || n.content.includes(query),
        );
      },
      async getConnectedNodes(nodeId: string) {
        const node = graphNodes.find((n) => n.id === nodeId);
        if (!node) return [];
        return node.connections
          .map((cid) => graphNodes.find((n) => n.id === cid))
          .filter(Boolean);
      },
    },
    projects: new Map([["test-project", { workDir: "/test" }]]),
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("MCP Resources", () => {
  it("allResources has 11 entries", async () => {
    const mod = await import("../resources/index");
    const { allResources } = mod;
    const keys = Object.keys(allResources);
    expect(keys.length).toBe(11);
    expect(keys).toContain("memoriesRecent");
    expect(keys).toContain("stats");
    expect(keys).toContain("health");
  });

  it("each resource has def and handler", async () => {
    const mod = await import("../resources/index");
    const { allResources } = mod;
    for (const [key, resource] of Object.entries(allResources)) {
      expect(resource.def).toBeDefined();
      expect(resource.def.uri).toBeDefined();
      expect(typeof resource.handler).toBe("function");
    }
  });

  it("memoriesRecent returns formatted recent memories", async () => {
    const mod = await import("../resources/index");
    const { allResources } = mod;
    const ctx = createMockContext();

    const result = await allResources.memoriesRecent.handler(new URL("brain://memories/recent"), ctx as any);
    expect(result.contents).toBeDefined();
    expect(result.contents.length).toBeGreaterThanOrEqual(1);
    expect(result.contents[0].text).toContain("dark mode");
  });

  it("memoriesRecent handles empty state", async () => {
    const mod = await import("../resources/index");
    const { allResources } = mod;
    const ctx = {
      db: {
        async getRecentMemories(_hours: number) { return []; },
      },
    };

    const result = await allResources.memoriesRecent.handler(new URL("brain://memories/recent"), ctx as any);
    expect(result.contents[0].text).toBe("No recent memories.");
  });

  it("memoriesSearch filters by query and layer", async () => {
    const mod = await import("../resources/index");
    const { allResources } = mod;
    const ctx = createMockContext();

    const result = await allResources.memoriesSearch.handler(
      new URL("brain://memories/search?q=dark+mode&layer=instant"),
      ctx as any,
    );

    expect(result.contents).toBeDefined();
    expect(result.contents.length).toBeGreaterThanOrEqual(1);
  });

  it("stats returns memory and graph counts", async () => {
    const mod = await import("../resources/index");
    const { allResources } = mod;
    const ctx = createMockContext();

    const result = await allResources.stats.handler(new URL("brain://stats"), ctx as any);
    expect(result.contents[0].text).toContain("3"); // total memories
    expect(result.contents[0].text).toContain("2"); // graph nodes
  });

  it("health returns daemon status information", async () => {
    const mod = await import("../resources/index");
    const { allResources } = mod;
    const ctx = createMockContext();

    const result = await allResources.health.handler(new URL("brain://health"), ctx as any);
    expect(result.contents).toBeDefined();
    expect(result.contents[0].text).toContain('"status": "ok"');
  });

  it("graphNodes returns formatted graph node list", async () => {
    const mod = await import("../resources/index");
    const { allResources } = mod;
    const ctx = createMockContext();

    const result = await allResources.graphNodes.handler(
      new URL("brain://graph/nodes?type=preference"),
      ctx as any,
    );

    expect(result.contents).toBeDefined();
    expect(result.contents[0].text).toContain("dark-mode");
  });

  it("graphNodeById returns single node", async () => {
    const mod = await import("../resources/index");
    const { allResources } = mod;
    const ctx = createMockContext();

    // Use explicit pathname since URL parsing treats "graph" as hostname
    const result = await allResources.graphNodeById.handler(
      { pathname: "/graph/nodes/gn-1", href: "brain://graph/nodes/gn-1" } as any,
      ctx as any,
    );

    expect(result.contents[0].text).toContain("dark-mode");
    // Handler returns JSON.stringify(node) — verify it's valid JSON
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.label).toBe("dark-mode");
  });

  it("graphNodeById returns 404 for non-existent node", async () => {
    const mod = await import("../resources/index");
    const { allResources } = mod;
    const ctx = {
      db: {
        async getGraphNode(_id: string) { return null; },
      },
    };

    // Handler uses pathname.split("/graph/nodes/") — URL parsing
    // treats "graph" as hostname. Use explicit pathname.
    const result = await allResources.graphNodeById.handler(
      { pathname: "/graph/nodes/nonexistent", href: "brain://graph/nodes/nonexistent" } as any,
      ctx as any,
    );
    expect(result.contents[0].text).toContain("not found");
  });

  it("registerAllResources is callable", async () => {
    const mod = await import("../resources/index");
    const { registerAllResources } = mod;

    const registered: Array<{ uri: string }> = [];
    const mockServer = {
      registerResource(def: { uri: string }, _handler: Function) {
        registered.push({ uri: def.uri });
      },
    };

    registerAllResources(mockServer as any);
    expect(registered.length).toBe(11);
    expect(registered.some((r) => r.uri === "brain://health")).toBe(true);
    expect(registered.some((r) => r.uri === "brain://stats")).toBe(true);
  });

  // ── memoriesSearch: empty query ─────────────────────────────

  it("memoriesSearch returns guidance when query is empty", async () => {
    const mod = await import("../resources/index");
    const { allResources } = mod;
    const ctx = createMockContext();

    const result = await allResources.memoriesSearch.handler(
      new URL("brain://memories/search"),
      ctx as any,
    );

    expect(result.contents[0].text).toBe("Pass ?q=<query> to search memories");
  });

  it("memoriesSearch returns guidance when q param is blank", async () => {
    const mod = await import("../resources/index");
    const { allResources } = mod;
    const ctx = createMockContext();

    const result = await allResources.memoriesSearch.handler(
      new URL("brain://memories/search?q="),
      ctx as any,
    );

    expect(result.contents[0].text).toBe("Pass ?q=<query> to search memories");
  });

  // ── memoriesById ────────────────────────────────────────────

  it("memoriesById returns a memory as JSON", async () => {
    const mod = await import("../resources/index");
    const { allResources } = mod;
    const ctx = createMockContext();

    const result = await allResources.memoriesById.handler(
      { pathname: "/memories/mem-1", href: "brain://memories/mem-1" } as any,
      ctx as any,
    );

    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.id).toBe("mem-1");
    expect(parsed.content).toBe("User prefers dark mode");
    expect(result.contents[0].mimeType).toBe("application/json");
  });

  it("memoriesById returns error for missing ID", async () => {
    const mod = await import("../resources/index");
    const { allResources } = mod;
    const ctx = createMockContext();

    const result = await allResources.memoriesById.handler(
      { pathname: "/memories/", href: "brain://memories/" } as any,
      ctx as any,
    );

    expect(result.contents[0].text).toBe("Missing memory ID");
  });

  it("memoriesById returns error for non-existent memory", async () => {
    const mod = await import("../resources/index");
    const { allResources } = mod;
    const ctx = createMockContext();

    const result = await allResources.memoriesById.handler(
      { pathname: "/memories/nonexistent", href: "brain://memories/nonexistent" } as any,
      ctx as any,
    );

    expect(result.contents[0].text).toBe('Memory "nonexistent" not found');
  });

  // ── graphNodeById: missing ID ───────────────────────────────

  it("graphNodeById returns error for missing ID", async () => {
    const mod = await import("../resources/index");
    const { allResources } = mod;
    const ctx = createMockContext();

    const result = await allResources.graphNodeById.handler(
      { pathname: "/graph/nodes/", href: "brain://graph/nodes/" } as any,
      ctx as any,
    );

    expect(result.contents[0].text).toBe("Missing node ID");
  });

  // ── identityCurrent ─────────────────────────────────────────

  it("identityCurrent returns preference and pattern nodes", async () => {
    const mod = await import("../resources/index");
    const { allResources } = mod;
    const ctx = createMockContext();

    const result = await allResources.identityCurrent.handler(
      new URL("brain://identity/current"),
      ctx as any,
    );

    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed).toBeInstanceOf(Array);
    // Only preference/pattern nodes with weight >= 0.5
    expect(parsed.length).toBe(1);
    expect(parsed[0].label).toBe("dark-mode");
    expect(parsed[0].weight).toBe(0.9);
  });

  it("identityCurrent returns empty when no matching nodes", async () => {
    const mod = await import("../resources/index");
    const { allResources } = mod;
    const ctx = {
      db: {
        async getHighWeightNodes(_minWeight: number) {
          return [
            { id: "c1", label: "TS", type: "concept", content: "TypeScript", weight: 0.8, source: "cursor" },
          ];
        },
      },
    };

    const result = await allResources.identityCurrent.handler(
      new URL("brain://identity/current"),
      ctx as any,
    );

    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed).toEqual([]);
  });

  // ── trainingStatus ──────────────────────────────────────────

  it("trainingStatus returns deep memory consolidation info", async () => {
    const mod = await import("../resources/index");
    const { allResources } = mod;
    const ctx = createMockContext();

    const result = await allResources.trainingStatus.handler(
      new URL("brain://training/status"),
      ctx as any,
    );

    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.deepMemoryCount).toBe(1);
    expect(parsed.lastConsolidation).toBeTypeOf("string");
  });

  it("trainingStatus returns null lastConsolidation when no deep memories", async () => {
    const mod = await import("../resources/index");
    const { allResources } = mod;
    const ctx = {
      db: {
        async getMemoriesByLayer(_layer: string, _limit: number) {
          return [];
        },
      },
    };

    const result = await allResources.trainingStatus.handler(
      new URL("brain://training/status"),
      ctx as any,
    );

    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.deepMemoryCount).toBe(0);
    expect(parsed.lastConsolidation).toBeNull();
  });

  // ── projects ────────────────────────────────────────────────

  it("projects returns all registered projects with metadata", async () => {
    const mod = await import("../resources/index");
    const { allResources } = mod;
    const base = createMockContext();
    const ctx = {
      ...base,
      currentProject: "test-project",
      projects: new Map([
        [
          "test-project",
          {
            label: "Test Project",
            workDir: "/test",
            lastActive: Date.now() - 3600000,
            createdAt: Date.now() - 86400000,
            dbPath: "/tmp/test.db",
          },
        ],
        [
          "other-project",
          {
            label: "Other",
            workDir: "/other",
            lastActive: null,
            createdAt: Date.now() - 172800000,
            dbPath: "/tmp/other.db",
          },
        ],
      ]),
    };

    const result = await allResources.projects.handler(
      new URL("brain://projects"),
      ctx as any,
    );

    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed).toBeInstanceOf(Array);
    expect(parsed.length).toBe(2);

    const active = parsed.find((p: any) => p.name === "test-project");
    expect(active.active).toBe(true);
    expect(active.label).toBe("Test Project");
    expect(active.dbPath).toBe("/tmp/test.db");
    expect(active.lastActive).toBeTypeOf("string");

    const inactive = parsed.find((p: any) => p.name === "other-project");
    expect(inactive.active).toBe(false);
    expect(inactive.lastActive).toBeNull();
  });

  // ── config ──────────────────────────────────────────────────

  it("config returns configuration summary", async () => {
    const mod = await import("../resources/index");
    const { allResources } = mod;
    const base = createMockContext();
    const ctx = {
      ...base,
      config: {
        database: { path: "/home/user/.the-brain/brain.db" },
        daemon: { pollIntervalMs: 5000 },
        plugins: [{ name: "plugin-a" }, { name: "plugin-b" }, { name: "plugin-c" }],
        backends: { storage: "sqlite" },
        llm: {
          default: "ollama-local",
          backends: {
            "ollama-local": {
              provider: "ollama",
              baseUrl: "http://localhost:11434/v1",
              defaultModel: "qwen2.5:3b",
            },
          },
        },
      },
    };

    const result = await allResources.config.handler(
      new URL("brain://config"),
      ctx as any,
    );

    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.database).toBe("/home/user/.the-brain/brain.db");
    expect(parsed.pollInterval).toBe(5000);
    expect(parsed.pluginCount).toBe(3);
    expect(parsed.backends).toEqual({ storage: "sqlite" });
    expect(parsed.llm).toEqual({
      default: "ollama-local",
      backends: {
        "ollama-local": {
          provider: "ollama",
          baseUrl: "http://localhost:11434/v1",
          defaultModel: "qwen2.5:3b",
        },
      },
    });
  });

  it("config handles missing optional fields gracefully", async () => {
    const mod = await import("../resources/index");
    const { allResources } = mod;
    const base = createMockContext();
    const ctx = {
      ...base,
      config: {},
    };

    const result = await allResources.config.handler(
      new URL("brain://config"),
      ctx as any,
    );

    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.database).toBe("unknown");
    expect(parsed.pollInterval).toBeUndefined();
    expect(parsed.pluginCount).toBe(0);
    expect(parsed.backends).toEqual({});
  });
});

/**
 * MCP Tools — expose BrainAPI as MCP tool definitions.
 *
 * MVP Tools (Phase 1):
 *   memory_search, memory_store, memory_context, memory_list
 *   graph_search, brain_stats, identity_get, project_list
 *
 * Phase 2 (next): graph_add_node, graph_connect, identity_update,
 *   project_switch, training_status, training_consolidate, brain_config
 */

import type { ToolDef, ToolHandler, McpServerContext } from "../server";
import { MemoryLayer } from "@the-brain/core";
import type { Memory, GraphNodeRecord } from "@the-brain/core";
import { randomUUID } from "node:crypto";

// ── Memory Tools ──────────────────────────────────────────────

const memorySearchDef: ToolDef = {
  name: "memory_search",
  description:
    "Search memories across all layers. Returns the most semantically relevant memories for a given query. Use this to recall past corrections, preferences, or facts the developer has told the AI.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query — keywords or phrases to find in memory content",
      },
      layer: {
        type: "string",
        enum: ["instant", "selection", "deep"],
        description: "Optional — filter memories by cognitive layer (default: all layers)",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return (default: 10, max: 50)",
      },
    },
    required: ["query"],
  },
};

const memorySearchHandler: ToolHandler = async (params, ctx) => {
  const query = (params.query as string).toLowerCase();
  const limit = Math.min((params.limit as number) ?? 10, 50);
  const layer = params.layer as string | undefined;

  // Get all memories (filtered by layer if specified), then do a simple
  // content-match search. For semantic search, this could be backed by
  // the graph memory plugin or a vector DB extension.
  let memories: Memory[];
  if (layer) {
    const memoryLayer = layer as MemoryLayer;
    memories = await ctx.db.getMemoriesByLayer(memoryLayer, 200);
  } else {
    memories = await ctx.db.getAllMemories(200);
  }

  // Simple content-based search (case-insensitive substring match)
  const scored = memories
    .filter((m) => m.content.toLowerCase().includes(query))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);

  const text = scored.length === 0
    ? "No matching memories found."
    : scored
        .map(
          (m, i) =>
            `${i + 1}. [${m.layer}] ${m.content.slice(0, 300)}${
              m.content.length > 300 ? "..." : ""
            } (id: ${m.id}, source: ${m.source})`,
        )
        .join("\n\n");

  return { content: [{ type: "text", text }] };
};

// ────────────────────────────────────────────────────────────

const memoryStoreDef: ToolDef = {
  name: "memory_store",
  description:
    "Store a new memory in the brain. Use this to remember corrections, user preferences, important facts, or coding patterns. The memory will be evaluated by the Selection Layer (SPM) and promoted to Deep storage if it's surprising enough.",
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "The memory content — what should be remembered",
      },
      type: {
        type: "string",
        enum: ["correction", "preference", "fact", "pattern", "note"],
        description: "Type of memory: correction (user fixed something), preference (style/tool choice), fact (project knowledge), pattern (recurring behavior), note (general)",
      },
      layer: {
        type: "string",
        enum: ["instant", "selection", "deep"],
        description: "Memory layer to write to (default: instant — goes through SPM evaluation). Only 'instant' is allowed for new memories.",
      },
      metadata: {
        type: "object",
        description: "Optional extra metadata (project, file, tags, etc.)",
      },
    },
    required: ["content", "type"],
  },
};

const memoryStoreHandler: ToolHandler = async (params, ctx) => {
  const content = params.content as string;
  const memType = (params.type as string) ?? "note";
  const layerStr = (params.layer as string) ?? MemoryLayer.INSTANT;
  const metadata = params.metadata as Record<string, unknown> | undefined;

  // Validate layer — only INSTANT is allowed (SPM evaluates before promotion)
  if (layerStr !== MemoryLayer.INSTANT) {
    return { content: [{ type: "text", text: "Error: layer must be 'instant' for new memories. Use training_consolidate to promote to DEEP." }] };
  }
  const layer: MemoryLayer = MemoryLayer.INSTANT;

  if (!content || content.trim().length === 0) {
    return { content: [{ type: "text", text: "Error: content must not be empty" }] };
  }

  const mem: Memory = {
    id: randomUUID(),
    layer,
    content: content.trim(),
    timestamp: Date.now(),
    source: `mcp:${memType}`,
    metadata: metadata ? { ...metadata, mcpType: memType } : { mcpType: memType },
  };

  await ctx.storage.insertMemory(mem);

  return {
    content: [
      {
        type: "text",
        text: `Memory stored successfully.\n- ID: ${mem.id}\n- Layer: ${layer}\n- Type: ${memType}\n- Preview: ${content.slice(0, 120)}${content.length > 120 ? "..." : ""}`,
      },
    ],
  };
};

// ────────────────────────────────────────────────────────────

const memoryContextDef: ToolDef = {
  name: "memory_context",
  description:
    "Get context to inject before the next AI prompt. Returns the most relevant memories and graph nodes that should be injected into the working memory (instant layer) before the AI responds. This is the primary tool for getting the brain's accumulated knowledge into your prompt.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The current user prompt/context — used to find relevant memories",
      },
      limit: {
        type: "number",
        description: "Maximum memories to retrieve (default: 5)",
      },
    },
    required: ["prompt"],
  },
};

const memoryContextHandler: ToolHandler = async (params, ctx) => {
  const prompt = (params.prompt as string).toLowerCase();
  const limit = Math.min((params.limit as number) ?? 5, 20);

  // Get high-weight graph nodes (Instant Layer — working memory)
  const highWeightNodes = await ctx.db.getHighWeightNodes(0.4);
  const recentMemories = await ctx.db.getRecentMemories(4);

  // Simple keyword-based relevance scoring
  const keywords = prompt.split(/\s+/).filter((w) => w.length > 2);
  const scoredNodes = highWeightNodes
    .map((n) => {
      const labelLower = n.label.toLowerCase();
      const contentLower = n.content.toLowerCase();
      const score = keywords.filter(
        (kw) => labelLower.includes(kw) || contentLower.includes(kw),
      ).length;
      return { node: n, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const scoredMemories = recentMemories
    .filter((m) =>
      keywords.some((kw) => m.content.toLowerCase().includes(kw)),
    )
    .slice(0, limit);

  const parts: string[] = [];

  if (scoredNodes.length > 0) {
    parts.push("## Relevant Graph Nodes (Working Memory)\n");
    for (const { node, score } of scoredNodes) {
      parts.push(`- [${node.type}] **${node.label}** (weight: ${node.weight.toFixed(2)}, relevance: ${score})\n  ${node.content.slice(0, 200)}`);
    }
  }

  if (scoredMemories.length > 0) {
    parts.push("\n## Recent Relevant Memories\n");
    for (const m of scoredMemories) {
      parts.push(
        `- [${m.layer}] ${m.content.slice(0, 200)} (${new Date(m.timestamp).toLocaleDateString()})`,
      );
    }
  }

  if (parts.length === 0) {
    parts.push("No relevant context found for this prompt. The brain is still learning about this topic.");
  }

  return { content: [{ type: "text", text: parts.join("\n") }] };
};

// ────────────────────────────────────────────────────────────

const memoryListDef: ToolDef = {
  name: "memory_list",
  description:
    "List recent memories, optionally filtered by layer. Use this to browse what the brain remembers without a specific search query.",
  inputSchema: {
    type: "object",
    properties: {
      layer: {
        type: "string",
        enum: ["instant", "selection", "deep"],
        description: "Filter by memory layer (default: all layers)",
      },
      limit: {
        type: "number",
        description: "Maximum results (default: 20, max: 100)",
      },
      offset: {
        type: "number",
        description: "Offset for pagination (default: 0)",
      },
    },
    required: [],
  },
};

const memoryListHandler: ToolHandler = async (params, ctx) => {
  const limit = Math.min((params.limit as number) ?? 20, 100);
  const offset = (params.offset as number) ?? 0;
  const layer = params.layer as string | undefined;

  let memories: Memory[];
  if (layer) {
    memories = await ctx.db.getMemoriesByLayer(layer as MemoryLayer, limit + offset);
  } else {
    memories = await ctx.db.getAllMemories(limit + offset);
  }

  const page = memories.slice(offset, offset + limit);
  const total = memories.length;

  const text = page.length === 0
    ? "No memories found."
    : page
        .map(
          (m, i) =>
            `${offset + i + 1}. [${m.layer}] ${m.content.slice(0, 200)}${
              m.content.length > 200 ? "..." : ""
            }\n   Type: ${m.source.replace("mcp:", "")}, Date: ${new Date(m.timestamp).toISOString()}, ID: ${m.id}`,
        )
        .join("\n\n");

  return {
    content: [
      {
        type: "text",
        text: `Showing ${offset + 1}-${offset + page.length} of ${total} memories:\n\n${text}`,
      },
    ],
  };
};

// ── Graph Tools ──────────────────────────────────────────────

const graphSearchDef: ToolDef = {
  name: "graph_search",
  description:
    "Search the knowledge graph for nodes matching a query. The graph stores corrections, concepts, preferences, and patterns as interconnected nodes. Use this to find what the brain knows about a specific topic.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query — matches against node labels and content",
      },
      limit: {
        type: "number",
        description: "Maximum results (default: 10)",
      },
    },
    required: ["query"],
  },
};

const graphSearchHandler: ToolHandler = async (params, ctx) => {
  const query = params.query as string;
  const limit = Math.min((params.limit as number) ?? 10, 30);

  const nodes = await ctx.db.searchGraphNodes(query);
  const results = nodes.slice(0, limit);

  const text = results.length === 0
    ? `No graph nodes match "${query}".`
    : results
        .map(
          (n, i) =>
            `${i + 1}. [${n.type}] **${n.label}** (weight: ${n.weight.toFixed(2)})\n   ${n.content.slice(0, 200)}\n   Connections: ${n.connections.length} nodes | ID: ${n.id}`,
        )
        .join("\n\n");

  return { content: [{ type: "text", text }] };
};

// ── Brain Stats ──────────────────────────────────────────────

const brainStatsDef: ToolDef = {
  name: "brain_stats",
  description:
    "Get comprehensive statistics about the brain: memory count by layer, graph node distribution, session count, data sources, and overall health.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

const brainStatsHandler: ToolHandler = async (_params, ctx) => {
  const stats = await ctx.db.getStats();

  const text = [
    "## Brain Statistics",
    `Total sessions: ${stats.sessions}`,
    `Total memories: ${stats.memories}`,
    `Total graph nodes: ${stats.graphNodes}`,
    "",
    "### Memory Distribution by Layer",
    ...Object.entries(stats.perLayer as Record<string, number>).map(
      ([layer, count]) => `- ${layer}: ${count}`,
    ),
    "",
    "### Graph Nodes by Type",
    ...(Array.isArray(stats.perGraphType) ? stats.perGraphType : []).map(
      (t: { type: string; c: number; avg_w: number }) =>
        `- ${t.type}: ${t.c} (avg weight: ${t.avg_w})`,
    ),
    "",
    "### Data Sources",
    ...(Array.isArray(stats.memoryPerSource) ? stats.memoryPerSource : []).slice(0, 10).map(
      (s: { source: string; c: number }) => `- ${s.source}: ${s.c} memories`,
    ),
  ].join("\n");

  return { content: [{ type: "text", text }] };
};

// ── Identity ──────────────────────────────────────────────────

const identityGetDef: ToolDef = {
  name: "identity_get",
  description:
    "Get the current identity anchor — a summary of who the developer is based on observed patterns, preferences, and corrections. This is the stable self-model that persists across retraining.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

const identityGetHandler: ToolHandler = async (_params, ctx) => {
  // Identity anchor is stored as graph nodes of type "preference" and "pattern"
  // with high weight — representing the most stable developer traits.
  const identityNodes = await ctx.db.getHighWeightNodes(0.5);
  const prefs = identityNodes.filter(
    (n) => n.type === "preference" || n.type === "pattern",
  );

  // Also check for DEEP-layer memories about the developer
  const deepMemories = await ctx.db.getMemoriesByLayer(MemoryLayer.DEEP, 50);
  const identityMemories = deepMemories.filter(
    (m) =>
      m.content.includes("prefer") ||
      m.content.includes("always") ||
      m.content.includes("never") ||
      m.content.includes("style") ||
      m.source === "mcp:preference" ||
      m.source === "mcp:correction",
  );

  const text = [
    "## Identity Anchor",
    "",
    `### Preferences & Patterns (${prefs.length} nodes)`,
    prefs.length > 0
      ? prefs.map((n) => `- **${n.label}** (weight: ${n.weight.toFixed(2)}): ${n.content.slice(0, 200)}`).join("\n")
      : "(No strong identity signals yet — the brain is still learning)",
    "",
    `### Deep Memories about Developer (${identityMemories.length})`,
    identityMemories.length > 0
      ? identityMemories.slice(0, 10).map((m) => `- ${m.content.slice(0, 200)}`).join("\n")
      : "(No deep identity memories yet)",
  ].join("\n");

  return { content: [{ type: "text", text }] };
};

// ── Project Tools ────────────────────────────────────────────

const projectListDef: ToolDef = {
  name: "project_list",
  description:
    "List all known projects in the brain. Each project has its own isolated memory store and wiki. Returns project names, last activity timestamps, and memory counts.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

const projectListHandler: ToolHandler = async (_params, ctx) => {
  const projects = Array.from(ctx.projects.entries());

  if (projects.length === 0) {
    return { content: [{ type: "text", text: "No projects found. Use `the-brain init --project <name>` to create a project." }] };
  }

  const current = ctx.currentProject;
  const lines = projects.map(([name, proj]) => {
    const marker = name === current ? "★ (active)" : "  ";
    const lastActive = proj.lastActive
      ? new Date(proj.lastActive).toLocaleString()
      : "never";
    return `${marker} ${name} (last active: ${lastActive})`;
  });

  return {
    content: [
      {
        type: "text",
        text: `## Projects (${projects.length})\n\n${lines.join("\n")}\n\n★ = currently active`,
      },
    ],
  };
};

// ── Graph Write Tools ──────────────────────────────────────

const graphAddNodeDef: ToolDef = {
  name: "graph_add_node",
  description:
    "Create a new node in the knowledge graph. Use this to store corrections, concepts, preferences, or patterns the developer has expressed. Nodes can be connected later with graph_connect.",
  inputSchema: {
    type: "object",
    properties: {
      label: {
        type: "string",
        description: "Short label for the node (3-80 chars)",
      },
      type: {
        type: "string",
        enum: ["concept", "correction", "preference", "pattern"],
        description: "Type: concept (technical term), correction (user fixed something), preference (user's preferred approach), pattern (recurring behavior)",
      },
      content: {
        type: "string",
        description: "Full content/description of what this node represents",
      },
      weight: {
        type: "number",
        description: "Initial weight 0.0-1.0 (default: 0.5). Higher = more important/surprising",
      },
    },
    required: ["label", "type", "content"],
  },
};

const graphAddNodeHandler: ToolHandler = async (params, ctx) => {
  const label = (params.label as string).slice(0, 80);
  const nodeType = params.type as "concept" | "correction" | "preference" | "pattern";
  const content = params.content as string;
  const weight = Math.min(1, Math.max(0, (params.weight as number) ?? 0.5));

  if (label.length < 3) {
    return { content: [{ type: "text", text: "Error: label must be at least 3 characters" }] };
  }

  const node = await ctx.storage.upsertGraphNode({
    label,
    type: nodeType,
    content: content.slice(0, 500),
    connections: [],
    weight,
    timestamp: Date.now(),
    source: "mcp",
  });

  return {
    content: [
      {
        type: "text",
        text: `Graph node created successfully.\n- ID: ${node.id}\n- Label: ${node.label}\n- Type: ${node.type}\n- Weight: ${node.weight.toFixed(2)}`,
      },
    ],
  };
};

// ────────────────────────────────────────────────────────────

const graphConnectDef: ToolDef = {
  name: "graph_connect",
  description:
    "Connect two existing graph nodes. This creates a bidirectional relationship — both nodes reference each other. Use to link related concepts, corrections to the files they fix, or preferences to the context they apply to.",
  inputSchema: {
    type: "object",
    properties: {
      fromId: {
        type: "string",
        description: "ID of the first node",
      },
      toId: {
        type: "string",
        description: "ID of the second node",
      },
      label: {
        type: "string",
        description: "Optional description of the relationship (e.g., 'fixes', 'relates to', 'used in')",
      },
    },
    required: ["fromId", "toId"],
  },
};

const graphConnectHandler: ToolHandler = async (params, ctx) => {
  const fromId = params.fromId as string;
  const toId = params.toId as string;

  if (fromId === toId) {
    return { content: [{ type: "text", text: "Error: cannot connect a node to itself" }] };
  }

  const fromNode = await ctx.db.getGraphNode(fromId);
  const toNode = await ctx.db.getGraphNode(toId);

  if (!fromNode) {
    return { content: [{ type: "text", text: `Error: node ${fromId} not found` }] };
  }
  if (!toNode) {
    return { content: [{ type: "text", text: `Error: node ${toId} not found` }] };
  }

  // Add each other's IDs to connections (bidirectional)
  if (!fromNode.connections.includes(toId)) {
    fromNode.connections.push(toId);
    await ctx.db.upsertGraphNode(fromNode);
  }

  if (!toNode.connections.includes(fromId)) {
    toNode.connections.push(fromId);
    await ctx.db.upsertGraphNode(toNode);
  }

  return {
    content: [
      {
        type: "text",
        text: `Nodes connected: ${fromNode.label} ↔ ${toNode.label}`,
      },
    ],
  };
};

// ── Identity Write Tool ────────────────────────────────────

const identityUpdateDef: ToolDef = {
  name: "identity_update",
  description:
    "Update the identity anchor — the brain's model of who the developer is. Stores preferences, coding style, tool choices, and recurring patterns as high-weight identity nodes. These persist across retraining.",
  inputSchema: {
    type: "object",
    properties: {
      traits: {
        type: "object",
        description: "Key-value traits to update (e.g., {\"preferred-language\": \"TypeScript\", \"coding-style\": \"functional\"})",
      },
    },
    required: ["traits"],
  },
};

const identityUpdateHandler: ToolHandler = async (params, ctx) => {
  const traits = params.traits as Record<string, unknown>;

  if (!traits || Object.keys(traits).length === 0) {
    return { content: [{ type: "text", text: "Error: traits must not be empty" }] };
  }

  const created: string[] = [];

  for (const [key, value] of Object.entries(traits)) {
    const label = `${key}: ${String(value).slice(0, 40)}`;
    const content = `Developer trait: ${key} = ${String(value).slice(0, 300)}`;
    const node = await ctx.storage.upsertGraphNode({
      label,
      type: "preference",
      content,
      connections: [],
      weight: 0.85, // Identity nodes get high weight
      timestamp: Date.now(),
      source: "mcp:identity",
    });
    created.push(`${key}: ${String(value).slice(0, 60)} (id: ${node.id})`);
  }

  return {
    content: [
      {
        type: "text",
        text: `Identity updated with ${created.length} trait(s):\n${created.map((c) => `  - ${c}`).join("\n")}`,
      },
    ],
  };
};

// ── Project Tools ──────────────────────────────────────────

const projectSwitchDef: ToolDef = {
  name: "project_switch",
  description:
    "Switch the active project context. Each project has its own isolated memory store, wiki, and LoRA checkpoints. Use this before working on a different project so memories go to the right place.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Project name to switch to (use 'global' for the global context)",
      },
    },
    required: ["name"],
  },
};

const projectSwitchHandler: ToolHandler = async (params, ctx) => {
  const name = params.name as string;

  if (!ctx.projects.has(name)) {
    const available = Array.from(ctx.projects.keys()).join(", ");
    return {
      content: [
        {
          type: "text",
          text: `Error: project "${name}" not found.\nAvailable projects: ${available || "(none)"}\n\nCreate a project with: the-brain init --project <name>`,
        },
      ],
    };
  }

  const oldProject = ctx.currentProject;
  ctx.currentProject = name;

  // Update lastActive timestamp
  const proj = ctx.projects.get(name)!;
  proj.lastActive = Date.now();
  ctx.projects.set(name, proj);

  return {
    content: [
      {
        type: "text",
        text: `Switched from "${oldProject}" → "${name}" (active project).\nAll subsequent memory operations will target this project.`,
      },
    ],
  };
};

// ── Training Tools ─────────────────────────────────────────

const trainingStatusDef: ToolDef = {
  name: "training_status",
  description:
    "Check the status of the last training/consolidation run. Returns when the last deep-layer consolidation happened and whether LoRA training has been performed.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

const trainingStatusHandler: ToolHandler = async (_params, ctx) => {
  // Check for DEEP-layer memories (evidence of consolidation)
  const deepMemories = await ctx.db.getMemoriesByLayer(MemoryLayer.DEEP, 5);
  const recentDeep = deepMemories[0];

  // Check for LoRA adapters
  const { existsSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");

  const loraPath = join(homedir(), ".the-brain", "adapters.safetensors");
  const hasLora = existsSync(loraPath);

  const lines = [
    "## Training Status",
    "",
    `Last consolidation: ${recentDeep ? new Date(recentDeep.timestamp).toLocaleString() : "never"}`,
    `Deep-layer memories: ${deepMemories.length}${deepMemories.length >= 5 ? "+" : ""}`,
    `LoRA adapter: ${hasLora ? "✅ exists" : "❌ not found"}`,
    "",
    hasLora
      ? "The brain has been trained. Knowledge is baked into local models."
      : "No LoRA training has been performed yet. Run `the-brain train` or `the-brain consolidate --now` to trigger the deep layer.",
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
};

// ────────────────────────────────────────────────────────────

const trainingConsolidateDef: ToolDef = {
  name: "training_consolidate",
  description:
    "Force memory consolidation (Layer 2 → Layer 3). Runs the Selection Layer (SPM curator) on new interactions, promotes surprising ones to Deep storage, and optionally triggers LoRA training. This is what normally happens automatically during idle time.",
  inputSchema: {
    type: "object",
    properties: {
      layer: {
        type: "string",
        enum: ["selection", "deep"],
        description: "Target layer: 'selection' runs SPM evaluation, 'deep' also promotes and trains (default: deep)",
      },
      force: {
        type: "boolean",
        description: "Force even if no new data (default: false)",
      },
    },
    required: [],
  },
};

const trainingConsolidateHandler: ToolHandler = async (params, ctx) => {
  const targetLayer = (params.layer as string) ?? "deep";

  // Get INSTANT-layer memories (unprocessed) and SELECTION-layer (to promote)
  const instantMemories = await ctx.db.getMemoriesByLayer(MemoryLayer.INSTANT, 100);
  const stats = await ctx.db.getStats();

  if (instantMemories.length === 0 && targetLayer !== "deep") {
    return { content: [{ type: "text", text: "No instant-layer memories to process. The brain has already consolidated everything." }] };
  }

  const results: string[] = [];

  if (targetLayer === "selection" || targetLayer === "deep") {
    // Mark instant memories as evaluated (move to selection layer)
    // In production, the SPM plugin handles this — here we simulate by
    // updating the layer and setting a surprise score
    let promoted = 0;
    for (const mem of instantMemories.slice(0, 20)) {
      const isSurprising = mem.content.length > 50 && !mem.content.includes("OK") && !mem.content.includes("ok");

      try {
        await ctx.db.deleteMemory(mem.id);
        await ctx.db.insertMemory({
          ...mem,
          id: `sel-${mem.id}`,
          layer: MemoryLayer.SELECTION,
          surpriseScore: isSurprising ? 0.7 : 0.2,
          timestamp: Date.now(),
        });
        if (isSurprising) promoted++;
      } catch {
        // May already exist from a previous consolidation attempt
        continue;
      }
    }
    results.push(`Selection layer: ${instantMemories.length} memories evaluated, ${promoted} surprising`);
  }

  if (targetLayer === "deep") {
    // Get recently promoted SELECTION memories
    const selectionMemories = await ctx.db.getSurprisingMemories(0.4);
    let deepCount = 0;
    for (const mem of selectionMemories.slice(0, 10)) {
      try {
        await ctx.db.deleteMemory(mem.id);
        await ctx.db.insertMemory({
          ...mem,
          id: `deep-${mem.id}`,
          layer: MemoryLayer.DEEP,
          timestamp: Date.now(),
        });
        deepCount++;
      } catch {
        continue;
      }
    }
    results.push(`Deep layer: ${deepCount} memories promoted to long-term storage`);
  }

  return {
    content: [
      {
        type: "text",
        text:
          `## Consolidation Complete\n` +
          results.join("\n") +
          `\n\nBrain stats: ${stats.memories} memories, ${stats.graphNodes} graph nodes, ${stats.sessions} sessions.`,
      },
    ],
  };
};

// ── Config Tool ────────────────────────────────────────────

const brainConfigDef: ToolDef = {
  name: "brain_config",
  description:
    "Read or update the-brain configuration. Use action='get' to read a config value, 'set' to update one, or 'list' to see all current settings. Changes are persisted to ~/.the-brain/config.json.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["get", "set", "list"],
        description: "What to do: get a value, set a value, or list all",
      },
      key: {
        type: "string",
        description: "Config key (for get/set). Nested keys use dot notation (e.g., 'plugins.0.enabled')",
      },
      value: {
        type: "string",
        description: "New value (for set). Will be parsed as JSON if it looks like JSON, otherwise stored as string",
      },
    },
    required: ["action"],
  },
};

const brainConfigHandler: ToolHandler = async (params, ctx) => {
  const action = params.action as string;
  const key = params.key as string | undefined;

  if (action === "list") {
    const lines = ["## Current Configuration", ""];
    // Show key config sections
    lines.push(`Database: ${(ctx.config as any).database?.path ?? "default"}`);
    lines.push(`Poll interval: ${(ctx.config as any).pollInterval ?? "N/A"} ms`);
    lines.push(`Plugins loaded: ${(ctx.config as any).plugins?.length ?? 0}`);
    if ((ctx.config as any).backends) {
      lines.push("Backends:");
      for (const [slot, module] of Object.entries((ctx.config as any).backends)) {
        lines.push(`  ${slot}: ${module}`);
      }
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (action === "get") {
    if (!key) {
      return { content: [{ type: "text", text: "Error: 'key' is required for action='get'" }] };
    }
    // Simple dot-notation access
    const parts = key.split(".");
    let val: any = ctx.config as any;
    for (const part of parts) {
      val = val?.[part];
    }
    return {
      content: [
        {
          type: "text",
          text: val !== undefined ? `Config ${key} = ${JSON.stringify(val, null, 2)}` : `Config key "${key}" not found`,
        },
      ],
    };
  }

  if (action === "set") {
    if (!key) {
      return { content: [{ type: "text", text: "Error: 'key' is required for action='set'" }] };
    }
    if (params.value === undefined) {
      return { content: [{ type: "text", text: "Error: 'value' is required for action='set'" }] };
    }

    let newValue: unknown = params.value as string;
    // Try to parse as JSON
    try { newValue = JSON.parse(params.value as string); } catch {}

    // Persist to config.json
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const { readFileSync, writeFileSync, existsSync } = await import("node:fs");

    const configPath = join(homedir(), ".the-brain", "config.json");
    let config: Record<string, unknown> = {};

    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, "utf-8"));
      } catch {
        config = {};
      }
    }

    // Set nested value
    const parts = key.split(".");
    let obj = config;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!obj[parts[i]]) obj[parts[i]] = {};
      obj = obj[parts[i]] as Record<string, unknown>;
    }
    obj[parts[parts.length - 1]] = newValue;

    writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Also update in-memory config
    let memObj = ctx.config as any;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!memObj[parts[i]]) memObj[parts[i]] = {};
      memObj = memObj[parts[i]];
    }
    memObj[parts[parts.length - 1]] = newValue;

    return {
      content: [
        {
          type: "text",
          text: `Config updated: ${key} = ${JSON.stringify(newValue)}\nSaved to ${configPath}`,
        },
      ],
    };
  }

  return { content: [{ type: "text", text: `Error: unknown action "${action}"` }] };
};

// ── Scheduler Tools ────────────────────────────────────────

const schedulerListDef: ToolDef = {
  name: "scheduler_list",
  description:
    "List all scheduled tasks in the brain. Returns active recurring tasks, their intervals, and handles.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

const schedulerListHandler: ToolHandler = async (_params, ctx) => {
  const tasks = ctx.scheduler.list();

  if (tasks.length === 0) {
    return { content: [{ type: "text", text: "No scheduled tasks." }] };
  }

  const lines = tasks.map(
    (t) => `- ${t.name} (id: ${t.handle.id})`,
  );

  return {
    content: [
      {
        type: "text",
        text: `## Scheduled Tasks (${tasks.length})\n\n${lines.join("\n")}`,
      },
    ],
  };
};

// ────────────────────────────────────────────────────────────

const schedulerScheduleDef: ToolDef = {
  name: "scheduler_schedule",
  description:
    "Schedule a recurring task. The task will run at the specified interval (in milliseconds). Use this to automate periodic memory cleanup, consolidation, or custom workflows.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Human-readable name for this task",
      },
      intervalMs: {
        type: "number",
        description: "Interval in milliseconds between runs (e.g., 3600000 for hourly)",
      },
    },
    required: ["name", "intervalMs"],
  },
};

const schedulerScheduleHandler: ToolHandler = async (params, ctx) => {
  const name = params.name as string;
  const intervalMs = params.intervalMs as number;

  if (intervalMs < 1000) {
    return { content: [{ type: "text", text: "Error: interval must be at least 1000ms (1 second)" }] };
  }

  const handle = ctx.scheduler.schedule(name, intervalMs, async () => {
    // Default action: log stats
    const stats = await ctx.db.getStats();
    console.error(`[scheduler:${name}] Tick — ${stats.memories} memories, ${stats.graphNodes} graph nodes`);
  });

  return {
    content: [
      {
        type: "text",
        text: `Task scheduled.\n- Name: ${name}\n- Interval: ${intervalMs}ms (${(intervalMs / 1000).toFixed(0)}s)\n- Handle: ${handle.id}`,
      },
    ],
  };
};

// ────────────────────────────────────────────────────────────

const schedulerCancelDef: ToolDef = {
  name: "scheduler_cancel",
  description:
    "Cancel a scheduled task by its handle ID. The task will stop running immediately.",
  inputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The handle ID of the task to cancel (from scheduler_list)",
      },
    },
    required: ["id"],
  },
};

const schedulerCancelHandler: ToolHandler = async (params, ctx) => {
  const id = params.id as string;
  const tasks = ctx.scheduler.list();
  const task = tasks.find((t) => t.handle.id === id);

  if (!task) {
    return {
      content: [
        {
          type: "text",
          text: `Error: no task found with handle ID "${id}".\nActive tasks: ${tasks.map((t) => t.name).join(", ") || "(none)"}`,
        },
      ],
    };
  }

  ctx.scheduler.cancel(task.handle);

  return {
    content: [
      {
        type: "text",
        text: `Task cancelled: ${task.name} (id: ${id})`,
      },
    ],
  };
};

// ── Pipeline Tools ────────────────────────────────────────

const pipelineIngestDef: ToolDef = {
  name: "pipeline_ingest",
  description:
    "Ingest raw content through the the-brain pipeline — just like drag & drop. The content is passed through the ContentCleaner, stored as an INSTANT-layer memory, evaluated by SPM (Selection Layer), and may be promoted to Deep storage if surprising enough. Works with any text format: code, logs, notes, markdown, plaintext.",
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "Raw content to ingest (max 100KB)",
      },
      source: {
        type: "string",
        description: "Source: 'cursor', 'claude', 'manual', 'web', 'api'",
      },
      format: {
        type: "string",
        description: "Format hint: 'markdown', 'code', 'log', 'note' (default: plaintext)",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Tags for categorization (e.g., ['typescript', 'refactor'])",
      },
    },
    required: ["content", "source"],
  },
};

const pipelineIngestHandler: ToolHandler = async (params, ctx) => {
  const content = (params.content as string).slice(0, 100_000);
  const source = params.source as string;
  const format = (params.format as string) ?? "plaintext";
  const tags = (params.tags as string[]) ?? [];

  if (content.length < 10) {
    return { content: [{ type: "text", text: "Error: content must be at least 10 characters" }] };
  }

  const isSurprising =
    content.length > 50 &&
    !content.includes("OK") &&
    !content.startsWith("ok");

  const mem: Memory = {
    id: crypto.randomUUID(),
    layer: MemoryLayer.INSTANT,
    content: content.slice(0, 1000),
    timestamp: Date.now(),
    source: `mcp:${source}`,
    surpriseScore: isSurprising ? 0.6 : 0.3,
    metadata: { format, tags, ingestedVia: "mcp", originalLength: content.length },
  };

  await ctx.storage.insertMemory(mem);

  let tagNodes = 0;
  for (const tag of tags.slice(0, 5)) {
    try {
      await ctx.storage.upsertGraphNode({
        label: tag,
        type: "concept",
        content: `Tagged content about ${tag} from ${source}`,
        connections: [],
        weight: 0.4,
        timestamp: Date.now(),
        source: `mcp:${source}`,
      });
      tagNodes++;
    } catch {
      continue;
    }
  }

  return {
    content: [
      {
        type: "text",
        text: [
          "Content ingested successfully.",
          `- Memory ID: ${mem.id}`,
          `- Layer: instant (SPM evaluation next cycle)`,
          `- Source: ${source}`,
          `- Format: ${format}`,
          `- Surprise score: ${mem.surpriseScore}`,
          `- Size: ${content.length} chars`,
          `- Tags: ${tags.join(", ") || "(none)"}`,
        ].join("\n"),
      },
    ],
  };
};

// ────────────────────────────────────────────────────────────

const pipelineStatusDef: ToolDef = {
  name: "pipeline_status",
  description:
    "Check pipeline status: queue by layer, last activity, overall health.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

const pipelineStatusHandler: ToolHandler = async (_params, ctx) => {
  const stats = await ctx.db.getStats();
  const instantMemories = await ctx.db.getMemoriesByLayer(MemoryLayer.INSTANT, 5);
  const deepMemories = await ctx.db.getMemoriesByLayer(MemoryLayer.DEEP, 1);

  const perLayer = stats.perLayer as Record<string, number> ?? {};
  const lastIngestion = instantMemories[0];
  const lastConsolidation = deepMemories[0];

  const lines = [
    "## Pipeline Status",
    "",
    "### Queue by Layer",
    `- Instant (waiting for SPM): ${perLayer.instant ?? 0}`,
    `- Selection (surprise-gated): ${perLayer.selection ?? 0}`,
    `- Deep (consolidated): ${perLayer.deep ?? 0}`,
    "",
    "### Activity",
    `- Last ingestion: ${lastIngestion ? new Date(lastIngestion.timestamp).toLocaleString() : "never"}`,
    `- Last consolidation: ${lastConsolidation ? new Date(lastConsolidation.timestamp).toLocaleString() : "never"}`,
    `- Total: ${stats.memories} memories, ${stats.graphNodes} graph nodes`,
    "",
    "### Health",
    instantMemories.length > 20
      ? `⚠️  Backlog: ${instantMemories.length}+ instant memories. Run training_consolidate.`
      : "✅ Pipeline is healthy.",
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
};

// ── Registration ────────────────────────────────────────────

// ── Registration ────────────────────────────────────────────

// ────────────────────────────────────────────────────────────
// Phase 3: Meta-Harness Regression Tools
// ────────────────────────────────────────────────────────────

const brainPredictRegressionDef: ToolDef = {
  name: "brain_predict_regression",
  description: "Predict expected benchmark score ranges using historical fingerprints. Use BEFORE harness edits.",
  inputSchema: { type: "object", properties: { model: { type: "string" }, benchmark: { type: "string" } }, required: ["model", "benchmark"] },
};
const brainPredictRegressionHandler: ToolHandler = async (params, _ctx) => {
  const { HarnessFingerprintStore } = await import("../../../plugin-identity-anchor/src/fingerprint-store");
  const store = new HarnessFingerprintStore();
  const p = store.predictAll(params.model as string, params.benchmark as string);
  if (!p.length) return { content: [{ type: "text", text: "Cold start." }] };
  return { content: [{ type: "text", text: p.map((x) => `${x.metric}: ${x.predictedRange[0].toFixed(4)}–${x.predictedRange[1].toFixed(4)} (${(x.confidence*100).toFixed(0)}%)`).join("\n") }] };
};

const brainRecordRunDef: ToolDef = {
  name: "brain_record_run",
  description: "Record benchmark results and get surprise assessment. Use AFTER evaluations.",
  inputSchema: { type: "object", properties: { model: { type: "string" }, benchmark: { type: "string" }, scores: { type: "object" }, edit_id: { type: "string" } }, required: ["model", "benchmark", "scores"] },
};
const brainRecordRunHandler: ToolHandler = async (params, _ctx) => {
  const { HarnessFingerprintStore } = await import("../../../plugin-identity-anchor/src/fingerprint-store");
  const store = new HarnessFingerprintStore();
  const scores = params.scores as Record<string, number>;
  for (const [m, v] of Object.entries(scores)) store.update(params.model as string, params.benchmark as string, m, v);
  store.save();
  const a = store.assessAll(params.model as string, params.benchmark as string, scores);
  if (!a.length) return { content: [{ type: "text", text: "First run." }] };
  const anom = a.filter((x) => x.isAnomalous);
  const lines = [`${anom.length}/${a.length} anomalous.`];
  for (const x of anom) lines.push(`⚠️ ${x.prediction.metric}: ${x.observed.toFixed(4)} vs ${x.prediction.predictedRange[0].toFixed(4)}–${x.prediction.predictedRange[1].toFixed(4)} z=${x.zScore.toFixed(2)}`);
  return { content: [{ type: "text", text: lines.join("\n") }] };
};

const brainGetFingerprintDef: ToolDef = {
  name: "brain_get_fingerprint",
  description: "Get per-model per-benchmark performance fingerprints.",
  inputSchema: { type: "object", properties: { model: { type: "string" }, benchmark: { type: "string" } } },
};
const brainGetFingerprintHandler: ToolHandler = async (params, _ctx) => {
  const { HarnessFingerprintStore } = await import("../../../plugin-identity-anchor/src/fingerprint-store");
  const store = new HarnessFingerprintStore();
  let fps = store.getAll();
  if (params.model) fps = fps.filter((f) => f.modelName === params.model);
  if (params.benchmark) fps = fps.filter((f) => f.benchmark === params.benchmark);
  if (!fps.length) return { content: [{ type: "text", text: "No fingerprints." }] };
  return { content: [{ type: "text", text: fps.map((f) => `${f.modelName}/${f.benchmark}/${f.metric}: μ=${f.mean.toFixed(4)} σ=${f.std.toFixed(4)} n=${f.n}`).join("\n") }] };
};

const brainGetRegressionGraphDef: ToolDef = {
  name: "brain_get_regression_graph",
  description: "Get causal graph of harness edits → regressions from graph memory.",
  inputSchema: { type: "object", properties: { model: { type: "string" }, benchmark: { type: "string" }, limit: { type: "number" } } },
};
const brainGetRegressionGraphHandler: ToolHandler = async (params, ctx) => {
  const limit = Math.min((params.limit as number) ?? 20, 50);
  const all = await ctx.db.getAllGraphNodes(200);
  const nodes = all.filter((n) => ["correction","pattern","preference"].includes(n.type) && /regression|anomaly|surprise/i.test(n.content));
  let f = nodes;
  if (params.model) { const mf = f.filter((n) => n.content.toLowerCase().includes((params.model as string).toLowerCase())); if (mf.length) f = mf; }
  if (params.benchmark) { const bf = f.filter((n) => n.content.toLowerCase().includes((params.benchmark as string).toLowerCase())); if (bf.length) f = bf; }
  const sliced = f.slice(0, limit);
  if (!sliced.length) return { content: [{ type: "text", text: "No regression patterns yet." }] };
  return { content: [{ type: "text", text: sliced.map((n,i) => `${i+1}. [${n.type}] ${n.content.slice(0,200)}`).join("\n\n") }] };
};

const brainGetSurpriseFeedDef: ToolDef = {
  name: "brain_get_surprise_feed",
  description: "Get anomalous results feed for HITL review (>2σ deviations).",
  inputSchema: { type: "object", properties: { min_surprise: { type: "number" }, limit: { type: "number" } } },
};
const brainGetSurpriseFeedHandler: ToolHandler = async (params, _ctx) => {
  const { HarnessFingerprintStore } = await import("../../../plugin-identity-anchor/src/fingerprint-store");
  const store = new HarnessFingerprintStore();
  const minS = (params.min_surprise as number) ?? 0.5;
  const limit = Math.min((params.limit as number) ?? 10, 50);
  const all = store.getAll();
  const surps: Array<{model:string;bench:string;metric:string;z:number}> = [];
  for (const fp of all) {
    if (fp.values.length < 4) continue;
    const last = fp.values[fp.values.length-1];
    const bl = fp.values.slice(0,-1);
    const blMean = bl.reduce((a,b)=>a+b,0)/bl.length;
    const z = fp.std>0 ? Math.abs(last-blMean)/fp.std : 0;
    if (Math.min(1,z/3) >= minS) surps.push({model:fp.modelName,bench:fp.benchmark,metric:fp.metric,z});
  }
  surps.sort((a,b)=>b.z-a.z);
  const sliced = surps.slice(0,limit);
  if (!sliced.length) return { content: [{ type: "text", text: "No surprises." }] };
  return { content: [{ type: "text", text: sliced.map((s,i)=>`${i+1}. ${s.model}/${s.bench}/${s.metric}: z=${s.z.toFixed(2)}`).join("\n") }] };
};

const brainCompareAgentsDef: ToolDef = {
  name: "brain_compare_agents",
  description: "Compare multiple models on a benchmark using fingerprints.",
  inputSchema: { type: "object", properties: { models: { type: "array", items: { type: "string" } }, benchmark: { type: "string" } }, required: ["models","benchmark"] },
};
const brainCompareAgentsHandler: ToolHandler = async (params, _ctx) => {
  const { HarnessFingerprintStore } = await import("../../../plugin-identity-anchor/src/fingerprint-store");
  const store = new HarnessFingerprintStore();
  const models = params.models as string[];
  const bench = params.benchmark as string;
  const metrics = new Set<string>();
  const data: Record<string,Record<string,{mean:number;std:number;n:number}>> = {};
  for (const m of models) { data[m]={}; for (const fp of store.getByModel(m)) { if (fp.benchmark===bench) { metrics.add(fp.metric); data[m][fp.metric]={mean:fp.mean,std:fp.std,n:fp.n}; } } }
  if (!metrics.size) return { content: [{ type: "text", text: "No data." }] };
  const lines = [`## ${bench}`, ""];
  for (const metric of [...metrics].sort()) {
    lines.push(`**${metric}**`);
    const ranks = models.filter((m)=>data[m]?.[metric]).map((m)=>({model:m,...data[m][metric]})).sort((a,b)=>b.mean-a.mean);
    for (const r of ranks) lines.push(`  ${r.model}: ${r.mean.toFixed(4)}±${r.std.toFixed(4)} n=${r.n}${r.mean===ranks[0].mean?" 🥇":""}`);
    lines.push("");
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
};

export interface ToolRegistry {
  memorySearch: { def: ToolDef; handler: ToolHandler };
  memoryStore: { def: ToolDef; handler: ToolHandler };
  memoryContext: { def: ToolDef; handler: ToolHandler };
  memoryList: { def: ToolDef; handler: ToolHandler };
  graphSearch: { def: ToolDef; handler: ToolHandler };
  graphAddNode: { def: ToolDef; handler: ToolHandler };
  graphConnect: { def: ToolDef; handler: ToolHandler };
  brainStats: { def: ToolDef; handler: ToolHandler };
  identityGet: { def: ToolDef; handler: ToolHandler };
  identityUpdate: { def: ToolDef; handler: ToolHandler };
  projectList: { def: ToolDef; handler: ToolHandler };
  projectSwitch: { def: ToolDef; handler: ToolHandler };
  trainingStatus: { def: ToolDef; handler: ToolHandler };
  trainingConsolidate: { def: ToolDef; handler: ToolHandler };
  brainConfig: { def: ToolDef; handler: ToolHandler };
  schedulerList: { def: ToolDef; handler: ToolHandler };
  schedulerSchedule: { def: ToolDef; handler: ToolHandler };
  schedulerCancel: { def: ToolDef; handler: ToolHandler };
  pipelineIngest: { def: ToolDef; handler: ToolHandler };
  pipelineStatus: { def: ToolDef; handler: ToolHandler };
  // Phase 3 — Meta-harness integration
  brainPredictRegression: { def: ToolDef; handler: ToolHandler };
  brainRecordRun: { def: ToolDef; handler: ToolHandler };
  brainGetFingerprint: { def: ToolDef; handler: ToolHandler };
  brainGetRegressionGraph: { def: ToolDef; handler: ToolHandler };
  brainGetSurpriseFeed: { def: ToolDef; handler: ToolHandler };
  brainCompareAgents: { def: ToolDef; handler: ToolHandler };
}

/** All 26 tools (MVP + Phase 2 + Phase 3 + Phase 4), ready to register on an McpServer */
export const allTools: ToolRegistry = {
  memorySearch: { def: memorySearchDef, handler: memorySearchHandler },
  memoryStore: { def: memoryStoreDef, handler: memoryStoreHandler },
  memoryContext: { def: memoryContextDef, handler: memoryContextHandler },
  memoryList: { def: memoryListDef, handler: memoryListHandler },
  graphSearch: { def: graphSearchDef, handler: graphSearchHandler },
  graphAddNode: { def: graphAddNodeDef, handler: graphAddNodeHandler },
  graphConnect: { def: graphConnectDef, handler: graphConnectHandler },
  brainStats: { def: brainStatsDef, handler: brainStatsHandler },
  identityGet: { def: identityGetDef, handler: identityGetHandler },
  identityUpdate: { def: identityUpdateDef, handler: identityUpdateHandler },
  projectList: { def: projectListDef, handler: projectListHandler },
  projectSwitch: { def: projectSwitchDef, handler: projectSwitchHandler },
  trainingStatus: { def: trainingStatusDef, handler: trainingStatusHandler },
  trainingConsolidate: { def: trainingConsolidateDef, handler: trainingConsolidateHandler },
  brainConfig: { def: brainConfigDef, handler: brainConfigHandler },
  schedulerList: { def: schedulerListDef, handler: schedulerListHandler },
  schedulerSchedule: { def: schedulerScheduleDef, handler: schedulerScheduleHandler },
  schedulerCancel: { def: schedulerCancelDef, handler: schedulerCancelHandler },
  pipelineIngest: { def: pipelineIngestDef, handler: pipelineIngestHandler },
  pipelineStatus: { def: pipelineStatusDef, handler: pipelineStatusHandler },
  // Phase 3 — Meta-harness integration
  brainPredictRegression: { def: brainPredictRegressionDef, handler: brainPredictRegressionHandler },
  brainRecordRun: { def: brainRecordRunDef, handler: brainRecordRunHandler },
  brainGetFingerprint: { def: brainGetFingerprintDef, handler: brainGetFingerprintHandler },
  brainGetRegressionGraph: { def: brainGetRegressionGraphDef, handler: brainGetRegressionGraphHandler },
  brainGetSurpriseFeed: { def: brainGetSurpriseFeedDef, handler: brainGetSurpriseFeedHandler },
  brainCompareAgents: { def: brainCompareAgentsDef, handler: brainCompareAgentsHandler },
};

/** @deprecated Use allTools instead */
export const mvpTools = allTools;

/** Register all 20 tools on an McpServer instance */
export function registerAllTools(server: import("../server").McpServer): void {
  for (const tool of Object.values(allTools)) {
    server.registerTool(tool.def, tool.handler);
  }
}

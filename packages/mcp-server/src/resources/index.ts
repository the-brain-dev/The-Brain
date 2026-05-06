/**
 * MCP Resources — URI-addressable read-only data.
 *
 * Resources are structured data that MCP clients can read
 * and optionally subscribe to for changes.
 *
 * URIs use the brain:// scheme:
 *   brain://memories/recent
 *   brain://memories/search?q=X
 *   brain://memories/{id}
 *   brain://graph/nodes?type=X
 *   brain://stats
 *   brain://health
 *   brain://identity/current
 *   brain://training/status
 *   brain://projects
 *   brain://config
 */

import type { ResourceDef, ResourceHandler } from "../server";
import { MemoryLayer } from "@the-brain/core";

// ── Resource Definitions ────────────────────────────────────

const memoriesRecentDef: ResourceDef = {
  uri: "brain://memories/recent",
  name: "Recent Memories",
  description: "The most recent memories across all layers",
  mimeType: "text/plain",
};

const memoriesRecentHandler: ResourceHandler = async (_uri, ctx) => {
  const memories = await ctx.db.getRecentMemories(4);
  const text = memories.length === 0
    ? "No recent memories."
    : memories
        .map((m) => `[${m.layer}] ${m.content} (${new Date(m.timestamp).toISOString()})`)
        .join("\n---\n");
  return { contents: [{ uri: "brain://memories/recent", mimeType: "text/plain", text }] };
};

// ────────────────────────────────────────────────────────────

const memoriesSearchDef: ResourceDef = {
  uri: "brain://memories/search",
  name: "Memory Search",
  description: "Search memories by query string. Pass ?q=<query>&layer=<layer>",
  mimeType: "text/plain",
};

const memoriesSearchHandler: ResourceHandler = async (uri, ctx) => {
  const query = (uri.searchParams.get("q") ?? "").toLowerCase();
  const layer = uri.searchParams.get("layer");

  if (!query) {
    return { contents: [{ uri: uri.href, mimeType: "text/plain", text: "Pass ?q=<query> to search memories" }] };
  }

  let memories = await ctx.db.getAllMemories(200);
  if (layer) {
    memories = await ctx.db.getMemoriesByLayer(layer as MemoryLayer, 200);
  }

  const matches = memories
    .filter((m) => m.content.toLowerCase().includes(query))
    .slice(0, 10);

  const text = matches.length === 0
    ? `No memories match "${query}".`
    : matches
        .map((m) => `[${m.layer}] ${m.content}`)
        .join("\n---\n");

  return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
};

// ────────────────────────────────────────────────────────────

const memoriesByIdDef: ResourceDef = {
  uri: "brain://memories/{id}",
  name: "Memory by ID",
  description: "A single memory by its ID",
  mimeType: "application/json",
};

const memoriesByIdHandler: ResourceHandler = async (uri, ctx) => {
  // Extract {id} from the URI path
  const id = uri.pathname.split("/memories/")[1];
  if (!id) {
    return { contents: [{ uri: uri.href, mimeType: "text/plain", text: "Missing memory ID" }] };
  }

  const mem = await ctx.db.getMemoryById(id);

  if (!mem) {
    return { contents: [{ uri: uri.href, mimeType: "text/plain", text: `Memory "${id}" not found` }] };
  }

  return {
    contents: [{
      uri: uri.href,
      mimeType: "application/json",
      text: JSON.stringify(mem, null, 2),
    }],
  };
};

// ── Graph Resources ────────────────────────────────────────

const graphNodesDef: ResourceDef = {
  uri: "brain://graph/nodes",
  name: "Graph Nodes",
  description: "Knowledge graph nodes. Pass ?type=concept|correction|preference|pattern to filter",
  mimeType: "application/json",
};

const graphNodesHandler: ResourceHandler = async (uri, ctx) => {
  const nodeType = uri.searchParams.get("type");
  const nodes = await ctx.db.getHighWeightNodes(0);

  const filtered = nodeType
    ? nodes.filter((n) => n.type === nodeType)
    : nodes;

  return {
    contents: [{
      uri: uri.href,
      mimeType: "application/json",
      text: JSON.stringify(filtered.slice(0, 50), null, 2),
    }],
  };
};

// ────────────────────────────────────────────────────────────

const graphNodeByIdDef: ResourceDef = {
  uri: "brain://graph/nodes/{id}",
  name: "Graph Node by ID",
  description: "A single graph node by its ID",
  mimeType: "application/json",
};

const graphNodeByIdHandler: ResourceHandler = async (uri, ctx) => {
  const id = uri.pathname.split("/graph/nodes/")[1];
  if (!id) {
    return { contents: [{ uri: uri.href, mimeType: "text/plain", text: "Missing node ID" }] };
  }

  const node = await ctx.db.getGraphNode(id);
  if (!node) {
    return { contents: [{ uri: uri.href, mimeType: "text/plain", text: `Node "${id}" not found` }] };
  }

  return {
    contents: [{
      uri: uri.href,
      mimeType: "application/json",
      text: JSON.stringify(node, null, 2),
    }],
  };
};

// ── Stats & Health ──────────────────────────────────────────

const statsDef: ResourceDef = {
  uri: "brain://stats",
  name: "Brain Statistics",
  description: "Comprehensive statistics about the brain",
  mimeType: "application/json",
};

const statsHandler: ResourceHandler = async (_uri, ctx) => {
  const stats = await ctx.db.getStats();
  return {
    contents: [{
      uri: "brain://stats",
      mimeType: "application/json",
      text: JSON.stringify(stats, null, 2),
    }],
  };
};

// ────────────────────────────────────────────────────────────

const healthDef: ResourceDef = {
  uri: "brain://health",
  name: "Health Check",
  description: "Daemon health and connection status",
  mimeType: "application/json",
};

const healthHandler: ResourceHandler = async (_uri, ctx) => {
  const stats = await ctx.db.getStats();
  const health = {
    status: "ok",
    daemon: true,
    memories: stats.memories,
    graphNodes: stats.graphNodes,
    projects: Array.from(ctx.projects.keys()),
    activeProject: ctx.currentProject,
  };
  return {
    contents: [{
      uri: "brain://health",
      mimeType: "application/json",
      text: JSON.stringify(health, null, 2),
    }],
  };
};

// ── Identity ────────────────────────────────────────────────

const identityCurrentDef: ResourceDef = {
  uri: "brain://identity/current",
  name: "Current Identity",
  description: "The current identity anchor (developer traits)",
  mimeType: "application/json",
};

const identityCurrentHandler: ResourceHandler = async (_uri, ctx) => {
  const nodes = await ctx.db.getHighWeightNodes(0.5);
  const prefs = nodes.filter((n) => n.type === "preference" || n.type === "pattern");
  const identity = prefs.map((n) => ({
    label: n.label,
    content: n.content,
    weight: n.weight,
    source: n.source,
  }));

  return {
    contents: [{
      uri: "brain://identity/current",
      mimeType: "application/json",
      text: JSON.stringify(identity, null, 2),
    }],
  };
};

// ── Training ────────────────────────────────────────────────

const trainingStatusDef: ResourceDef = {
  uri: "brain://training/status",
  name: "Training Status",
  description: "Status of the last training/consolidation run",
  mimeType: "application/json",
};

const trainingStatusHandler: ResourceHandler = async (_uri, ctx) => {
  const deepMemories = await ctx.db.getMemoriesByLayer(MemoryLayer.DEEP, 1000);
  const lastConsolidation = deepMemories[0]?.timestamp ?? null;

  const status = {
    lastConsolidation: lastConsolidation ? new Date(lastConsolidation).toISOString() : null,
    deepMemoryCount: deepMemories.length,
  };

  return {
    contents: [{
      uri: "brain://training/status",
      mimeType: "application/json",
      text: JSON.stringify(status, null, 2),
    }],
  };
};

// ── Projects ────────────────────────────────────────────────

const projectsDef: ResourceDef = {
  uri: "brain://projects",
  name: "Projects",
  description: "All registered projects with metadata",
  mimeType: "application/json",
};

const projectsHandler: ResourceHandler = async (_uri, ctx) => {
  const projects = Array.from(ctx.projects.entries()).map(([name, proj]) => ({
    name,
    label: proj.label,
    active: name === ctx.currentProject,
    lastActive: proj.lastActive ? new Date(proj.lastActive).toISOString() : null,
    createdAt: new Date(proj.createdAt).toISOString(),
    dbPath: proj.dbPath,
  }));

  return {
    contents: [{
      uri: "brain://projects",
      mimeType: "application/json",
      text: JSON.stringify(projects, null, 2),
    }],
  };
};

// ── Config ──────────────────────────────────────────────────

const configDef: ResourceDef = {
  uri: "brain://config",
  name: "Configuration",
  description: "Current the-brain configuration",
  mimeType: "application/json",
};

const configHandler: ResourceHandler = async (_uri, ctx) => {
  const cfg = ctx.config;
  return {
    contents: [{
      uri: "brain://config",
      mimeType: "application/json",
      text: JSON.stringify({
        database: cfg.database?.path ?? "unknown",
        pollInterval: cfg.daemon?.pollIntervalMs,
        pluginCount: cfg.plugins?.length ?? 0,
        backends: cfg.backends ?? {},
      }, null, 2),
    }],
  };
};

// ── Registration ────────────────────────────────────────────

export interface ResourceRegistry {
  memoriesRecent: { def: ResourceDef; handler: ResourceHandler };
  memoriesSearch: { def: ResourceDef; handler: ResourceHandler };
  memoriesById: { def: ResourceDef; handler: ResourceHandler };
  graphNodes: { def: ResourceDef; handler: ResourceHandler };
  graphNodeById: { def: ResourceDef; handler: ResourceHandler };
  stats: { def: ResourceDef; handler: ResourceHandler };
  health: { def: ResourceDef; handler: ResourceHandler };
  identityCurrent: { def: ResourceDef; handler: ResourceHandler };
  trainingStatus: { def: ResourceDef; handler: ResourceHandler };
  projects: { def: ResourceDef; handler: ResourceHandler };
  config: { def: ResourceDef; handler: ResourceHandler };
}

/** All 11 resources, ready to register */
export const allResources: ResourceRegistry = {
  memoriesRecent: { def: memoriesRecentDef, handler: memoriesRecentHandler },
  memoriesSearch: { def: memoriesSearchDef, handler: memoriesSearchHandler },
  memoriesById: { def: memoriesByIdDef, handler: memoriesByIdHandler },
  graphNodes: { def: graphNodesDef, handler: graphNodesHandler },
  graphNodeById: { def: graphNodeByIdDef, handler: graphNodeByIdHandler },
  stats: { def: statsDef, handler: statsHandler },
  health: { def: healthDef, handler: healthHandler },
  identityCurrent: { def: identityCurrentDef, handler: identityCurrentHandler },
  trainingStatus: { def: trainingStatusDef, handler: trainingStatusHandler },
  projects: { def: projectsDef, handler: projectsHandler },
  config: { def: configDef, handler: configHandler },
};

/** Register all resources on an McpServer instance */
export function registerAllResources(server: import("../server").McpServer): void {
  for (const resource of Object.values(allResources)) {
    server.registerResource(resource.def, resource.handler);
  }
}

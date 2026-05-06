/**
 * @the-brain/mcp-server — MCP (Model Context Protocol) 2024-11-05
 *
 * Lightweight JSON-RPC 2.0 server exposing the-brain as an MCP backend.
 * Supports stdio transport for Claude Desktop, Cursor, Zed, and other
 * MCP-compatible AI tools.
 *
 * Protocol: https://modelcontextprotocol.io/specification/2024-11-05
 */

import type { Readable, Writable } from "node:stream";
import type { BrainDB } from "@the-brain/core";
import type { StorageBackend, SchedulerPlugin } from "@the-brain/core";
import type { TheBrainConfig, MemoryLayer, ProjectContext, GraphNodeRecord, Memory } from "@the-brain/core";

// ── MCP Protocol Types ──────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface ServerCapabilities {
  tools: { listChanged: boolean };
  resources?: { listChanged: boolean; subscribe: boolean };
}

/** Handler function for an MCP tool call */
export type ToolHandler = (
  params: Record<string, unknown>,
  ctx: McpServerContext,
) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

// ── Resource Types ────────────────────────────────────────────

export interface ResourceDef {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** Handler for reading a resource. Receives the parsed URI and returns content. */
export type ResourceHandler = (
  uri: URL,
  ctx: McpServerContext,
) => Promise<{ contents: Array<{ uri: string; mimeType?: string; text: string }> }>;

// ── McpServerContext ────────────────────────────────────────────

export interface McpServerContext {
  db: BrainDB;
  storage: StorageBackend;
  scheduler: SchedulerPlugin;
  config: TheBrainConfig;
  /** Loaded project contexts (name → context) */
  projects: Map<string, ProjectContext>;
  /** Currently active project name */
  currentProject: string;
}

// ── McpServer ──────────────────────────────────────────────────

export class McpServer {
  private tools: Map<string, { def: ToolDef; handler: ToolHandler }> = new Map();
  private resources: Map<string, { def: ResourceDef; handler: ResourceHandler }> = new Map();
  private subscriptions: Map<string, Set<string>> = new Map(); // uri → sessionIds
  private initialized = false;
  private serverInfo: { name: string; version: string };

  /** Optional callback for pushing notifications to connected sessions (SSE) */
  onNotification?: (sessionId: string, notification: Record<string, unknown>) => void;

  constructor(
    private ctx: McpServerContext,
    serverName = "the-brain",
    serverVersion = "0.2.0",
  ) {
    this.serverInfo = { name: serverName, version: serverVersion };
  }

  /** Register a tool definition + handler */
  registerTool(def: ToolDef, handler: ToolHandler): void {
    this.tools.set(def.name, { def, handler });
  }

  /** Register a resource definition + handler */
  registerResource(def: ResourceDef, handler: ResourceHandler): void {
    this.resources.set(def.uri, { def, handler });
  }

  // ── JSON-RPC Dispatcher ────────────────────────────────────

  /**
   * Handle a single JSON-RPC request. Returns a response object.
   * Call this from your transport layer.
   */
  async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const base = { jsonrpc: "2.0" as const, id: req.id };

    try {
      switch (req.method) {
        case "initialize": {
          const result = this.handleInitialize(req.params ?? {});
          return { ...base, result };
        }
        case "initialized":
          // Notification — no response needed, but some clients expect ack
          this.initialized = true;
          return { ...base, result: {} };
        case "tools/list": {
          const result = this.handleToolsList();
          return { ...base, result };
        }
        case "tools/call": {
          const result = await this.handleToolsCall(req.params ?? {});
          return { ...base, result };
        }
        case "resources/list": {
          const result = this.handleResourcesList();
          return { ...base, result };
        }
        case "resources/read": {
          const result = await this.handleResourcesRead(req.params ?? {});
          return { ...base, result };
        }
        case "resources/subscribe": {
          const result = this.handleResourcesSubscribe(req.params ?? {});
          return { ...base, result };
        }
        case "resources/unsubscribe": {
          const result = this.handleResourcesUnsubscribe(req.params ?? {});
          return { ...base, result };
        }
        case "ping":
          return { ...base, result: {} };
        default:
          return {
            ...base,
            error: { code: -32601, message: `Method not found: ${req.method}` },
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ...base, error: { code: -32603, message: `Internal error: ${message}` } };
    }
  }

  // ── Protocol Handlers ──────────────────────────────────────

  private handleInitialize(params: Record<string, unknown>) {
    const capabilities: ServerCapabilities = {
      tools: { listChanged: false },
      resources: { listChanged: false, subscribe: true },
    };
    return {
      protocolVersion: "2024-11-05",
      serverInfo: this.serverInfo,
      capabilities,
    };
  }

  private handleToolsList() {
    return {
      tools: Array.from(this.tools.values()).map((t) => t.def),
    };
  }

  private async handleToolsCall(params: Record<string, unknown>) {
    const toolName = params.name as string;
    const toolArgs = (params.arguments as Record<string, unknown>) ?? {};

    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    return await tool.handler(toolArgs, this.ctx);
  }

  private handleResourcesList() {
    const resourceList = Array.from(this.resources.values()).map((r) => r.def);
    return { resources: resourceList };
  }

  private async handleResourcesRead(params: Record<string, unknown>) {
    const uri = params.uri as string;
    if (!uri) {
      throw new Error("Missing 'uri' parameter");
    }

    // Find matching resource — try exact match first, then prefix match
    const resource = this.resources.get(uri);
    if (resource) {
      return await resource.handler(new URL(uri), this.ctx);
    }

    // Prefix match for templated URIs like brain://memories/{id}
    for (const [template, res] of this.resources) {
      // If template contains {placeholder}, do pattern matching
      if (template.includes("{")) {
        const regex = new RegExp("^" + template.replace(/\{[^}]+\}/g, "([^/]+)") + "$");
        if (regex.test(uri)) {
          return await res.handler(new URL(uri), this.ctx);
        }
      }
      // Also try prefix matching
      if (uri.startsWith(template) && !template.includes("{")) {
        return await res.handler(new URL(uri), this.ctx);
      }
    }

    throw new Error(`Unknown resource: ${uri}`);
  }

  private handleResourcesSubscribe(params: Record<string, unknown>) {
    const uri = params.uri as string;
    if (!uri) throw new Error("Missing 'uri' parameter");
    // Track subscription. In SSE transport, sessionId is extracted from URL.
    const sessionId = (params._sessionId as string) ?? "default";
    if (!this.subscriptions.has(uri)) {
      this.subscriptions.set(uri, new Set());
    }
    this.subscriptions.get(uri)!.add(sessionId);
    return { subscribed: true, uri };
  }

  private handleResourcesUnsubscribe(params: Record<string, unknown>) {
    const uri = params.uri as string;
    if (!uri) throw new Error("Missing 'uri' parameter");
    const sessionId = (params._sessionId as string) ?? "default";
    const subs = this.subscriptions.get(uri);
    if (subs) {
      subs.delete(sessionId);
      if (subs.size === 0) this.subscriptions.delete(uri);
    }
    return { unsubscribed: true, uri };
  }

  /**
   * Notify all subscribers of a resource change.
   * Pushes a notifications/resources/updated JSON-RPC notification
   * through the onNotification callback if set.
   */
  notifyResourceChanged(uri: string, sessionId?: string): void {
    // Push through SSE transport if available
    if (this.onNotification && sessionId) {
      this.onNotification(sessionId, {
        jsonrpc: "2.0",
        method: "notifications/resources/updated",
        params: { uri },
      });
    }
    // Broadcast to all subscribers (if we had session tracking per URI)
  }
}

// ── Transport: stdio ──────────────────────────────────────────

/**
 * Run the MCP server over stdio (stdin/stdout).
 * This is the standard transport for Claude Desktop, Cursor, Zed.
 *
 * Messages are delimited by newlines (JSON-RPC is line-delimited over stdio).
 */
export async function runStdioServer(server: McpServer): Promise<void> {
  // Use async iteration over stdin lines
  const stdin = Bun.stdin.stream();
  const decoder = new TextDecoder();

  // Read line by line
  let buffer = "";

  for await (const chunk of stdin) {
    buffer += decoder.decode(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const req: JsonRpcRequest = JSON.parse(trimmed);
        const res = await server.handleRequest(req);

        // Write response back to stdout
        const json = JSON.stringify(res);
        process.stdout.write(json + "\n");

        // Force flush for stdio transport
        if (typeof process.stdout.fd === "number") {
          // @ts-ignore Bun-specific
          Bun.fsync(process.stdout.fd);
        }
      } catch (parseErr) {
        // If we can't parse the request, there's no id to respond to
        // Write a generic JSON-RPC parse error
        const errRes = {
          jsonrpc: "2.0" as const,
          id: null,
          error: { code: -32700, message: "Parse error" },
        };
        process.stdout.write(JSON.stringify(errRes) + "\n");
      }
    }
  }
}

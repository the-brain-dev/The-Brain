/**
 * @the-brain-dev/mcp-server — Public API
 *
 * Exposes the-brain as an MCP (Model Context Protocol) server.
 * Used by Claude Desktop, Cursor, Zed, and other MCP-compatible AI tools.
 */

export { McpServer, runStdioServer } from "./server";
export type { ToolDef, ToolHandler, ResourceDef, ResourceHandler, McpServerContext, JsonRpcRequest } from "./server";
export { allTools, mvpTools, registerAllTools } from "./tools/index";
export type { ToolRegistry } from "./tools/index";
export { allResources, registerAllResources } from "./resources/index";
export type { ResourceRegistry } from "./resources/index";
export { startSseServer } from "./transports/sse";

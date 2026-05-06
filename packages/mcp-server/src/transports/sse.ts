/**
 * MCP Transport: HTTP + SSE (Server-Sent Events)
 *
 * Protocol: client connects to GET /sse, receives an endpoint URL,
 * then POSTs JSON-RPC requests to that endpoint. Server pushes
 * responses back through the SSE stream.
 *
 * Spec: https://modelcontextprotocol.io/specification/2024-11-05/basic/transports#server-sent-events-sse
 */

import type { McpServer, JsonRpcRequest } from "../server";
import { randomUUID } from "node:crypto";

interface SseSession {
  id: string;
  controller: ReadableStreamDefaultController;
}

interface SseServerOptions {
  port?: number;
  host?: string;
  /** Auth token for remote mode. If set, requires Authorization: Bearer <token> */
  authToken?: string;
  /** TLS certificate path (for HTTPS) */
  tlsCert?: string;
  /** TLS key path (for HTTPS) */
  tlsKey?: string;
}

/**
 * Start an MCP server over HTTP/SSE transport.
 * Returns a Bun server instance. Call .stop() to shut down.
 */
export function startSseServer(
  server: McpServer,
  options: SseServerOptions = {},
) {
  const port = options.port ?? 9422;
  const host = options.host ?? "127.0.0.1";

  // Active SSE connections keyed by session ID
  const sessions = new Map<string, SseSession>();

  /** Push a JSON-RPC notification to a specific session */
  function pushToSession(sessionId: string, notification: Record<string, unknown>): void {
    const session = sessions.get(sessionId);
    if (session) {
      try {
        const sseEvent = `event: message\ndata: ${JSON.stringify(notification)}\n\n`;
        session.controller.enqueue(new TextEncoder().encode(sseEvent));
      } catch {
        sessions.delete(sessionId);
      }
    }
  }

  // Wire server's notification callback to push through SSE
  server.onNotification = (sessionId, notification) => {
    pushToSession(sessionId, notification);
  };

  const bunServer = Bun.serve({
    port,
    hostname: host,
    async fetch(req) {
      const url = new URL(req.url);

      // ── Auth check (remote mode) ──
      if (options.authToken) {
        // Health check endpoint is public
        if (url.pathname !== "/") {
          const auth = req.headers.get("authorization");
          const expected = `Bearer ${options.authToken}`;
          if (auth !== expected) {
            return new Response(
              JSON.stringify({ error: "Unauthorized", hint: "Pass Authorization: Bearer <token>" }),
              { status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
            );
          }
        }
      }

      // ── GET /sse — establish SSE connection ──────────────
      if (req.method === "GET" && url.pathname === "/sse") {
        const sessionId = randomUUID();
        const messageEndpoint = `/message?sessionId=${sessionId}`;

        let streamController!: ReadableStreamDefaultController;

        const stream = new ReadableStream({
          start(controller) {
            streamController = controller;
            sessions.set(sessionId, { id: sessionId, controller });

            // First event: the endpoint URL for POST requests
            const endpointEvent = `event: endpoint\ndata: ${messageEndpoint}\n\n`;
            controller.enqueue(new TextEncoder().encode(endpointEvent));
          },
          cancel() {
            sessions.delete(sessionId);
          },
        });

        // Cleanup on disconnect — use stream's cancel() callback (already handled above)
        // Bun's Request.signal is an AbortSignal, use standard API
        if (req.signal) {
          req.signal.addEventListener("abort", () => {
            sessions.delete(sessionId);
          });
        }

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      // ── POST /message — receive JSON-RPC request ─────────
      if (req.method === "POST" && url.pathname === "/message") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId || !sessions.has(sessionId)) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32001, message: "Session not found" },
            }),
            { status: 404, headers: { "Content-Type": "application/json" } },
          );
        }

        try {
          const body = await req.json() as JsonRpcRequest;
          // Inject sessionId into params so subscribe/unsubscribe can track sessions
          if (body.method === "resources/subscribe" || body.method === "resources/unsubscribe") {
            body.params = { ...body.params, _sessionId: sessionId };
          }
          const response = await server.handleRequest(body);

          // Push response through the SSE stream
          const sseEvent = `event: message\ndata: ${JSON.stringify(response)}\n\n`;
          const session = sessions.get(sessionId)!;
          try {
            session.controller.enqueue(new TextEncoder().encode(sseEvent));
          } catch {
            // Stream closed — session is already being removed
          }

          // Acknowledge receipt with HTTP 202
          return new Response(null, {
            status: 202,
            headers: { "Access-Control-Allow-Origin": "*" },
          });
        } catch (err) {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error" },
            }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        }
      }

      // ── OPTIONS — CORS preflight ────────────────────────
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }

      // ── GET / — health check ────────────────────────────
      if (req.method === "GET" && url.pathname === "/") {
        return new Response(
          JSON.stringify({
            server: "the-brain MCP",
            version: "0.2.0",
            transport: "sse",
            endpoints: {
              sse: `http://${host}:${port}/sse`,
              message: `http://${host}:${port}/message?sessionId=<id>`,
            },
            sessions: sessions.size,
          }),
          {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  return bunServer;
}

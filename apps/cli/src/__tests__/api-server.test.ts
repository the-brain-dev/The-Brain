/**
 * Tests for api-server.ts — HTTP endpoints for the the-brain daemon.
 *
 * Tests: health, stats, consolidate, train, ingest-file, ingest-interaction,
 * auth, CORS, 404, error handling.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";

// ── Helpers ──────────────────────────────────────────────────────

function getRandomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

interface MockDB {
  getStats: () => Promise<{
    memories: number;
    instantCount: number;
    selectionCount: number;
    deepCount: number;
    graphNodes: number;
  }>;
  getSurprisingMemories: (threshold: number) => Promise<unknown[]>;
  getMemoriesByLayer: (layer: unknown, limit: number) => Promise<unknown[]>;
  getAllMemories: () => Promise<unknown[]>;
}

function createMockEngine(overrides: Record<string, unknown> = {}) {
  const calls: { event: string; args: unknown[] }[] = [];
  const mockDB: MockDB = {
    async getStats() {
      return {
        memories: 42,
        instantCount: 20,
        selectionCount: 15,
        deepCount: 7,
        graphNodes: 8,
      };
    },
    async getSurprisingMemories(_threshold: number) {
      return [
        { id: "m-1", content: "test", layer: "selection", surpriseScore: 0.5, timestamp: Date.now(), source: "test" },
      ];
    },
    async getMemoriesByLayer(_layer: unknown, _limit: number) {
      return [
        { id: "m-2", content: "deep content", layer: "deep", surpriseScore: 0.8, timestamp: Date.now(), source: "test" },
      ];
    },
    async getAllMemories() {
      return [];
    },
  };

  return {
    running: true,
    activeProject: "test-project",
    interactionCount: 10,
    projectManager: {
      getActiveDB: async () => mockDB,
    },
    layerRouter: {
      runDeep: async (_ctx: unknown) => {},
    },
    hooks: {
      callHook: async (event: string, ...args: unknown[]) => {
        calls.push({ event, args });
      },
    },
    _calls: calls,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("API Server", () => {
  let testDir: string;
  let server: Server;
  let baseUrl: string;
  let port: number;

  beforeAll(async () => {
    testDir = mkdtempSync(join(tmpdir(), "api-server-test-"));
    port = getRandomPort();

    const { startAPIServer } = await import("../api-server");
    const engine = createMockEngine();
    const state = {
      startTime: Date.now() - 60000, // 1 min ago
      lastTraining: null,
      lastTrainingDuration: null,
      lastTrainingLoss: null,
      lastConsolidationAt: null,
    };

    server = startAPIServer(engine as any, state, {
      mode: "local",
      bindAddress: "127.0.0.1",
      port,
    });

    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    if (server) server.stop();
    if (testDir) {
      try { rmSync(testDir, { recursive: true, force: true }); } catch {}
    }
  });

  // ── Health ─────────────────────────────────────────────────

  describe("GET /api/health", () => {
    it("returns daemon status", async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.status).toBe("running");
      expect(data.pid).toBeGreaterThan(0);
      expect(data.activeProject).toBe("test-project");
      expect(data.interactionCount).toBe(10);
      expect(data.mode).toBe("local");
    });

    it("includes formatted uptime", async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      const data = await res.json();
      expect(typeof data.uptime).toBe("number");
      expect(data.uptime).toBeGreaterThan(0);
      expect(typeof data.uptimeFormatted).toBe("string");
      expect(data.uptimeFormatted.length).toBeGreaterThan(0);
    });
  });

  // ── Stats ─────────────────────────────────────────────────

  describe("GET /api/stats", () => {
    it("returns memory and graph stats", async () => {
      const res = await fetch(`${baseUrl}/api/stats`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.memories.total).toBe(42);
      expect(data.memories.instant).toBe(20);
      expect(data.memories.selection).toBe(15);
      expect(data.memories.deep).toBe(7);
      expect(data.graphNodes).toBe(8);
    });

    it("includes training and consolidation timestamps", async () => {
      const res = await fetch(`${baseUrl}/api/stats`);
      const data = await res.json();
      expect(data).toHaveProperty("lastConsolidation");
      expect(data).toHaveProperty("lastTraining");
    });
  });

  // ── Consolidate ───────────────────────────────────────────

  describe("POST /api/consolidate", () => {
    it("triggers consolidation and returns result", async () => {
      const res = await fetch(`${baseUrl}/api/consolidate`, { method: "POST" });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.consolidated).toBe(true);
      expect(data.memoriesProcessed).toBe(1);
      expect(typeof data.timestamp).toBe("number");
    });
  });

  // ── Train ────────────────────────────────────────────────

  describe("POST /api/train", () => {
    it("triggers training and returns result", async () => {
      const res = await fetch(`${baseUrl}/api/train`, { method: "POST" });
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.trained).toBe(true);
      expect(data.fragmentCount).toBeGreaterThan(0);
      expect(typeof data.duration).toBe("number");
    });
  });

  // ── Ingest File ──────────────────────────────────────────

  describe("POST /api/ingest-file", () => {
    it("rejects empty paths", async () => {
      const res = await fetch(`${baseUrl}/api/ingest-file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("No file paths");
    });

    it("rejects path traversal (..)", async () => {
      const res = await fetch(`${baseUrl}/api/ingest-file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: ["../../etc/passwd"] }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ingested).toBe(0);
      expect(data.results[0].ingested).toBe(false);
      expect(data.results[0].error).toContain("Path traversal blocked");
    });

    it("rejects non-existent files", async () => {
      const res = await fetch(`${baseUrl}/api/ingest-file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: ["/nonexistent/file.txt"] }),
      });
      const data = await res.json();
      expect(data.results[0].ingested).toBe(false);
      expect(data.results[0].error).toContain("File not found");
    });
  });

  // ── Ingest Interaction ───────────────────────────────────

  describe("POST /api/ingest-interaction", () => {
    it("accepts valid interaction payload", async () => {
      const res = await fetch(`${baseUrl}/api/ingest-interaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          interaction: {
            prompt: "Test prompt",
            response: "Test response",
            source: "cli",
            timestamp: Date.now(),
          },
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ingested).toBe(true);
      expect(typeof data.id).toBe("string");
    });

    it("rejects missing interaction field", async () => {
      const res = await fetch(`${baseUrl}/api/ingest-interaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("interaction");
    });
  });

  // ── Edge Cases ───────────────────────────────────────────

  describe("Edge Cases", () => {
    it("returns 404 for unknown routes", async () => {
      const res = await fetch(`${baseUrl}/api/nonexistent`);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe("Not found");
    });

    it("handles OPTIONS preflight (CORS)", async () => {
      const res = await fetch(`${baseUrl}/api/health`, { method: "OPTIONS" });
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    });
  });

  // ── Auth (Remote Mode) ──────────────────────────────────

  describe("Auth (Remote Mode)", () => {
    let authServer: Server;
    let authPort: number;
    let authUrl: string;

    beforeAll(async () => {
      authPort = getRandomPort();
      const { startAPIServer } = await import("../api-server");
      const engine = createMockEngine();

      authServer = startAPIServer(engine as any, {
        startTime: Date.now(),
        lastTraining: null,
        lastTrainingDuration: null,
        lastTrainingLoss: null,
        lastConsolidationAt: null,
      }, {
        mode: "remote",
        bindAddress: "127.0.0.1",
        authToken: "test-token-123",
        port: authPort,
      });

      authUrl = `http://127.0.0.1:${authPort}`;
    });

    afterAll(() => {
      if (authServer) authServer.stop();
    });

    it("allows /api/health without auth", async () => {
      const res = await fetch(`${authUrl}/api/health`);
      expect(res.status).toBe(200);
    });

    it("blocks /api/stats without auth in remote mode", async () => {
      const res = await fetch(`${authUrl}/api/stats`);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("Unauthorized");
    });

    it("allows /api/stats with valid Bearer token", async () => {
      const res = await fetch(`${authUrl}/api/stats`, {
        headers: { Authorization: "Bearer test-token-123" },
      });
      expect(res.status).toBe(200);
    });

    it("blocks with wrong token", async () => {
      const res = await fetch(`${authUrl}/api/stats`, {
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
    });
  });
});

/**
 * @the-brain/plugin-identity-anchor
 * Deep Layer Helper — maintains a stable "Self-Vector" across retrains
 * to prevent catastrophic forgetting of the agent's core persona.
 *
 * This plugin:
 *   1. Captures identity-relevant fragments (preferences, conventions, style)
 *   2. Maintains a "self-vector" as their centroid
 *   3. Persists anchors to disk so they survive restarts
 *   4. Detects drift between new training data and the self-vector
 *   5. Provides identity fragments to trainers for boosted inclusion
 */
import { definePlugin, HookEvent, MemoryLayer } from "@the-brain/core";
import type { Memory, InteractionContext, ConsolidationContext, MemoryFragment } from "@the-brain/core";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { HarnessFingerprintStore } from "./fingerprint-store";
import type {
  RegressionPrediction,
  SurpriseAssessment,
  HarnessEditMetadata,
} from "@the-brain/core";

interface IdentityAnchorConfig {
  /** Minimum surprise score to consider an identity-relevant fragment */
  minIdentityScore: number;
  /** Maximum number of identity fragments to retain */
  maxAnchorFragments: number;
  /** Identity dimension keywords to watch for */
  identityKeywords: string[];
  /** Path to anchor state file (persistence across sessions). Empty = no persistence. */
  statePath: string;
  /** Multi-user mode: base directory for per-user identity state files */
  userStatesDir: string;
  /** Drift threshold: if cosine distance > this, trigger identity boost */
  driftThreshold: number;
  /** Boost factor: identity fragments are repeated N times in training */
  identityBoostFactor: number;
}

const DEFAULT_CONFIG: IdentityAnchorConfig = {
  minIdentityScore: 0.7,
  maxAnchorFragments: 50,
  // Language-agnostic: empty default. Users can still configure language-specific
  // keywords, but the primary detection uses embedding similarity to the self-vector.
  identityKeywords: [],
  statePath: "", // No persistence by default — opt-in via config
  userStatesDir: "", // No multi-user by default
  driftThreshold: 0.35,
  identityBoostFactor: 3,
};

// ── Persisted state shape ──────────────────────────────────────

interface PersistedAnchor {
  id: string;
  content: string;
  surpriseScore?: number;
  timestamp: number;
  source: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
}

// ── Plugin factory ─────────────────────────────────────────────

export function createIdentityAnchorPlugin(
  config: Partial<IdentityAnchorConfig> = {}
) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let anchorFragments: Memory[] = [];
  /** Per-user anchor fragments: userId → fragments. Populated in multi-user mode. */
  const userFragments: Map<string, Memory[]> = new Map();
  /** Currently active user (set via identity-anchor:switchUser hook or interaction metadata) */
  let currentUserId: string | null = null;

  // ── Fingerprint store (Phase 2: Regression Fingerprinting) ──
  const fingerprintStore = new HarnessFingerprintStore();

  // ── State path resolution ───────────────────────────────────

  /**
   * Resolve the state path for a given user.
   * In multi-user mode: {userStatesDir}/{userId}.json
   * In single-user mode: cfg.statePath
   */
  function resolveStatePath(userId?: string): string {
    if (cfg.userStatesDir && userId) {
      return join(cfg.userStatesDir, `${userId}.json`);
    }
    return cfg.statePath;
  }

  // ── User state switching ────────────────────────────────────

  function switchUser(userId: string): void {
    if (currentUserId === userId) return;
    saveState(); // Persist current user's state before switching
    currentUserId = userId;
    anchorFragments = userFragments.get(userId) || [];
    loadState(userId);
  }

  // ── Persistence ────────────────────────────────────────────

  function saveState(userId?: string): void {
    const uid = userId ?? currentUserId;
    const path = resolveStatePath(uid ?? undefined);
    if (!path) return;
    try {
      const dir = uid && cfg.userStatesDir ? cfg.userStatesDir : join(homedir(), ".the-brain");
      mkdirSync(dir, { recursive: true });

      const fragmentsToSave = uid ? (userFragments.get(uid) || anchorFragments) : anchorFragments;

      const data: PersistedAnchor[] = fragmentsToSave.map((f) => ({
        id: f.id,
        content: f.content,
        surpriseScore: f.surpriseScore,
        timestamp: f.timestamp,
        source: f.source,
        embedding: f.embedding,
        metadata: f.metadata,
      }));

      writeFileSync(path, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error("[IdentityAnchor] Failed to save state:", err);
    }
  }

  function loadState(userId?: string): void {
    const uid = userId ?? currentUserId;
    const path = resolveStatePath(uid ?? undefined);
    if (!path) return;
    try {
      if (!existsSync(path)) return;

      const raw = readFileSync(path, "utf-8");
      const data: PersistedAnchor[] = JSON.parse(raw);

      const fragments = data.map((a) => ({
        id: a.id,
        layer: MemoryLayer.DEEP,
        content: a.content,
        embedding: a.embedding,
        surpriseScore: a.surpriseScore,
        timestamp: a.timestamp,
        source: a.source,
        metadata: {
          ...a.metadata,
          identityAnchor: true,
        },
      }));

      // Enforce max size
      if (fragments.length > cfg.maxAnchorFragments) {
        fragments.sort((a, b) => b.timestamp - a.timestamp);
        fragments.splice(cfg.maxAnchorFragments);
      }

      if (uid) {
        userFragments.set(uid, fragments);
      }
      anchorFragments = fragments;
    } catch (err) {
      console.error("[IdentityAnchor] Failed to load state file:", err);
      // File doesn't exist yet or is corrupt — start fresh
    }
  }

  // ── Identity detection ──────────────────────────────────────

  /**
   * Detect whether content is identity-relevant.
   *
   * Primary: embedding similarity to the running self-vector (language-agnostic).
   * Fallback: configured keywords (if any) + structural heuristics:
   *   - Short, declarative statements (20-200 chars)
   *   - High surprise score (already gated by caller)
   */
  function isIdentityRelevant(fragment: MemoryFragment): boolean {
    // ── Primary: embedding similarity to self-vector ─────
    // Only use when we have enough anchors (≥3) for a stable self-vector
    const selfVector = computeSelfVector();
    const minAnchorsForEmbedding = 3;
    const anchorsWithEmbeddings = anchorFragments.filter(
      (f) => f.embedding && f.embedding.length > 0
    ).length;

    if (
      selfVector &&
      anchorsWithEmbeddings >= minAnchorsForEmbedding &&
      fragment.embedding &&
      fragment.embedding.length > 0
    ) {
      const similarity = cosineSimilarity(selfVector, fragment.embedding);
      // High similarity to the self-vector → identity-relevant
      if (similarity > 0.6) return true;
      // Low similarity → not identity-relevant, don't fall through
      return false;
    }

    // ── Fallback: configured keywords (language-specific) ──
    const { content } = fragment;
    const lower = content.toLowerCase();
    if (cfg.identityKeywords.some((kw) => lower.includes(kw.toLowerCase()))) {
      return true;
    }

    // ── Structural heuristic: short declarative statements ─
    // Identity-relevant content tends to be concise
    if (cfg.identityKeywords.length === 0) {
      const trimmed = content.trim();
      // Short declarative fragments (20-200 chars) with high surprise
      // are more likely to be identity-relevant than long technical logs
      if (trimmed.length >= 20 && trimmed.length <= 200) {
        const surpriseScore = fragment.surpriseScore ?? 0;
        return surpriseScore >= cfg.minIdentityScore;
      }
    }

    return false;
  }

  // ── Cosine similarity ───────────────────────────────────────

  function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || b.length === 0) return 0;
    const maxLen = Math.max(a.length, b.length);
    const a2 = a.length < maxLen ? [...a, ...Array(maxLen - a.length).fill(0)] : a;
    const b2 = b.length < maxLen ? [...b, ...Array(maxLen - b.length).fill(0)] : b;

    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < maxLen; i++) {
      dot += a2[i] * b2[i];
      magA += a2[i] * a2[i];
      magB += b2[i] * b2[i];
    }
    return magA === 0 || magB === 0 ? 0 : dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }

  // ── Self-vector computation ──────────────────────────────────

  function computeSelfVector(): number[] | null {
    const withEmbeddings = anchorFragments.filter(
      (f) => f.embedding && f.embedding.length > 0
    );
    if (withEmbeddings.length === 0) return null;

    const dim = withEmbeddings[0].embedding!.length;
    const vector = new Array(dim).fill(0);
    for (const f of withEmbeddings) {
      for (let i = 0; i < dim; i++) {
        vector[i] += f.embedding![i];
      }
    }
    for (let i = 0; i < dim; i++) {
      vector[i] /= withEmbeddings.length;
    }
    return vector;
  }

  // ── Drift detection ─────────────────────────────────────────

  /**
   * Compute cosine distance between the self-vector and a new set of fragments.
   * Returns { drift, needsBoost } — if drift exceeds threshold, training
   * should include extra identity fragment copies to prevent forgetting.
   */
  function computeDrift(newFragments: MemoryFragment[]): {
    drift: number;
    needsBoost: boolean;
  } {
    const selfVector = computeSelfVector();
    if (!selfVector) return { drift: 0, needsBoost: false };

    // Compute centroid of new fragments (only those with embeddings)
    const withEmb = newFragments.filter((f) => f.embedding && f.embedding.length > 0);
    if (withEmb.length === 0) return { drift: 0, needsBoost: false };

    const dim = selfVector.length;
    const newCentroid = new Array(dim).fill(0);
    for (const f of withEmb) {
      for (let i = 0; i < dim; i++) {
        newCentroid[i] += (f.embedding![i] || 0);
      }
    }
    for (let i = 0; i < dim; i++) {
      newCentroid[i] /= withEmb.length;
    }

    const similarity = cosineSimilarity(selfVector, newCentroid);
    const drift = 1 - similarity; // cosine distance

    return {
      drift,
      needsBoost: drift > cfg.driftThreshold,
    };
  }

  /**
   * Generate boosted training fragments — identity fragments repeated
   * N times to ensure the model remembers core preferences.
   */
  function getIdentityTrainingFragments(): Array<{
    text: string;
    metadata: Record<string, unknown>;
  }> {
    const fragments: Array<{ text: string; metadata: Record<string, unknown> }> = [];

    for (const anchor of anchorFragments) {
      for (let i = 0; i < cfg.identityBoostFactor; i++) {
        fragments.push({
          text: anchor.content,
          metadata: {
            ...anchor.metadata,
            identityBoosted: true,
            boostCopy: i,
            anchorId: anchor.id,
          },
        });
      }
    }

    return fragments;
  }

  // ── Plugin definition ───────────────────────────────────────

  const plugin = definePlugin({
    name: "@the-brain/plugin-identity-anchor",
    version: "0.2.0",
    description:
      "Maintains a stable Self-Vector across retrains to prevent catastrophic forgetting of core persona. Includes persistence, drift detection, and training boost.",

    setup(hooks) {
      // Load persisted state on startup
      loadState();

      // ── Capture identity-relevant interactions from Selection Layer ──

      hooks.hook(HookEvent.SELECTION_PROMOTE, async (ctx: InteractionContext) => {
        let changed = false;

        // Detect user from interaction metadata (set by auth layer in team mode)
        const userId = (ctx.interaction?.metadata as any)?.userId as string | undefined;

        for (const fragment of ctx.fragments) {
          if (
            isIdentityRelevant(fragment) &&
            (fragment.surpriseScore ?? 0) >= cfg.minIdentityScore
          ) {
            const identityFragment: Memory = {
              ...fragment,
              layer: MemoryLayer.DEEP,
              metadata: {
                ...fragment.metadata,
                identityAnchor: true,
                anchoredAt: Date.now(),
                ...(userId ? { userId } : {}),
              },
            };

            anchorFragments.push(identityFragment);
            changed = true;

            if (anchorFragments.length > cfg.maxAnchorFragments) {
              anchorFragments.sort((a, b) => b.timestamp - a.timestamp);
              anchorFragments = anchorFragments.slice(0, cfg.maxAnchorFragments);
            }
          }
        }

        if (changed) {
          // In multi-user mode, persist to the user-specific state file
          if (userId && cfg.userStatesDir) {
            userFragments.set(userId, anchorFragments);
            saveState(userId);
          } else {
            saveState();
          }
        }
      });

      // ── Before consolidation: attach identity data, detect drift ──

      hooks.hook(HookEvent.DEEP_CONSOLIDATE, async (ctx: ConsolidationContext) => {
        const selfVector = computeSelfVector();
        const drift = computeDrift(ctx.fragments);

        (ctx as any).identityAnchor = {
          fragmentCount: anchorFragments.length,
          selfVector,
          drift: drift.drift,
          needsBoost: drift.needsBoost,
          fragments: anchorFragments.map((f) => ({
            id: f.id,
            content: f.content.slice(0, 200),
            timestamp: f.timestamp,
            hasEmbedding: !!(f.embedding && f.embedding.length > 0),
          })),
        };

        // If drift is high, inject identity fragments into the consolidation
        // so the trainer sees them. Attach to context.fragments.
        if (drift.needsBoost && selfVector) {
          console.log(
            `[IdentityAnchor] Drift detected: ${drift.drift.toFixed(3)} > ${cfg.driftThreshold}. Boosting identity presence.`
          );

          const boosted = getIdentityTrainingFragments();
          (ctx as any).identityAnchor.boostedFragments = boosted;
        }
      });

      // ── Custom hooks for external consumers ────────────────────

      hooks.hook("identity-anchor:switchUser" as any, async (userId: string) => {
        switchUser(userId);
      });

      hooks.hook("identity-anchor:getState" as any, async (opts?: { userId?: string }) => {
        // If userId is provided and different from current, temporarily load that user
        const targetId = opts?.userId ?? currentUserId;
        if (targetId && targetId !== currentUserId && cfg.userStatesDir) {
          userFragments.set(currentUserId!, [...anchorFragments]);
          const saved = userFragments.get(targetId);
          if (saved) {
            anchorFragments = saved;
          } else {
            // Load from disk
            const path = resolveStatePath(targetId);
            if (path && existsSync(path)) {
              try {
                const raw = readFileSync(path, "utf-8");
                const data: PersistedAnchor[] = JSON.parse(raw);
                anchorFragments = data.map((a) => ({
                  id: a.id, layer: MemoryLayer.DEEP, content: a.content,
                  embedding: a.embedding, surpriseScore: a.surpriseScore,
                  timestamp: a.timestamp, source: a.source,
                  metadata: { ...a.metadata, identityAnchor: true },
                }));
                userFragments.set(targetId, anchorFragments);
              } catch { /* ignore */ }
            } else {
              anchorFragments = [];
            }
          }
        }

        return {
          fragmentCount: anchorFragments.length,
          maxFragments: cfg.maxAnchorFragments,
          selfVector: computeSelfVector(),
          keywords: cfg.identityKeywords,
          driftThreshold: cfg.driftThreshold,
          userId: targetId,
          fragments: anchorFragments.slice(0, 10).map((f) => ({
            id: f.id,
            content: f.content.slice(0, 200),
            timestamp: f.timestamp,
          })),
        };
      });

      hooks.hook("identity-anchor:getBoostedFragments" as any, async () =>
        getIdentityTrainingFragments()
      );

      hooks.hook("identity-anchor:computeDrift" as any, async (newFragments: MemoryFragment[]) =>
        computeDrift(newFragments)
      );

      // ── Phase 2: Regression Fingerprinting hooks ────────────

      // Auto-update fingerprints from lm-eval interactions
      hooks.hook(HookEvent.ON_INTERACTION, async (ctx: InteractionContext) => {
        const interaction = ctx.interaction;
        if (interaction.source !== "lm-eval") return;

        const metadata = interaction.metadata as Record<string, unknown> | undefined;
        if (!metadata?.tasks) return;

        const tasks = metadata.tasks as Array<{
          name: string;
          scores: Array<{ metric: string; value: number }>;
        }>;

        for (const task of tasks) {
          for (const score of task.scores) {
            fingerprintStore.update(
              interaction.source === "lm-eval"
                ? (metadata.model as string) || "unknown"
                : "unknown",
              task.name,
              score.metric,
              score.value,
            );
          }
        }

        // Save after batch update
        if (fingerprintStore.isDirty()) {
          fingerprintStore.save();
        }
      });

      // Custom: predict regression for a model+benchmark pair
      hooks.hook("identity-anchor:predictRegression" as any, async (opts: {
        model: string;
        benchmark: string;
      }): Promise<RegressionPrediction[]> => {
        return fingerprintStore.predictAll(opts.model, opts.benchmark);
      });

      // Custom: assess surprise for an observed score
      hooks.hook("identity-anchor:assessSurprise" as any, async (opts: {
        model: string;
        benchmark: string;
        metric: string;
        observed: number;
      }): Promise<SurpriseAssessment | null> => {
        return fingerprintStore.assess(
          opts.model,
          opts.benchmark,
          opts.metric,
          opts.observed,
        );
      });

      // Custom: get all fingerprints
      hooks.hook("identity-anchor:getFingerprints" as any, async () => {
        return fingerprintStore.getAll();
      });

      // Custom: detect model drift
      hooks.hook("identity-anchor:detectDrift" as any, async (opts: {
        model: string;
        benchmark: string;
        windowSize?: number;
      }) => {
        return fingerprintStore.detectDrift(
          opts.model,
          opts.benchmark,
          opts.windowSize,
        );
      });

      // Custom: get fingerprint summary
      hooks.hook("identity-anchor:fingerprintSummary" as any, async () => {
        return fingerprintStore.summary();
      });
    },

    teardown() {
      // Save fingerprints before clearing
      if (fingerprintStore.isDirty()) {
        fingerprintStore.save();
      }
      saveState(); // Persist before clearing
      anchorFragments = [];
    },
  });

  return plugin;
}

export default createIdentityAnchorPlugin();

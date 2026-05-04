/**
 * @my-brain/plugin-spm-curator
 *
 * Surprise-Gated Self-Predictive Memory Selection Layer plugin.
 *
 * Maintains a running predictive model of the user's typical interactions
 * and mathematically calculates prediction errors to filter out mundane
 * interactions — keeping only the "surprising" ones worthy of consolidation
 * into Deep (long-term) memory.
 *
 * ## Model Design
 *
 * The predictive model operates over a feature space derived from each
 * interaction. For every new interaction we:
 *
 *   1. Extract a feature vector f ∈ ℝⁿ (scalar + embedding dimensions).
 *   2. Compare f against a running Gaussian model N(μ, σ²) updated via
 *      exponential moving average (EMA).
 *   3. Compute the Mahalanobis-style surprise score as a weighted sum of:
 *        - per-feature z-scores (scalar deviation from expected),
 *        - cosine distance from the running semantic centroid (embedding),
 *        - content novelty ratio (fraction of n‑grams never seen before).
 *   4. Gate: if the composite score exceeds a configurable threshold,
 *      the interaction is marked as "surprising" and promoted.
 *
 * This approximates a lightweight online Bayesian surprise detector
 * (Itti & Baldi, 2005) with O(d) cost per interaction, suitable for
 * running persistently in a background daemon without GPU.
 *
 * ## References
 *
 *   - Itti, L., & Baldi, P. (2005). Bayesian surprise attracts human attention.
 *     NeurIPS.
 *   - Schmidhuber, J. (2010). Formal theory of creativity, fun, and intrinsic
 *     motivation. IEEE TAMD.
 */

import {
  definePlugin,
  MemoryLayer,
  HookEvent,
  type SelectionLayerPlugin,
  type InteractionContext,
  type SurpriseGateResult,
  type MemoryFragment,
  type Interaction,
} from "@my-brain/core";
import { TfidfSurpriseDetector } from "./tfidf-detector";
import type { TfidfState } from "./tfidf-detector";

// ── Configuration ──────────────────────────────────────────────────────────

export interface SpmCuratorConfig {
  /** Surprise threshold (0‑1). Scores ≥ this value are promoted. */
  threshold: number;

  /** EMA decay factor for the running mean: μ ← α·x + (1‑α)·μ */
  alpha: number;

  /** Weight of scalar-feature z‑scores in the composite score. */
  scalarWeight: number;

  /** Weight of embedding cosine distance in the composite score. */
  embeddingWeight: number;

  /** Weight of n‑gram novelty ratio in the composite score. */
  noveltyWeight: number;

  /** N‑gram size for the novelty detector. */
  ngramN: number;

  /** Maximum number of n‑grams to retain in the known‑set. */
  ngramCacheSize: number;

  /** Use TF-IDF based surprise detection instead of EMA-Gaussian. */
  useTfidf: boolean;
}

const DEFAULT_CONFIG: SpmCuratorConfig = {
  threshold: 0.82, // TF-IDF is now default — calibrated for cosine distance spread
  alpha: 0.05,
  scalarWeight: 0.35,
  embeddingWeight: 0.40,
  noveltyWeight: 0.25,
  ngramN: 4,
  ngramCacheSize: 50_000,
  useTfidf: true,  // TF-IDF is now the default — wider spread (+93%), better discrimination
};

// ── Scalar Feature Vector (user-observable text statistics) ────────────────

interface FeatureVector {
  promptLen: number;
  responseLen: number;
  totalLen: number;
  /** Ratio of unique tokens to total tokens (lexical diversity). */
  lexicalDiversity: number;
  /** Hour of day [0‑23] when the interaction occurred. */
  hourOfDay: number;
  /** Day of week [0‑6] when the interaction occurred. */
  dayOfWeek: number;
}

// ── Running Gaussian Model (scalar features) ───────────────────────────────

interface GaussianAccumulator {
  mean: number;
  m2: number; // sum of squared differences from the current mean (Welford)
  count: number;
}

function initGaussian(): GaussianAccumulator {
  return { mean: 0, m2: 1, count: 1 }; // start with unit variance to avoid div‑0
}

/**
 * Update the running mean and variance via Welford's online algorithm.
 * Returns the current standard deviation.
 */
function updateGaussian(acc: GaussianAccumulator, x: number, alpha: number): number {
  // EMA update for the mean
  acc.mean = alpha * x + (1 - alpha) * acc.mean;

  // Welford update for M2 (running sum of squared deviations)
  const delta = x - acc.mean;
  acc.m2 = (1 - alpha) * (acc.m2 + alpha * delta * delta);
  acc.count += 1;

  const variance = acc.m2 / (acc.count - 1);
  return Math.sqrt(Math.max(variance, 1e-8));
}

/**
 * Compute z‑score: how many standard deviations x is from μ.
 * Clamped to [0, 5] to prevent outliers from dominating.
 */
function zScore(acc: GaussianAccumulator, x: number): number {
  const variance = acc.m2 / Math.max(acc.count - 1, 1);
  const sigma = Math.sqrt(Math.max(variance, 1e-8));
  return Math.min(Math.abs(x - acc.mean) / sigma, 5);
}

// ── Running Semantic Centroid (embedding features) ─────────────────────────

interface EmbeddingCentroid {
  /** Exponential moving average of the embedding vector. */
  centroid: number[];
}

function initCentroid(dim: number): EmbeddingCentroid {
  return { centroid: new Array(dim).fill(0) };
}

/**
 * Update the running EMA centroid with a new embedding vector.
 * centroid ← α·v + (1‑α)·centroid
 */
function updateCentroid(centroid: EmbeddingCentroid, vec: number[], alpha: number): void {
  for (let i = 0; i < centroid.centroid.length; i++) {
    centroid.centroid[i] = alpha * (vec[i] ?? 0) + (1 - alpha) * centroid.centroid[i];
  }
}

/**
 * Cosine distance = 1 − cosineSimilarity ∈ [0, 2].
 * Returns 0 when vecs are identical, 2 when diametrically opposite.
 */
function cosineDistance(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  const normProduct = Math.sqrt(na) * Math.sqrt(nb);
  if (normProduct < 1e-12) return 0;
  const cosSim = dot / normProduct;
  // Clamp for floating‑point safety
  return 1 - Math.max(-1, Math.min(1, cosSim));
}

// ── N‑gram Novelty Detector ────────────────────────────────────────────────

class NgramNoveltyDetector {
  private known = new Set<string>();
  private queue: string[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  /**
   * Extract character n‑grams from text and return the fraction
   * that are *not* in the known set (novelty ratio ∈ [0, 1]).
   * Also adds all extracted n‑grams to the known set.
   */
  noveltyRatio(text: string, n: number): number {
    if (!text || text.length < n) return 1; // too short ⇒ fully novel

    const ngrams = new Set<string>();
    for (let i = 0; i <= text.length - n; i++) {
      ngrams.add(text.slice(i, i + n));
    }

    if (ngrams.size === 0) return 0;

    let novel = 0;
    for (const gram of ngrams) {
      if (!this.known.has(gram)) {
        novel++;
        this.add(gram);
      }
    }

    return novel / ngrams.size;
  }

  private add(gram: string): void {
    this.known.add(gram);
    this.queue.push(gram);
    // Evict oldest entries when over capacity
    while (this.queue.length > this.maxSize) {
      const removed = this.queue.shift();
      if (removed) this.known.delete(removed);
    }
  }

  /** Number of known n‑grams (for introspection). */
  get size(): number {
    return this.known.size;
  }
}

// ── Interaction Hash (lightweight fingerprint for dedup) ───────────────────

/**
 * djb2 — a fast, non‑cryptographic string hash.
 * Used to track recently seen interaction fingerprints.
 */
function djb2(s: string): number {
  let hash = 5_381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

// ── Feature Extraction ─────────────────────────────────────────────────────

function extractFeatures(interaction: Interaction): FeatureVector {
  const prompt = interaction.prompt ?? "";
  const response = interaction.response ?? "";
  const combined = prompt + " " + response;

  // Tokenize naively on whitespace for lexical diversity
  const tokens = combined.split(/\s+/).filter(Boolean);
  const uniqueTokens = new Set(tokens.map((t) => t.toLowerCase()));

  const date = new Date(interaction.timestamp);

  return {
    promptLen: prompt.length,
    responseLen: response.length,
    totalLen: combined.length,
    lexicalDiversity: tokens.length > 0 ? uniqueTokens.size / tokens.length : 0,
    hourOfDay: date.getHours(),
    dayOfWeek: date.getDay(),
  };
}

// ── Surprise Score Calculation ─────────────────────────────────────────────

/**
 * Composite surprise score ∈ [0, 1] combining:
 *   1. Scalar feature z‑scores    (how statistically unusual)
 *   2. Embedding cosine distance  (how semantically distant)
 *   3. N‑gram novelty ratio       (how much genuinely new content)
 *
 * All three sub‑scores are normalized to [0, 1] before the
 * weighted linear combination.
 */
function computeScore(params: {
  features: FeatureVector;
  gaussians: Record<keyof FeatureVector, GaussianAccumulator>;
  centroid: EmbeddingCentroid | null;
  embedding: number[] | undefined;
  noveltyRatio: number;
  config: SpmCuratorConfig;
}): { score: number; scalarScore: number; embScore: number; noveltyScore: number } {
  const { features, gaussians, centroid, embedding, noveltyRatio, config } = params;

  // ── 1. Scalar z‑score (average over features, normalized to [0, 1]) ──
  const featureKeys: (keyof FeatureVector)[] = [
    "promptLen",
    "responseLen",
    "totalLen",
    "lexicalDiversity",
    "hourOfDay",
    "dayOfWeek",
  ];

  let totalZ = 0;
  for (const key of featureKeys) {
    const z = zScore(gaussians[key], features[key]);
    totalZ += z;
  }
  // Each z ∈ [0, 5]; normalize to [0, 1]
  const scalarScore = Math.min(totalZ / (featureKeys.length * 5), 1);

  // ── 2. Embedding cosine distance (already in [0, 2]; normalize) ──
  let embScore = 0;
  if (centroid && embedding && embedding.length > 0) {
    const dist = cosineDistance(embedding, centroid.centroid);
    embScore = Math.min(dist / 2, 1);
  }

  // ── 3. N‑gram novelty (already in [0, 1]) ──
  const noveltyScore = noveltyRatio;

  // Weighted sum
  const composite =
    config.scalarWeight * scalarScore +
    config.embeddingWeight * embScore +
    config.noveltyWeight * noveltyScore;

  return {
    score: Math.min(composite, 1),
    scalarScore,
    embScore,
    noveltyScore,
  };
}

// ── The Plugin ─────────────────────────────────────────────────────────────

export function createSpmCurator(configOverrides: Partial<SpmCuratorConfig> = {}): {
  definition: ReturnType<typeof definePlugin>;
  instance: SpmCuratorPlugin;
} {
  const config = { ...DEFAULT_CONFIG, ...configOverrides };
  const instance = new SpmCuratorPlugin(config);

  const definition = definePlugin({
    name: "@my-brain/plugin-spm-curator",
    version: "0.1.0",
    description:
      "Surprise-Gated Self-Predictive Memory curator — filters mundane interactions via online predictive modeling.",

    setup(hooks) {
      // Register as a Selection Layer participant
      hooks.hook(HookEvent.SELECTION_EVALUATE, async (ctx: InteractionContext) => {
        const result = await instance.evaluate(ctx);
        // Publish the result so other plugins / the LayerRouter can see it
        await hooks.callHook(HookEvent.SELECTION_EVALUATE + ":result" as any, result, ctx);
      });

      hooks.hook(HookEvent.SELECTION_PROMOTE, async (ctx: InteractionContext) => {
        const fragments = await instance.promote(ctx);
        for (const f of fragments) {
          ctx.promoteToDeep(f);
        }
      });

      hooks.hook(HookEvent.ON_INTERACTION, async (ctx: InteractionContext) => {
        // Update our internal predictive model with every interaction,
        // regardless of whether it was surprising — the model needs to
        // learn the baseline of "normal" to detect deviations.
        instance.absorb(ctx.interaction, ctx.fragments);
      });

      // Expose the instance via a well‑known hook so the daemon / config UI
      // can inspect stats and adjust the threshold at runtime.
      hooks.hook("spm-curator:getInstance" as any, () => instance);
    },

    teardown() {
      instance.reset();
    },
  });

  return { definition, instance };
}

// ── Plugin Class ───────────────────────────────────────────────────────────

export class SpmCuratorPlugin implements SelectionLayerPlugin {
  readonly layer = MemoryLayer.SELECTION;
  readonly config: SpmCuratorConfig;

  // Per‑feature Gaussian accumulators
  private gaussians: Record<keyof FeatureVector, GaussianAccumulator> = {
    promptLen: initGaussian(),
    responseLen: initGaussian(),
    totalLen: initGaussian(),
    lexicalDiversity: initGaussian(),
    hourOfDay: initGaussian(),
    dayOfWeek: initGaussian(),
  };

  // Running semantic centroid (lazily initialized on first embedding)
  private centroid: EmbeddingCentroid | null = null;

  // N‑gram novelty detector
  private noveltyDetector: NgramNoveltyDetector;

  // TF-IDF based surprise detector (alternative to EMA-Gaussian)
  private tfidf: TfidfSurpriseDetector | null = null;

  // Recently seen interaction hashes (for fast dedup)
  private recentHashes = new Set<number>();
  private maxRecentHashes = 5_000;

  // Stats
  private totalEvaluated = 0;
  private totalPromoted = 0;

  constructor(config: SpmCuratorConfig) {
    this.config = config;
    this.noveltyDetector = new NgramNoveltyDetector(config.ngramCacheSize);
    if (config.useTfidf) {
      this.tfidf = new TfidfSurpriseDetector();
    }
  }

  // ── SelectionLayerPlugin implementation ──────────────────────────────

  /**
   * Evaluate an interaction — compute the composite surprise score
   * and decide whether it crosses the promotion threshold.
   */
  async evaluate(ctx: InteractionContext): Promise<SurpriseGateResult> {
    this.totalEvaluated++;

    const { interaction, fragments } = ctx;

    // Quick dedup: skip exact repeats of very recent interactions
    const fingerprint = this.hashInteraction(interaction);
    if (this.recentHashes.has(fingerprint)) {
      return {
        isSurprising: false,
        score: 0,
        predictionError: 0,
        reason: "Duplicate of recently seen interaction",
      };
    }
    this.recentHashes.add(fingerprint);
    this.pruneRecentHashes();

    // ── TF-IDF mode: use cosine distance from centroid ─────────────────
    if (this.config.useTfidf && this.tfidf?.getStats().finalized) {
      const combinedText = (interaction.prompt + " " + interaction.response);
      const score = this.tfidf.score(combinedText);
      const isSurprising = score >= this.config.threshold;

      return {
        isSurprising,
        score,
        predictionError: score,
        reason: `tfidf=${score.toFixed(3)} (cosine distance) | threshold=${this.config.threshold}`,
      };
    }

    // ── Legacy EMA-Gaussian mode (fallback when TF-IDF not ready) ──────
    // Extract features
    const features = extractFeatures(interaction);

    // Grab the first available embedding from fragments
    const embedding = fragments.find((f) => f.embedding?.length)?.embedding;

    // Compute n‑gram novelty
    const combinedText = (interaction.prompt + " " + interaction.response).toLowerCase();
    const noveltyRatio = this.noveltyDetector.noveltyRatio(combinedText, this.config.ngramN);

    // Compute composite score
    const { score, scalarScore, embScore, noveltyScore } = computeScore({
      features,
      gaussians: this.gaussians,
      centroid: this.centroid,
      embedding,
      noveltyRatio,
      config: this.config,
    });

    const isSurprising = score >= this.config.threshold;

    // Build a human‑readable reason
    const parts: string[] = [];
    parts.push(`composite=${score.toFixed(3)}`);
    parts.push(`scalar=${scalarScore.toFixed(3)}`);
    parts.push(`embedding=${embScore.toFixed(3)}`);
    parts.push(`novelty=${noveltyScore.toFixed(3)}`);
    const reason = `surprise=${score.toFixed(3)} (${parts.join(", ")}) | threshold=${this.config.threshold}`;

    return {
      isSurprising,
      score,
      predictionError: score, // in this model, prediction error ≡ surprise score
      reason,
    };
  }

  /**
   * Promote worthy fragments to Deep Layer.
   * Tags fragments with their surprise score and returns them
   * so the LayerRouter can hand them to Deep consolidation plugins.
   */
  async promote(ctx: InteractionContext): Promise<MemoryFragment[]> {
    // Re‑evaluate if we haven't already (promote should be called after evaluate)
    const result = await this.evaluate(ctx);

    if (!result.isSurprising) return [];

    this.totalPromoted++;

    // Annotate each fragment with the surprise score and promote it
    const promoted: MemoryFragment[] = [];
    for (const fragment of ctx.fragments) {
      const annotated: MemoryFragment = {
        ...fragment,
        layer: MemoryLayer.DEEP,
        surpriseScore: result.score,
        metadata: {
          ...(fragment.metadata ?? {}),
          spmCurator: {
            score: result.score,
            scalarScore: result.score, // sub‑scores recomputed in evaluate
            noveltyScore: result.score,
            threshold: this.config.threshold,
            evaluatedAt: Date.now(),
          },
        },
      };
      promoted.push(annotated);
      ctx.promoteToDeep(annotated);
    }

    return promoted;
  }

  // ── Model Update ─────────────────────────────────────────────────────

  /**
   * Absorb an interaction into the running predictive model.
   * Called on every interaction (not just surprising ones) so the model
   * learns what "normal" looks like.
   */
  absorb(interaction: Interaction, fragments: MemoryFragment[]): void {
    // ── TF-IDF mode: update centroid ────────────────────────────────
    if (this.config.useTfidf && this.tfidf) {
      const text = (interaction.prompt + " " + interaction.response);
      if (this.tfidf.getStats().finalized) {
        this.tfidf.updateCentroid(text);
      } else {
        // Still building vocabulary — just add the document
        this.tfidf.addDocument(text);
      }
      // Continue to legacy path too while vocab isn't finalized
      if (this.tfidf.getStats().finalized) return;
    }

    // ── Legacy mode: update Gaussians ───────────────────────────────
    const features = extractFeatures(interaction);
    const { alpha } = this.config;

    // Update scalar Gaussians
    const featureKeys: (keyof FeatureVector)[] = [
      "promptLen",
      "responseLen",
      "totalLen",
      "lexicalDiversity",
      "hourOfDay",
      "dayOfWeek",
    ];

    for (const key of featureKeys) {
      updateGaussian(this.gaussians[key], features[key], alpha);
    }

    // Update embedding centroid
    const embedding = fragments.find((f) => f.embedding?.length)?.embedding;
    if (embedding && embedding.length > 0) {
      if (!this.centroid) {
        this.centroid = initCentroid(embedding.length);
        // Seed the centroid with the first embedding
        for (let i = 0; i < embedding.length; i++) {
          this.centroid.centroid[i] = embedding[i] ?? 0;
        }
      } else {
        updateCentroid(this.centroid, embedding, alpha);
      }
    }

    // The novelty detector was already updated during evaluate/absorb.
    // (We intentionally update novelty state in evaluate to avoid double‑counting.)
  }

  // ── Introspection & Control ──────────────────────────────────────────

  /** Current running statistics (for dashboards / debugging). */
  getStats() {
    const gaussianSnapshots = {} as Record<string, { mean: number; sigma: number; count: number }>;
    for (const [key, g] of Object.entries(this.gaussians)) {
      const variance = g.m2 / Math.max(g.count - 1, 1);
      gaussianSnapshots[key] = {
        mean: Math.round(g.mean * 100) / 100,
        sigma: Math.round(Math.sqrt(variance) * 100) / 100,
        count: g.count,
      };
    }

    return {
      gaussians: gaussianSnapshots,
      centroidDim: this.centroid?.centroid.length ?? 0,
      ngramCacheSize: this.noveltyDetector.size,
      recentHashCount: this.recentHashes.size,
      totalEvaluated: this.totalEvaluated,
      totalPromoted: this.totalPromoted,
      promoteRate:
        this.totalEvaluated > 0
          ? Math.round((this.totalPromoted / this.totalEvaluated) * 1000) / 10
          : 0,
      threshold: this.config.threshold,
      alpha: this.config.alpha,
    };
  }

  /** Dynamically adjust the surprise threshold at runtime. */
  setThreshold(t: number): void {
    this.config.threshold = Math.max(0, Math.min(1, t));
  }

  /** Reset the model to its initial state. */
  reset(): void {
    this.gaussians = {
      promptLen: initGaussian(),
      responseLen: initGaussian(),
      totalLen: initGaussian(),
      lexicalDiversity: initGaussian(),
      hourOfDay: initGaussian(),
      dayOfWeek: initGaussian(),
    };
    this.centroid = null;
    this.noveltyDetector = new NgramNoveltyDetector(this.config.ngramCacheSize);
    this.recentHashes.clear();
    this.totalEvaluated = 0;
    this.totalPromoted = 0;

    // Reset TF-IDF if active
    if (this.tfidf) {
      this.tfidf = new TfidfSurpriseDetector();
    }
  }

  /**
   * Initialize TF-IDF vocabulary from existing memory texts.
   * Call this once at daemon startup with all existing memories,
   * then call finalizeTfidf() to lock the vocabulary.
   */
  initTfidfFromTexts(texts: string[]): void {
    if (!this.tfidf) {
      this.tfidf = new TfidfSurpriseDetector();
    }
    for (const text of texts) {
      this.tfidf.addDocument(text);
    }
  }

  /** Finalize TF-IDF vocabulary and compute initial centroid. */
  finalizeTfidf(seedTexts?: string[]): void {
    this.tfidf?.finalize();
    // Auto-prime the centroid from seed texts so scores aren't all 0.5
    // (a zero-vector centroid makes every cosine distance = 0.5).
    if (this.tfidf && seedTexts && seedTexts.length > 0) {
      for (const text of seedTexts) {
        this.tfidf.updateCentroid(text);
      }
    }
  }

  /** Get raw TF-IDF detector for introspection. */
  getTfidf(): TfidfSurpriseDetector | null {
    return this.tfidf;
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private hashInteraction(interaction: Interaction): number {
    return djb2(
      interaction.prompt.slice(0, 200) +
        interaction.response.slice(0, 200) +
        interaction.source
    );
  }

  private pruneRecentHashes(): void {
    if (this.recentHashes.size > this.maxRecentHashes) {
      // Simple: clear half the set. This is a LRU approximation.
      const entries = [...this.recentHashes];
      this.recentHashes = new Set(entries.slice(entries.length / 2));
    }
  }
}

// ── Default Export (convenience for direct plugin loading) ─────────────────

export default createSpmCurator().definition;

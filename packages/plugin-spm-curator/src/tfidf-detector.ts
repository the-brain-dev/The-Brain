/**
 * TfidfSurpriseDetector — TF-IDF based surprise detection for SPM.
 *
 * Replaces the EMA-Gaussian composite score with cosine distance
 * from a TF-IDF centroid built from the user's own interaction history.
 *
 * "Surprising" = textually different from my normal interactions.
 *
 * Features:
 *   - Lightweight tokenization (word-boundary, 2+ char tokens)
 *   - IDF weighting (log-scaled document frequency)
 *   - L2-normalized sparse vectors
 *   - Cosine distance from running centroid (EMA-updated)
 *   - O(1) per-token scoring after vocabulary is built
 */

export interface TfidfConfig {
  /** Maximum vocabulary size */
  maxFeatures: number;
  /** Minimum token length */
  minTokenLength: number;
  /** EMA alpha for centroid updates (0–1, higher = faster adaptation) */
  alpha: number;
  /** Stop-words to exclude (lowercase) */
  stopWords: Set<string>;
}

const DEFAULT_STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "and", "but", "or", "not", "no", "if", "then", "else", "when",
  "this", "that", "these", "those", "it", "its", "i", "you", "he",
  "she", "we", "they", "me", "him", "her", "us", "them", "my", "your",
  "his", "our", "their", "mine", "yours", "hers", "ours", "theirs",
  "just", "also", "very", "really", "so", "such", "only", "now",
  "here", "there", "all", "some", "any", "each", "every", "both",
  "few", "more", "most", "other", "some", "one", "two", "about",
  "what", "which", "who", "whom", "how", "where", "when", "why",
  "prompt", "response", // From Claude harvester format
]);

const DEFAULT_CONFIG: TfidfConfig = {
  maxFeatures: 5000,
  minTokenLength: 2,
  alpha: 0.05,
  stopWords: DEFAULT_STOP_WORDS,
};

export class TfidfSurpriseDetector {
  public readonly config: TfidfConfig;

  /** Word → index mapping */
  private vocab: Map<string, number> = new Map();
  /** Document frequency per term */
  private df: Map<string, number> = new Map();
  /** Total documents seen for IDF computation */
  private docCount = 0;
  /** IDF weights (indexed by vocab position) */
  private idf: Float64Array = new Float64Array(0);
  /** Running centroid (EMA-updated) */
  private centroid: Float64Array = new Float64Array(0);
  /** Whether vocabulary has been finalized */
  private finalized = false;

  constructor(config: Partial<TfidfConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Tokenization ─────────────────────────────────────────────

  /**
   * Tokenize text into lowercase tokens.
   * Splits on non-alphanumeric boundaries, keeps tokens ≥ minTokenLength.
   */
  tokenize(text: string): string[] {
    const tokens: string[] = [];
    let current = "";

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") ||
          (ch >= "0" && ch <= "9") || ch === "_") {
        current += ch.toLowerCase();
      } else {
        if (current.length >= this.config.minTokenLength &&
            !this.config.stopWords.has(current)) {
          tokens.push(current);
        }
        current = "";
      }
    }

    // Flush last token
    if (current.length >= this.config.minTokenLength &&
        !this.config.stopWords.has(current)) {
      tokens.push(current);
    }

    return tokens;
  }

  // ── Vocabulary Building ──────────────────────────────────────

  /**
   * Add a document to the vocabulary (for initial training).
   * Call this for each existing memory before calling finalize().
   */
  addDocument(text: string): void {
    if (this.finalized) return;

    const tokens = this.tokenize(text);
    const unique = new Set(tokens);

    for (const tok of unique) {
      this.df.set(tok, (this.df.get(tok) || 0) + 1);
    }

    this.docCount++;
  }

  /**
   * Finalize vocabulary: keep top maxFeatures by DF, compute IDF, init centroid.
   * After this, no more vocabulary changes — only centroid updates via updateCentroid().
   */
  finalize(): void {
    if (this.finalized) return;

    // Sort by document frequency, keep top N
    const sorted = [...this.df.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.config.maxFeatures);

    this.vocab = new Map();
    for (let i = 0; i < sorted.length; i++) {
      this.vocab.set(sorted[i][0], i);
    }

    // Compute IDF
    this.idf = new Float64Array(this.vocab.size);
    for (const [word, idx] of this.vocab) {
      const df = this.df.get(word) || 1;
      this.idf[idx] = Math.log((this.docCount + 1) / (df + 1)) + 1;
    }

    // Initialize centroid to zero
    this.centroid = new Float64Array(this.vocab.size);

    this.finalized = true;
  }

  // ── Vectorization ────────────────────────────────────────────

  /**
   * Convert text to a sparse TF-IDF feature vector.
   * Returns L2-normalized dense array the size of the vocabulary.
   */
  vectorize(text: string): Float64Array {
    const tokens = this.tokenize(text);
    const vec = new Float64Array(this.vocab.size);

    if (tokens.length === 0) return vec;

    // Count term frequencies
    const tf = new Map<string, number>();
    for (const tok of tokens) {
      tf.set(tok, (tf.get(tok) || 0) + 1);
    }

    // Compute TF-IDF
    for (const [tok, count] of tf) {
      const idx = this.vocab.get(tok);
      if (idx !== undefined) {
        const tfNorm = count / tokens.length;
        vec[idx] = tfNorm * this.idf[idx];
      }
    }

    // L2 normalize
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) {
        vec[i] /= norm;
      }
    }

    return vec;
  }

  // ── Surprise Scoring ─────────────────────────────────────────

  /**
   * Compute surprise score for a text.
   * Returns cosine DISTANCE from the centroid (0 = identical, 1 = completely different).
   */
  score(text: string): number {
    if (!this.finalized || this.centroid.length === 0) {
      return 0.5; // No baseline — neutral
    }

    const vec = this.vectorize(text);

    // Cosine similarity
    let dot = 0;
    let normVec = 0;
    let normCentroid = 0;

    for (let i = 0; i < vec.length; i++) {
      dot += vec[i] * this.centroid[i];
      normVec += vec[i] * vec[i];
      normCentroid += this.centroid[i] * this.centroid[i];
    }

    normVec = Math.sqrt(normVec);
    normCentroid = Math.sqrt(normCentroid);

    if (normVec === 0 || normCentroid === 0) {
      // If the text has NO vocabulary overlap at all, it's maximally surprising
      return normVec === 0 ? 1.0 : 0.5;
    }

    const cosine = dot / (normVec * normCentroid);
    // Cosine distance: 1 - similarity, clamped to [0, 1]
    return Math.max(0, Math.min(1, 1 - cosine));
  }

  /**
   * Update the centroid with a new text.
   * Uses EMA: centroid ← alpha * vec + (1-alpha) * centroid
   */
  updateCentroid(text: string): void {
    if (!this.finalized) return;

    const vec = this.vectorize(text);
    const alpha = this.config.alpha;

    for (let i = 0; i < vec.length; i++) {
      this.centroid[i] = alpha * vec[i] + (1 - alpha) * this.centroid[i];
    }
  }

  // ── State Export/Import ──────────────────────────────────────

  /**
   * Export detector state for persistence.
   */
  exportState(): TfidfState {
    return {
      vocab: [...this.vocab.entries()],
      df: [...this.df.entries()],
      docCount: this.docCount,
      idf: Array.from(this.idf),
      centroid: Array.from(this.centroid),
      finalized: this.finalized,
    };
  }

  /**
   * Import detector state from persistence.
   */
  importState(state: TfidfState): void {
    this.vocab = new Map(state.vocab);
    this.df = new Map(state.df);
    this.docCount = state.docCount;
    this.idf = new Float64Array(state.idf);
    this.centroid = new Float64Array(state.centroid);
    this.finalized = state.finalized;
  }

  // ── Stats ────────────────────────────────────────────────────

  getStats(): TfidfStats {
    return {
      vocabSize: this.vocab.size,
      docCount: this.docCount,
      finalized: this.finalized,
      centroidNorm: Math.sqrt(this.centroid.reduce((s, v) => s + v * v, 0)),
    };
  }
}

export interface TfidfState {
  vocab: [string, number][];
  df: [string, number][];
  docCount: number;
  idf: number[];
  centroid: number[];
  finalized: boolean;
}

export interface TfidfStats {
  vocabSize: number;
  docCount: number;
  finalized: boolean;
  centroidNorm: number;
}

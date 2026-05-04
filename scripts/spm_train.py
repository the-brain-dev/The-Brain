#!/usr/bin/env python3
"""
SPM Calibration Pipeline — trains the SPM Gaussian model on CodeChat-V2.0.

Loads real developer-LLM conversations, computes feature vectors (scalar +
embedding + n-gram novelty), and fits Gaussian parameters (mu, sigma^2) for
each feature dimension. Outputs a calibrated SPM config.

Usage:
    python scripts/spm_train.py                      # default: 10K conversations
    python scripts/spm_train.py --n 50000            # 50K conversations
    python scripts/spm_train.py --model all-MiniLM-L6-v2  # specific embedding model
"""

import argparse
import json
import os
import sys
import time
import hashlib
from collections import defaultdict
from pathlib import Path
from typing import Any

import numpy as np
from datasets import load_dataset


# ── Configuration ────────────────────────────────────────────────

DEFAULT_N_SAMPLES = 10_000
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"  # 384D, fast, local
EMBEDDING_DIM = 384
NGRAM_N = 4
ALPHA = 0.05  # EMA decay factor (same as SPM default)
OUTPUT_PATH = Path.home() / ".my-brain" / "spm-calibrated.json"

# Scalar features extracted per interaction:
#   [0] prompt_length (chars)
#   [1] response_length (chars)
#   [2] code_snippet_count
#   [3] turn_index (normalized 0-1)
#   [4] has_error (binary)
SCALAR_DIM = 5


# ── Data Loading ──────────────────────────────────────────────────

def load_codechat(n: int = DEFAULT_N_SAMPLES):
    """Load n conversations from CodeChat-V2.0."""
    print(f"📥 Loading CodeChat-V2.0 dataset (n={n})...")
    ds = load_dataset("Suzhen/CodeChat-V2.0", split="train", streaming=True)
    
    conversations = []
    for i, row in enumerate(ds):
        if i >= n:
            break
        conversations.append(row)
        if (i + 1) % 2000 == 0:
            print(f"   {i + 1}/{n} loaded...")
    
    print(f"   ✓ {len(conversations)} conversations loaded")
    return conversations


# ── Feature Extraction ────────────────────────────────────────────

def extract_turns(conversation_row: dict) -> list[dict]:
    """
    Extract user→assistant interaction pairs from a conversation.
    Returns list of {prompt, response, turn_index, total_turns}.
    """
    conv = conversation_row.get("conversation", [])
    turns = []
    
    for i in range(len(conv) - 1):
        if conv[i].get("role") == "user" and conv[i+1].get("role") == "assistant":
            turns.append({
                "prompt": conv[i].get("content", ""),
                "response": conv[i+1].get("content", ""),
                "turn_index": i,
                "total_turns": len(conv),
            })
    
    return turns


def extract_scalar_features(turn: dict) -> np.ndarray:
    """Extract 5D scalar feature vector from a turn."""
    prompt = turn["prompt"]
    response = turn["response"]
    total = max(turn["total_turns"], 1)
    
    # Count code snippets (``` blocks)
    code_count = prompt.count("```") // 2 + response.count("```") // 2
    
    # Detect errors (common error patterns)
    has_error = int(
        "error" in response.lower()[:200]
        or "traceback" in response.lower()[:200]
        or "exception" in response.lower()[:200]
    )
    
    return np.array([
        len(prompt),                          # prompt length
        len(response),                        # response length  
        min(code_count, 20),                  # code snippet count (capped)
        turn["turn_index"] / total,           # normalized turn position
        has_error,                            # error indicator
    ], dtype=np.float32)


def compute_embeddings(texts: list[str], model) -> np.ndarray:
    """Batch-compute embeddings for a list of texts."""
    if not texts:
        return np.zeros((0, EMBEDDING_DIM), dtype=np.float32)
    
    # Batch to avoid OOM
    batch_size = 256
    all_embeddings = []
    
    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        embeddings = model.encode(batch, show_progress_bar=False, normalize_embeddings=True)
        all_embeddings.append(embeddings)
    
    return np.concatenate(all_embeddings, axis=0)


# ── N-Gram Novelty ────────────────────────────────────────────────

class NgramCache:
    """Tracks known n-grams to compute novelty ratio."""
    
    def __init__(self, n: int = NGRAM_N, max_size: int = 50_000):
        self.n = n
        self.known: set[str] = set()
        self.max_size = max_size
    
    def add(self, text: str):
        """Add n-grams from text to the known set."""
        tokens = text.lower().split()
        for i in range(len(tokens) - self.n + 1):
            ngram = " ".join(tokens[i : i + self.n])
            self.known.add(ngram)
    
    def novelty_ratio(self, text: str) -> float:
        """Fraction of n-grams in text that are NOT in the known set."""
        tokens = text.lower().split()
        if len(tokens) < self.n:
            return 0.0
        
        total = len(tokens) - self.n + 1
        novel = sum(
            1 for i in range(total)
            if " ".join(tokens[i : i + self.n]) not in self.known
        )
        
        return novel / total if total > 0 else 0.0


# ── Gaussian Model ────────────────────────────────────────────────

class RunningGaussian:
    """
    Maintains running mean (mu) and variance (sigma^2) via EMA.
    Same algorithm as SPM curator's internal model.
    """
    
    def __init__(self, dim: int, alpha: float = ALPHA):
        self.dim = dim
        self.alpha = alpha
        self.mu = np.zeros(dim, dtype=np.float64)
        self.sigma2 = np.ones(dim, dtype=np.float64)  # Start with unit variance
        self.n = 0
    
    def update(self, x: np.ndarray):
        """Update running statistics with a new feature vector."""
        x = np.asarray(x, dtype=np.float64).flatten()
        if x.shape[0] != self.dim:
            raise ValueError(f"Expected dim={self.dim}, got {x.shape[0]}")
        
        self.n += 1
        
        # EMA update: mu_new = alpha * x + (1-alpha) * mu_old
        self.mu = self.alpha * x + (1.0 - self.alpha) * self.mu
        
        # EMA update for variance: sigma2_new = alpha * (x-mu)^2 + (1-alpha) * sigma2_old
        delta = x - self.mu
        self.sigma2 = self.alpha * (delta ** 2) + (1.0 - self.alpha) * self.sigma2
    
    def z_score(self, x: np.ndarray) -> np.ndarray:
        """Compute per-dimension z-scores."""
        x = np.asarray(x, dtype=np.float64).flatten()
        sigma = np.sqrt(np.maximum(self.sigma2, 1e-8))
        return (x - self.mu) / sigma
    
    def to_dict(self) -> dict:
        return {
            "dim": self.dim,
            "alpha": self.alpha,
            "mu": self.mu.tolist(),
            "sigma2": self.sigma2.tolist(),
            "n_samples": self.n,
        }


# ── Main Pipeline ─────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Calibrate SPM model on CodeChat-V2.0")
    parser.add_argument("--n", type=int, default=DEFAULT_N_SAMPLES, help="Number of conversations")
    parser.add_argument("--model", type=str, default=EMBEDDING_MODEL, help="Embedding model")
    parser.add_argument("--output", type=str, default=str(OUTPUT_PATH), help="Output JSON path")
    parser.add_argument("--no-embeddings", action="store_true", help="Skip embedding computation")
    args = parser.parse_args()
    
    # ── 1. Load data ──────────────────────────────────────────
    conversations = load_codechat(args.n)
    
    # ── 2. Extract turns ──────────────────────────────────────
    print("\n🔧 Extracting interaction turns...")
    all_turns = []
    for conv in conversations:
        turns = extract_turns(conv)
        all_turns.extend(turns)
    
    print(f"   ✓ {len(all_turns)} user→assistant pairs extracted")
    
    # ── 3. Compute scalar features ────────────────────────────
    print("\n📊 Computing scalar features...")
    scalar_vectors = np.array([extract_scalar_features(t) for t in all_turns], dtype=np.float32)
    print(f"   ✓ Shape: {scalar_vectors.shape}")
    
    # ── 4. Compute embeddings ─────────────────────────────────
    if not args.no_embeddings:
        print(f"\n🧠 Loading embedding model: {args.model}...")
        from sentence_transformers import SentenceTransformer
        embedder = SentenceTransformer(args.model)
        
        # Embed the combined prompt+response (first 512 chars to keep it fast)
        texts = [
            (t["prompt"] + " " + t["response"])[:512]
            for t in all_turns
        ]
        
        print(f"   Computing embeddings for {len(texts)} texts...")
        t0 = time.time()
        embeddings = compute_embeddings(texts, embedder)
        elapsed = time.time() - t0
        print(f"   ✓ Shape: {embeddings.shape} ({elapsed:.1f}s, {len(texts)/elapsed:.0f} texts/s)")
    else:
        # Use zero embeddings (fallback)
        embeddings = np.zeros((len(all_turns), EMBEDDING_DIM), dtype=np.float32)
        print("   ⚠️  Embeddings skipped — using zeros")
    
    # ── 5. Compute n-gram novelty ─────────────────────────────
    print("\n📝 Building n-gram cache and computing novelty...")
    ngram_cache = NgramCache(n=NGRAM_N)
    
    novelty_scores = np.zeros(len(all_turns), dtype=np.float32)
    t0 = time.time()
    
    for i, turn in enumerate(all_turns):
        text = turn["prompt"] + " " + turn["response"]
        novelty_scores[i] = ngram_cache.novelty_ratio(text)
        ngram_cache.add(text)
        
        if (i + 1) % 5000 == 0:
            print(f"   {i + 1}/{len(all_turns)} processed...")
    
    elapsed = time.time() - t0
    print(f"   ✓ Cache size: {len(ngram_cache.known):,} n-grams ({elapsed:.1f}s)")
    print(f"   ✓ Novelty score range: [{novelty_scores.min():.3f}, {novelty_scores.max():.3f}]")
    
    # ── 6. Fit Gaussian models ────────────────────────────────
    print("\n📈 Fitting Gaussian models...")
    
    scalar_gaussian = RunningGaussian(dim=SCALAR_DIM, alpha=ALPHA)
    embedding_gaussian = RunningGaussian(dim=EMBEDDING_DIM, alpha=ALPHA)
    novelty_gaussian = RunningGaussian(dim=1, alpha=ALPHA)
    
    for i in range(len(all_turns)):
        scalar_gaussian.update(scalar_vectors[i])
        embedding_gaussian.update(embeddings[i])
        novelty_gaussian.update(np.array([novelty_scores[i]]))
    
    # ── 7. Compute sample surprise scores ─────────────────────
    print("\n🎯 Computing sample surprise scores...")
    
    # Weights (same as SPM defaults)
    W_SCALAR = 0.35
    W_EMBEDDING = 0.40
    W_NOVELTY = 0.25
    
    surprise_scores = []
    for i in range(len(all_turns)):
        z_scalar = np.mean(np.abs(scalar_gaussian.z_score(scalar_vectors[i])))
        z_embedding = np.mean(np.abs(embedding_gaussian.z_score(embeddings[i])))
        z_novelty = np.mean(np.abs(novelty_gaussian.z_score(np.array([novelty_scores[i]]))))
        
        # Composite score: weighted average of z-scores
        # Normalize to [0, 1] via tanh
        composite = W_SCALAR * z_scalar + W_EMBEDDING * z_embedding + W_NOVELTY * z_novelty
        normalized = np.tanh(composite / 3.0)  # scale to [0,1]
        surprise_scores.append(float(normalized))
    
    scores = np.array(surprise_scores)
    
    # ── 8. Analyze distribution ───────────────────────────────
    print("\n" + "=" * 60)
    print("  CALIBRATION RESULTS")
    print("=" * 60)
    
    percentiles = [10, 25, 50, 75, 90, 95, 99]
    print(f"\n  Samples: {len(scores):,}")
    print(f"  Score range: [{scores.min():.4f}, {scores.max():.4f}]")
    print(f"  Mean: {scores.mean():.4f}")
    print(f"  Std:  {scores.std():.4f}")
    print(f"  Spread: {scores.max() - scores.min():.4f}")
    
    print(f"\n  Percentiles:")
    for p in percentiles:
        print(f"    P{p:2d}: {np.percentile(scores, p):.4f}")
    
    # Pass rates at different thresholds
    print(f"\n  Pass rates at thresholds:")
    for t in [0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50]:
        rate = (scores >= t).mean() * 100
        bar = "█" * int(rate / 2)
        print(f"    ≥{t:.2f}: {rate:5.1f}% {bar}")
    
    # ── 9. Recommend threshold ────────────────────────────────
    # Target: promote ~30% of interactions (balance between recall and precision)
    target_rate = 0.30
    recommended_threshold = float(np.percentile(scores, (1 - target_rate) * 100))
    
    print(f"\n  📊 Recommended threshold: {recommended_threshold:.3f}")
    print(f"     (promotes ~{target_rate*100:.0f}% of interactions)")
    
    # ── 10. Save calibrated config ────────────────────────────
    output = {
        "meta": {
            "dataset": "Suzhen/CodeChat-V2.0",
            "n_samples": len(all_turns),
            "n_conversations": len(conversations),
            "embedding_model": args.model,
            "embedding_dim": EMBEDDING_DIM,
            "scalar_dim": SCALAR_DIM,
            "ngram_n": NGRAM_N,
            "calibrated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
        "gaussians": {
            "scalar": scalar_gaussian.to_dict(),
            "embedding": embedding_gaussian.to_dict(),
            "novelty": novelty_gaussian.to_dict(),
        },
        "weights": {
            "scalarWeight": W_SCALAR,
            "embeddingWeight": W_EMBEDDING,
            "noveltyWeight": W_NOVELTY,
        },
        "recommended_threshold": recommended_threshold,
        "distribution": {
            "mean": float(scores.mean()),
            "std": float(scores.std()),
            "min": float(scores.min()),
            "max": float(scores.max()),
            "p10": float(np.percentile(scores, 10)),
            "p25": float(np.percentile(scores, 25)),
            "p50": float(np.percentile(scores, 50)),
            "p75": float(np.percentile(scores, 75)),
            "p90": float(np.percentile(scores, 90)),
            "p95": float(np.percentile(scores, 95)),
        },
    }
    
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with open(args.output, "w") as f:
        json.dump(output, f, indent=2)
    
    print(f"\n  ✓ Calibrated config saved to: {args.output}")
    print(f"\n  To apply: bun run scripts/spm-apply-calibration.ts")


if __name__ == "__main__":
    main()

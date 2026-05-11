#!/usr/bin/env python3
"""
SPM Calibration v5 — Self-Calibrating TF-IDF
Uses the user's OWN data as the baseline corpus.
"Surprising" = different from my normal interactions (personalized).

Approach:
  1. Take all 622 memories as training corpus → baseline TF-IDF
  2. Score each memory against the baseline → personalized surprise
  3. Compare spread with current SPM
"""

import re, time, json, os, sqlite3
from pathlib import Path
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer

HOME = Path.home()
DB = HOME / ".the-brain" / "global" / "brain.db"

conn = sqlite3.connect(str(DB))

# Load ALL memories (not just SELECTION)
rows = conn.execute("""
    SELECT content, layer, surprise_score 
    FROM memories 
    WHERE content IS NOT NULL AND content != ''
    ORDER BY timestamp
""").fetchall()
conn.close()

print(f"Loaded {len(rows)} memories")

# Clean content — strip XML, keep text
def clean(text):
    c = re.sub(r"<[^>]+>", " ", text or "")
    c = re.sub(r'\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*Z?', "DATETIME", c)
    c = re.sub(r'/Users/\S+', "PATH", c)
    c = re.sub(r'\s+', " ", c).strip()
    return c

texts = [clean(r[0]) for r in rows]
layers = [r[1] for r in rows]
old_scores = [r[2] for r in rows]

# Build TF-IDF on ALL data (self-calibrating)
print(f"Building TF-IDF on {len(texts)} self-texts...")
vec = TfidfVectorizer(
    max_features=5000,
    stop_words="english",
    ngram_range=(1, 3),  # up to trigrams for better pattern matching
    sublinear_tf=True,
    max_df=0.8,  # ignore terms appearing in >80% docs
    min_df=2,    # need at least 2 occurrences
)
matrix = vec.fit_transform(texts)
centroid = np.asarray(matrix.mean(axis=0)).flatten()
print(f"Vocab: {len(vec.get_feature_names_out())} terms")

# Score each text against the centroid
scores = np.zeros(len(texts))
for i in range(len(texts)):
    v = np.asarray(matrix[i].todense()).flatten()
    nv, nc = np.linalg.norm(v), np.linalg.norm(centroid)
    if nv > 0 and nc > 0:
        cosine = np.dot(v, centroid) / (nv * nc)
        # Cosine DISTANCE from centroid = surprise
        scores[i] = 1.0 - max(0.0, min(1.0, cosine))
    else:
        scores[i] = 0.5

spread = scores.max() - scores.min()

# ── Results ─────────────────────────────────────────────────────
print(f"\n{'='*60}")
print(f"  SPM Self-Calibration Results")
print(f"{'='*60}")
print(f"  Samples: {len(scores)}")
print(f"  Range:   [{scores.min():.4f}, {scores.max():.4f}]")
print(f"  Spread:  {spread:.4f}")
print(f"  Mean:    {scores.mean():.4f}  Std: {scores.std():.4f}")

for p in [10, 25, 50, 75, 90, 95]:
    print(f"  P{p:2d}:     {np.percentile(scores, p):.4f}")

# Compare by layer
print(f"\n  By layer:")
for layer in ["instant", "selection", "deep"]:
    mask = [l == layer for l in layers]
    if sum(mask) > 0:
        ls = scores[mask]
        print(f"  {layer:12s}: n={len(ls):3d}  mean={ls.mean():.4f}  spread={ls.max()-ls.min():.4f}")

# Compare old vs new scores
old_valid = [(o, s) for o, s in zip(old_scores, scores) if o is not None]
if old_valid:
    old = np.array([x[0] for x in old_valid])
    new = np.array([x[1] for x in old_valid])
    correlation = np.corrcoef(old, new)[0, 1]
    print(f"\n  Old vs new SPM correlation: {correlation:.3f}")

# Pass rates
print(f"\n  Pass rates (new model):")
for t in [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90]:
    rate = (scores >= t).mean() * 100
    bar = "\u2588" * int(rate / 2)
    print(f"  \u2265{t:.2f}: {rate:5.1f}% {bar}")

# Examples
order = np.argsort(scores)[::-1]
print(f"\n  \U0001f534 Most surprising (top 5):")
for i in order[:5]:
    clean_text = re.sub(r"\s+", " ", texts[i])[:120]
    layer = layers[i]
    print(f"  [{layer}] s={scores[i]:.3f} | {clean_text}")

print(f"\n  \U0001f7e2 Most routine (bottom 5):")
for i in order[-5:]:
    clean_text = re.sub(r"\s+", " ", texts[i])[:120]
    layer = layers[i]
    print(f"  [{layer}] s={scores[i]:.3f} | {clean_text}")

# Comparison
improvement = (spread / 0.265 - 1) * 100
print(f"\n  \U0001f4ca Comparison:")
print(f"  Current SPM spread:  0.265")
print(f"  Self-TF-IDF spread:  {spread:.4f} ({improvement:+.0f}%)")
print(f"  Current range:       [0.263, 0.527]")
print(f"  Self-TF-IDF range:   [{scores.min():.4f}, {scores.max():.4f}]")

# Recommendation
rec = float(np.percentile(scores, 70))  # 30% pass rate
print(f"\n  \U0001f4ca Recommended threshold: {rec:.3f} (promotes ~30%)")

# Save
output = {
    "model": "self-tfidf",
    "n_samples": len(texts),
    "vocab_size": len(vec.get_feature_names_out()),
    "spread": float(spread),
    "improvement_pct": round(improvement, 1),
    "recommended_threshold": rec,
    "distribution": {
        "mean": float(scores.mean()),
        "std": float(scores.std()),
        "p50": float(np.percentile(scores, 50)),
        "p75": float(np.percentile(scores, 75)),
        "p90": float(np.percentile(scores, 90)),
    },
    "calibrated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
}
out_path = HOME / ".the-brain" / "spm-self.json"
os.makedirs(out_path.parent, exist_ok=True)
with open(out_path, "w") as f:
    json.dump(output, f, indent=2)
print(f"\n\u2713 Saved to {out_path}")

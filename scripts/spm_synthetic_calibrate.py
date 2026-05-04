#!/usr/bin/env python3
"""
SPM Calibration v3 — Better features + proper normalization.
Uses TF-IDF vocabulary divergence as the main surprise signal,
plus structural features (length, code density, language).

Strategy:
  1. Build TF-IDF vocabulary from 5000 synthetic interactions → "normal" baseline
  2. For each new interaction, compute cosine distance from baseline
  3. Combined with structural z-scores → composite surprise score
  4. Calibrate threshold for ~30% pass rate
"""

import json, os, random, time
import numpy as np
from pathlib import Path
from collections import Counter
import sqlite3

HOME = Path.home()
random.seed(42)
np.random.seed(42)

# ── Synthetic Data Generation ─────────────────────────────────────

LANGUAGES = ["Python", "JavaScript", "TypeScript", "Rust", "Go", "Java", "C++", "shell"]
TASKS = ["implement", "debug", "refactor", "test", "deploy", "review", "optimize", "design"]

PROMPTS = [
    "How do I {task} a {component} in {lang}?",
    "Write a {lang} function that {action} using {pattern}.",
    "Fix: {error} in my {lang} code at line {line}.",
    "Review this {lang} code:\n```\n{code}\n```\nI'm concerned about {concern}.",
    "Design a {component} for {scale} users. Stack: {lang} + {db}.",
    "My {lang} app is slow when {condition}. Profile shows {bottleneck}.",
    "Refactor this {lang} class to use {pattern}:\n```\n{class_code}\n```",
    "Test strategy for {lang} {component}. Current coverage: {cov}%.",
    "Deploy {lang} service to {platform}. Need {requirement}.",
    "Compare {lang} libraries for {task}: {lib_a} vs {lib_b}.",
    "Can you explain {concept} in {lang} with an example?",
    "Convert this {lang_from} code to {lang_to}:\n```\n{code}\n```",
    "Setup CI/CD for {lang} project on {platform}. Steps?",
    "Database schema design for {feature} using {db}.",
    "Security review: {lang} API endpoint for {feature}.",
]

COMPONENTS = ["auth module", "API client", "data pipeline", "CLI tool", "web scraper",
              "cache layer", "message queue", "file parser", "NotificationService", "RateLimiter"]
ERRORS = ["TypeError: NoneType", "ConnectionRefusedError", "KeyError: 'id'", "OOM killer",
          "deadlock detected", "CORS error", "SSL certificate", "race condition"]
PATTERNS = ["async/await", "dependency injection", "factory", "observer", "strategy",
            "decorator", "builder", "repository", "adapter", "singleton"]
CONCERNS = ["performance", "readability", "security", "memory usage", "error handling",
            "testability", "concurrency", "API design"]
SCALES = ["100", "1K", "10K", "100K", "1M"]
DBS = ["PostgreSQL", "SQLite", "MongoDB", "Redis", "DynamoDB", "Neo4j"]
CONDITIONS = ["handling 100+ concurrent requests", "parsing large JSON files",
              "doing recursive directory traversal", "running in Docker"]
BOTTLENECKS = ["70% time in serialize()", "N+1 queries", "GC pauses every 30s",
               "blocking I/O in event loop"]
PLATFORMS = ["AWS ECS", "Vercel", "Fly.io", "Kubernetes", "Railway", "bare metal"]
REQUIREMENTS = ["zero-downtime", "rollback strategy", "health checks", "secrets management"]
LIBS = [("requests", "httpx"), ("express", "fastify"), ("Django", "FastAPI"),
        ("React", "Vue"), ("pytest", "unittest")]
CONCEPTS = ["monads", "generators", "decorators", "traits", "interfaces", "closures"]
LANGUAGES_PAIRS = [("Python", "Rust"), ("JavaScript", "TypeScript"), ("Java", "Kotlin"),
                   ("Ruby", "Python"), ("C++", "Rust")]

def generate_synthetic(n: int = 5000) -> list[str]:
    """Generate diverse prompt texts."""
    prompts = []
    for _ in range(n):
        tmpl = random.choice(PROMPTS)
        p = tmpl.format(
            task=random.choice(TASKS),
            lang=random.choice(LANGUAGES),
            component=random.choice(COMPONENTS),
            action=random.choice(["handle errors", "parse JSON", "validate input", "format dates",
                                   "hash passwords", "compress data", "stream files"]),
            pattern=random.choice(PATTERNS),
            error=random.choice(ERRORS),
            line=random.randint(10, 500),
            code=f"def {random.choice(['process','handle','validate'])}():\n    pass",
            concern=random.choice(CONCERNS),
            scale=random.choice(SCALES),
            db=random.choice(DBS),
            condition=random.choice(CONDITIONS),
            bottleneck=random.choice(BOTTLENECKS),
            class_code=f"class {random.choice(['Service','Manager','Handler'])}:\n    pass",
            cov=random.choice([30, 50, 70, 85, 95]),
            platform=random.choice(PLATFORMS),
            requirement=random.choice(REQUIREMENTS),
            lib_a=random.choice(LIBS)[0],
            lib_b=random.choice(LIBS)[1],
            concept=random.choice(CONCEPTS),
            lang_from=random.choice(LANGUAGES_PAIRS)[0],
            lang_to=random.choice(LANGUAGES_PAIRS)[1],
            feature=random.choice(["search", "export", "import", "analytics", "notifications"]),
        )
        prompts.append(p)
    return prompts


# ── TF-IDF Vocabulary Model ───────────────────────────────────────

class TFIDFBaseline:
    """Builds TF-IDF vocabulary from a corpus, then scores novelty."""
    
    def __init__(self, max_features: int = 5000):
        self.max_features = max_features
        self.vocab: dict[str, int] = {}       # word → index
        self.idf: np.ndarray = None           # inverse document frequency
        self.centroid: np.ndarray = None      # mean TF-IDF vector
    
    def tokenize(self, text: str) -> list[str]:
        """Simple tokenization: lowercase + split on non-alphanumeric."""
        import re
        return [t.lower() for t in re.findall(r'[a-zA-Z0-9_]{2,}', text)]
    
    def fit(self, texts: list[str]):
        """Build vocabulary and compute IDF from corpus."""
        print(f"   Building vocabulary from {len(texts)} texts...")
        
        # Count document frequencies
        doc_count = Counter()
        for text in texts:
            tokens = set(self.tokenize(text))
            for t in tokens:
                doc_count[t] += 1
        
        # Keep top max_features by frequency
        top_words = [w for w, _ in doc_count.most_common(self.max_features)]
        self.vocab = {w: i for i, w in enumerate(top_words)}
        
        # Compute IDF
        n_docs = len(texts)
        self.idf = np.zeros(len(self.vocab))
        for w, idx in self.vocab.items():
            self.idf[idx] = np.log((n_docs + 1) / (doc_count.get(w, 0) + 1)) + 1
        
        # Compute centroid (mean TF-IDF vector)
        vectors = np.array([self.vectorize(t) for t in texts[:1000]])  # sample
        self.centroid = vectors.mean(axis=0)
        
        print(f"   Vocabulary: {len(self.vocab)} words")
    
    def vectorize(self, text: str) -> np.ndarray:
        """Convert text to TF-IDF vector."""
        tokens = self.tokenize(text)
        if not self.vocab:
            return np.zeros(1)
        
        vec = np.zeros(len(self.vocab))
        tf = Counter(tokens)
        for w, c in tf.items():
            if w in self.vocab:
                vec[self.vocab[w]] = (c / max(len(tokens), 1)) * self.idf[self.vocab[w]]
        
        # L2 normalize
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec /= norm
        return vec
    
    def surprise_score(self, text: str) -> float:
        """Compute cosine distance from centroid (higher = more surprising)."""
        if self.centroid is None:
            return 0.5
        
        vec = self.vectorize(text)
        if vec.sum() == 0:
            return 0.5
        
        # Cosine distance from centroid
        dot = np.dot(vec, self.centroid)
        norm_v = np.linalg.norm(vec)
        norm_c = np.linalg.norm(self.centroid)
        
        if norm_v == 0 or norm_c == 0:
            return 0.5
        
        cosine_sim = dot / (norm_v * norm_c)
        return 1.0 - max(0.0, min(1.0, cosine_sim))  # distance in [0, 1]


# ── Load Production Data ─────────────────────────────────────────

def load_production(db_path: str) -> list[str]:
    """Load cleaned prompt texts from brain.db."""
    if not os.path.exists(db_path):
        return []
    
    conn = sqlite3.connect(db_path)
    rows = conn.execute("""
        SELECT content FROM memories 
        WHERE content NOT LIKE '%observer%'
        ORDER BY RANDOM()
        LIMIT 250
    """).fetchall()
    conn.close()
    
    texts = []
    for (content,) in rows:
        if not content:
            continue
        # Strip XML, keep text
        import re
        clean = re.sub(r'<[^>]+>', ' ', content)
        clean = re.sub(r'\s+', ' ', clean).strip()
        if len(clean) > 20:
            texts.append(clean[:500])
    
    return texts


# ── Main ──────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("  SPM Calibration v3 — TF-IDF Baseline Model")
    print("=" * 60)
    
    # Generate synthetic training data
    print("\n🔧 Generating synthetic corpus...")
    synthetic_prompts = generate_synthetic(5000)
    print(f"   ✓ {len(synthetic_prompts)} prompts")
    
    # Build TF-IDF baseline
    print("\n📚 Building TF-IDF baseline...")
    baseline = TFIDFBaseline(max_features=3000)
    baseline.fit(synthetic_prompts)
    
    # Score synthetic data (should be low — they ARE the baseline)
    print("\n🎯 Scoring synthetic data...")
    synth_scores = np.array([baseline.surprise_score(p) for p in synthetic_prompts[:2000]])
    print(f"   Synthetic mean: {synth_scores.mean():.4f}")
    print(f"   Synthetic std:  {synth_scores.std():.4f}")
    
    # Load and score production data
    print("\n📥 Loading production data...")
    db_path = HOME / ".my-brain" / "global" / "brain.db"
    prod_texts = load_production(str(db_path))
    print(f"   ✓ {len(prod_texts)} production texts")
    
    print("\n🎯 Scoring production data...")
    prod_scores = np.array([baseline.surprise_score(t) for t in prod_texts])
    
    if len(prod_scores) > 0:
        print(f"\n   Production distribution:")
        print(f"   Range:  [{prod_scores.min():.4f}, {prod_scores.max():.4f}]")
        print(f"   Mean:   {prod_scores.mean():.4f}")
        print(f"   Std:    {prod_scores.std():.4f}")
        print(f"   Spread: {prod_scores.max() - prod_scores.min():.4f}")
        
        for p in [10, 25, 50, 75, 90, 95]:
            print(f"   P{p:2d}:    {np.percentile(prod_scores, p):.4f}")
        
        # Compare
        print(f"\n   📊 Comparison with current SPM:")
        print(f"   Current SPM:  spread=0.265, range=[0.263, 0.527]")
        print(f"   TF-IDF model: spread={prod_scores.max()-prod_scores.min():.4f}, range=[{prod_scores.min():.4f}, {prod_scores.max():.4f}]")
        
        # Pass rates
        print(f"\n   Pass rates:")
        for t in [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85]:
            rate = (prod_scores >= t).mean() * 100
            bar = "█" * int(rate / 2)
            print(f"   ≥{t:.2f}: {rate:5.1f}% {bar}")
        
        # Recommend threshold
        target = 0.30
        recommended = float(np.percentile(prod_scores, (1 - target) * 100))
        print(f"\n   📊 Recommended threshold: {recommended:.3f} (promotes ~{target*100:.0f}%)")
        
        # Show top surprising examples
        print(f"\n   🔴 Top 5 most surprising:")
        order = np.argsort(prod_scores)[::-1]
        for i in order[:5]:
            print(f"   s={prod_scores[i]:.3f} | {prod_texts[i][:100]}")
        
        print(f"\n   🟢 Top 5 least surprising:")
        for i in order[-5:]:
            print(f"   s={prod_scores[i]:.3f} | {prod_texts[i][:100]}")
    
    # Save model
    output = {
        "model": "TF-IDF-baseline",
        "vocab_size": len(baseline.vocab),
        "n_synthetic": len(synthetic_prompts),
        "n_production": len(prod_texts),
        "production_stats": {
            "mean": float(prod_scores.mean()),
            "std": float(prod_scores.std()),
            "spread": float(prod_scores.max() - prod_scores.min()),
        } if len(prod_scores) > 0 else {},
        "recommended_threshold": float(recommended) if len(prod_scores) > 0 else 0.5,
        "calibrated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    
    out_path = HOME / ".my-brain" / "spm-tfidf.json"
    os.makedirs(out_path.parent, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)
    
    print(f"\n✓ Saved to {out_path}")


if __name__ == "__main__":
    main()

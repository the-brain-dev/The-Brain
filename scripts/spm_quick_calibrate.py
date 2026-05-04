#!/usr/bin/env python3
"""
Quick SPM calibration on WildChat — general GPT-4 conversations.
WildChat is already partly cached. Smaller, faster to download.
"""
import json, os, sys, time
import numpy as np
from pathlib import Path
from datasets import load_dataset

N = 1000  # Start small for smoke test
HOME = Path.home()

print(f"📥 Loading WildChat (n={N})...")
ds = load_dataset("allenai/WildChat", split=f"train[:{N}]")
print(f"✓ {len(ds)} conversations")

# Extract user→assistant pairs
turns = []
for row in ds:
    conv = row.get("conversation", [])
    for i in range(len(conv) - 1):
        if conv[i].get("role") == "user" and conv[i+1].get("role") == "assistant":
            turns.append({
                "prompt": conv[i].get("content", ""),
                "response": conv[i+1].get("content", ""),
                "turn": i,
                "total": len(conv),
            })

print(f"✓ {len(turns)} user→assistant pairs\n")

# Simple scalar features
features = np.array([
    [
        len(t["prompt"]),
        len(t["response"]),
        t["prompt"].count("```") // 2 + t["response"].count("```") // 2,
        t["turn"] / max(t["total"], 1),
        int("error" in t["response"][:200].lower()),
    ]
    for t in turns
], dtype=np.float64)

print(f"Features shape: {features.shape}")
print(f"  prompt_len: [{features[:,0].min():.0f}, {features[:,0].max():.0f}]")
print(f"  response_len: [{features[:,1].min():.0f}, {features[:,1].max():.0f}]")
print(f"  code_snippets: [{features[:,2].min():.0f}, {features[:,2].max():.0f}]")

# EMA Gaussian fit
alpha = 0.05
mu = np.zeros(5)
sigma2 = np.ones(5)

for i, f in enumerate(features):
    mu = alpha * f + (1 - alpha) * mu
    delta = f - mu
    sigma2 = alpha * (delta ** 2) + (1 - alpha) * sigma2

print(f"\nGaussian params (after {len(features)} samples):")
for i, name in enumerate(["prompt_len", "resp_len", "code_snip", "turn_pos", "has_err"]):
    print(f"  {name}: mu={mu[i]:.1f}, sigma={np.sqrt(sigma2[i]):.1f}")

# Compute z-scores → surprise
z_scores = np.abs((features - mu) / np.sqrt(np.maximum(sigma2, 1e-8)))
surprise = np.tanh(np.mean(z_scores, axis=1) / 3.0)

print(f"\n🎯 Surprise score distribution:")
print(f"  Range: [{surprise.min():.4f}, {surprise.max():.4f}]")
print(f"  Mean:  {surprise.mean():.4f}")
print(f"  Std:   {surprise.std():.4f}")
print(f"  Spread: {surprise.max() - surprise.min():.4f}")

for p in [10, 25, 50, 75, 90, 95]:
    print(f"  P{p:2d}: {np.percentile(surprise, p):.4f}")

print(f"\nPass rates:")
for t in [0.20, 0.25, 0.30, 0.35, 0.40]:
    rate = (surprise >= t).mean() * 100
    print(f"  ≥{t:.2f}: {rate:5.1f}% {'█' * int(rate/2)}")

# Compare with current SPM performance (on Claude Code data)
print(f"\n📊 Comparison with current SPM (Claude Code data):")
print(f"  Current SPM spread:    0.265 (n=308)")
print(f"  WildChat-calibrated:   {surprise.max() - surprise.min():.4f} (n={len(surprise)})")
improvement = (surprise.max() - surprise.min()) / 0.265 * 100 - 100
print(f"  {'📈' if improvement > 0 else '📉'} Spread change: {improvement:+.0f}%")

# Save compact model
output = {
    "calibrated_on": "allenai/WildChat",
    "n_samples": len(features),
    "mu": mu.tolist(),
    "sigma": np.sqrt(sigma2).tolist(),
    "sigma2": sigma2.tolist(),
    "alpha": alpha,
}

out_path = HOME / ".my-brain" / "spm-wildchat.json"
os.makedirs(out_path.parent, exist_ok=True)
with open(out_path, "w") as f:
    json.dump(output, f, indent=2)
print(f"\n✓ Saved to {out_path}")

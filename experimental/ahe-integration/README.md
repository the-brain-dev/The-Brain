# the-brain + AHE — Standalone Demo

Demonstrates the-brain as a **cognitive layer** for meta-harness systems (AHE, Meta-Harness) — predictive regression detection across harness evolution cycles.

## Quick Start

```bash
cd demo
chmod +x run-demo.sh
./run-demo.sh
```

Or directly:

```bash
cd ~/Projects/Private/the-brain
bun run experimental/ahe-integration/demo/simulated-harness.ts
```

## What It Does

Simulates a 5-cycle AHE-like harness evolution loop:

| Cycle | Harness Change | Prediction | Actual | Result |
|-------|---------------|------------|--------|--------|
| 1 | Seed harness | — | mmlu acc=0.892 | Cold start — building baselines |
| 2 | Add caching middleware | No accuracy impact | mmlu acc=0.870 | ⚠️ Regression (-2.2%) |
| 3 | Fix cache bug | +2% recovery | mmlu acc=0.895 | ✅ Recovered |
| 4 | Refactor tool registry | No accuracy impact | mmlu acc=0.845 | 🚨 SURPRISE! (-4.7%, z=3.15) |
| 5 | Rollback | Full recovery | mmlu acc=0.893 | ✅ Recovered |

## Key Demonstrations

1. **Cold start → warm predictions**: confidence grows from 33% (cycle 2) to 80% (cycle 5)
2. **SPM surprise filtering**: only cycles 2 and 4 are anomalous — the rest is noise
3. **Regression graph**: cycles 2 and 4 linked through infrastructure edits (middleware + tools)
4. **Drift detection**: sliding window Z-score confirms model stability after cycle 5
5. **Model comparison**: claude-sonnet-4 vs claude-opus-4 on MMLU

## How It Works

```
Fixture files (pre-generated lm-eval JSON)
  → HarnessFingerprintStore
    → Welford online statistics per model/benchmark/metric
      → Anomaly detection (>2σ from baseline)
        → Surprise feed for HITL review
```

No external dependencies — uses the-brain's own `HarnessFingerprintStore` and `parser` modules directly.

## Fixture Format

Results follow standard lm-evaluation-harness JSON output:

```json
{
  "results": {
    "mmlu": { "acc,none": 0.892, "acc_stderr,none": 0.012 }
  },
  "config": { "model_args": "pretrained=claude-sonnet-4" },
  "task_hashes": { "mmlu": "hash-..." },
  "model_name": "claude-sonnet-4"
}
```

Cycle descriptions add metadata:

```json
{
  "cycle": 2,
  "harness": "add-caching",
  "edit_id": "edit-cache-01",
  "edit_component": "middleware",
  "prediction": "no accuracy impact expected",
  "result_file": "cycle-02-caching-regression.json"
}
```

#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════
# the-brain + Meta-Harness — Standalone Demo
# Simulates 5-cycle AHE harness evolution with cognitive layer
# ═══════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

echo ""
echo "🧠 the-brain + Meta-Harness — Standalone Demo"
echo "   Cognitive Layer for Harness Evolution"
echo ""

cd "$REPO_ROOT"
bun run "$SCRIPT_DIR/simulated-harness.ts"

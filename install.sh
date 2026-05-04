#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════
# my-brain Install Script
# Sets up Bun, Python/uv, and initializes the brain
# ═══════════════════════════════════════════════════════════

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[my-brain]${NC} $1"; }
success() { echo -e "${GREEN}[my-brain]${NC} ✅ $1"; }
warn()  { echo -e "${YELLOW}[my-brain]${NC} ⚠️  $1"; }
error() { echo -e "${RED}[my-brain]${NC} ❌ $1"; }

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║       🧠 my-brain Installer             ║${NC}"
echo -e "${CYAN}║  Pluggable Cognitive OS for AI Agents   ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

# ── Check/install Bun ──────────────────────────────────────────
if command -v bun &> /dev/null; then
    success "Bun found: $(bun --version)"
else
    info "Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
    success "Bun installed"
fi

# ── Check/install uv (Python sidecar) ──────────────────────────
if command -v uv &> /dev/null; then
    success "uv found: $(uv --version 2>&1 | head -1)"
else
    info "Installing uv (Python package manager)..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
    success "uv installed"
fi

# ── Install dependencies ───────────────────────────────────────
info "Installing project dependencies..."
cd "$(dirname "$0")"

bun install --frozen-lockfile 2>/dev/null || bun install

success "Dependencies installed"

# ── Initialize my-brain ────────────────────────────────────────
info "Initializing my-brain..."

# Create config directory
MY_BRAIN_DIR="$HOME/.my-brain"
mkdir -p "$MY_BRAIN_DIR"/{logs,wiki,lora-checkpoints}

# Run init
bun run apps/cli/src/index.ts init

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   🧠 my-brain is ready!                 ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo "  Next steps:"
echo "    my-brain daemon start     Start the background daemon"
echo "    my-brain inspect --stats  Check your brain's health"
echo "    my-brain plugins list     See available plugins"
echo ""

# ── Optional: Python sidecar setup ─────────────────────────────
if [[ "$(uname -m)" == "arm64" && "$(uname -s)" == "Darwin" ]]; then
    info "Apple Silicon detected — MLX LoRA training available!"
    info "  To enable MLX training:"
    info "    uv pip install mlx mlx-lm"
    info "  Then edit ~/.my-brain/config.json and set mlx.enabled: true"
fi

#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════
# the-brain Install Script
# Sets up Bun, Python/uv, and initializes the brain
# ═══════════════════════════════════════════════════════════

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[the-brain]${NC} $1"; }
success() { echo -e "${GREEN}[the-brain]${NC} ✅ $1"; }
warn()  { echo -e "${YELLOW}[the-brain]${NC} ⚠️  $1"; }
error() { echo -e "${RED}[the-brain]${NC} ❌ $1"; }

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║       🧠 the-brain Installer             ║${NC}"
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

# ── Make 'the-brain' globally available ──────────────────────────
info "Linking the-brain CLI globally..."
cd apps/cli
bun link 2>/dev/null || true
cd - > /dev/null

if command -v the-brain &> /dev/null; then
    success "the-brain is now globally available: $(command -v the-brain)"
else
    warn "Could not link the-brain globally"
    warn "  Add to your shell: alias the-brain='bun run $PWD/apps/cli/src/index.ts'"
fi

# ── Initialize the-brain ────────────────────────────────────────
info "Initializing the-brain..."

# Create config directory
THE_BRAIN_DIR="$HOME/.the-brain"
mkdir -p "$THE_BRAIN_DIR"/{logs,wiki,lora-checkpoints}

# Run init
bun run apps/cli/src/index.ts init

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   🧠 the-brain is ready!                 ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo "  Starting daemon..."
bun run apps/cli/src/index.ts daemon start 2>/dev/null || echo "  (daemon already running)"

# ── Create daemon LaunchAgent (auto-start at login) ───────
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$LAUNCH_AGENTS_DIR"

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
DAEMON_PLIST="$LAUNCH_AGENTS_DIR/com.thebrain.daemon.plist"
cat > "$DAEMON_PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.thebrain.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>$HOME/.bun/bin/bun</string>
        <string>run</string>
        <string>$REPO_DIR/apps/cli/src/index.ts</string>
        <string>daemon</string>
        <string>start</string>
        <string>--poll-interval</string>
        <string>30000</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$THE_BRAIN_DIR/logs/daemon.log</string>
    <key>StandardErrorPath</key>
    <string>$THE_BRAIN_DIR/logs/daemon.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:$HOME/.bun/bin:$HOME/.local/bin</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>
</dict>
</plist>
PLISTEOF

launchctl unload "$DAEMON_PLIST" 2>/dev/null || true
launchctl load "$DAEMON_PLIST"
success "Daemon will auto-start at login (LaunchAgent)"

echo ""

# ── macOS: Build & install menu bar app ────────────────────────
if [[ "$(uname -s)" == "Darwin" ]]; then
    MENU_BAR_DIR="$(dirname "$0")/apps/menu-bar"

    if [[ -d "$MENU_BAR_DIR" ]] && command -v swift &> /dev/null; then
        info "macOS detected — building menu bar app..."
        cd "$MENU_BAR_DIR"

        if swift build -c release 2>&1 | tail -1; then
            BAR_BIN="$MENU_BAR_DIR/.build/arm64-apple-macosx/release/TheBrainBar"
            BAR_DEST="$THE_BRAIN_DIR/TheBrainBar"

            cp "$BAR_BIN" "$BAR_DEST"
            chmod +x "$BAR_DEST"
            success "Menu bar app built → $BAR_DEST"

            # ── Create LaunchAgent (auto-start at login) ─────
            LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
            mkdir -p "$LAUNCH_AGENTS_DIR"

            PLIST="$LAUNCH_AGENTS_DIR/com.thebrain.bar.plist"
            cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.thebrain.bar</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BAR_DEST</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$THE_BRAIN_DIR/logs/menubar.log</string>
    <key>StandardErrorPath</key>
    <string>$THE_BRAIN_DIR/logs/menubar.log</string>
</dict>
</plist>
PLISTEOF

            # Unload old + load new
            launchctl unload "$PLIST" 2>/dev/null || true
            launchctl load "$PLIST"
            success "Menu bar app will auto-start at login (LaunchAgent)"
        else
            warn "Swift build failed — menu bar app skipped"
            warn "  Install Xcode or run: xcode-select --install"
        fi

        cd - > /dev/null
    elif [[ -d "$MENU_BAR_DIR" ]]; then
        warn "Swift not found — menu bar app skipped"
        warn "  Install Xcode for the menu bar icon"
    fi
fi

# ── Optional: Python sidecar setup ─────────────────────────────
if [[ "$(uname -m)" == "arm64" && "$(uname -s)" == "Darwin" ]]; then
    info "Apple Silicon detected — MLX LoRA training available!"
    info "  To enable MLX training:"
    info "    uv pip install mlx mlx-lm"
    info "  Then edit ~/.the-brain/config.json and set mlx.enabled: true"
fi

# ── Remote mode detection ──────────────────────────────────────
if [[ -n "${THE_BRAIN_REMOTE_URL:-}" ]]; then
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║   🌐 Remote client mode detected        ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
    echo ""
    info "Remote URL: $THE_BRAIN_REMOTE_URL"
    info "Skipping daemon start — running in client mode"
    info ""
    info "To start the agent (polls IDE logs → server):"
    info "  the-brain agent"
    info ""
    info "To auto-start agent at login, add to crontab:"
    info "  @reboot THE_BRAIN_REMOTE_URL=\"$THE_BRAIN_REMOTE_URL\" THE_BRAIN_AUTH_TOKEN=\"$THE_BRAIN_AUTH_TOKEN\" the-brain agent &"

    # ── Create LaunchAgent for agent auto-start ──
    if [[ "$(uname -s)" == "Darwin" ]]; then
        LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
        mkdir -p "$LAUNCH_AGENTS_DIR"
        AGENT_PLIST="$LAUNCH_AGENTS_DIR/com.thebrain.agent.plist"

        cat > "$AGENT_PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.thebrain.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>$HOME/.bun/bin/bun</string>
        <string>run</string>
        <string>$REPO_DIR/apps/cli/src/index.ts</string>
        <string>agent</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$THE_BRAIN_DIR/logs/agent.log</string>
    <key>StandardErrorPath</key>
    <string>$THE_BRAIN_DIR/logs/agent.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>THE_BRAIN_REMOTE_URL</key>
        <string>$THE_BRAIN_REMOTE_URL</string>
        <key>THE_BRAIN_AUTH_TOKEN</key>
        <string>$THE_BRAIN_AUTH_TOKEN</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:$HOME/.bun/bin:$HOME/.local/bin</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>
</dict>
</plist>
PLISTEOF

        launchctl unload "$AGENT_PLIST" 2>/dev/null || true
        launchctl load "$AGENT_PLIST"
        success "Agent will auto-start at login (LaunchAgent)"
    fi
fi

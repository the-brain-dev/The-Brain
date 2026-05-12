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
BLUE='\033[0;34m'
GRAY='\033[0;90m'
BOLD='\033[1m'
NC='\033[0m' # No Color
RESET='\033[0m'

info()  { echo -e "${CYAN}[the-brain]${NC} $1"; }
success() { echo -e "${GREEN}[the-brain]${NC} ✅ $1"; }
warn()  { echo -e "${YELLOW}[the-brain]${NC} ⚠️  $1"; }
error() { echo -e "${RED}[the-brain]${NC} ❌ $1"; }

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  🧠 the-brain Installer                 ║${NC}"
echo -e "${CYAN}║  Open memory platform for AI           ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

# ── Parse flags ──────────────────────────────────────────────────
QUICK_MODE=false
for arg in "$@"; do
    case "$arg" in
        --quick|--non-interactive|-q) QUICK_MODE=true ;;
    esac
done

# ── Resolve real home directory ──────────────────────────────────
# In sandboxed environments (Hermes Agent, CI containers, Docker),
# $HOME may not point to the real user home. Resolve from the OS
# user database so the CLI is linked and PATH is configured for the
# actual user's shell, not the sandbox.
if [[ "$(uname -s)" == "Darwin" ]]; then
    REAL_HOME=$(dscl . -read "/Users/${USER}" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
elif command -v getent &>/dev/null; then
    REAL_HOME=$(getent passwd "${USER}" 2>/dev/null | cut -d: -f6)
fi
if [[ -n "${REAL_HOME:-}" ]] && [[ -d "$REAL_HOME" ]] && [[ "$REAL_HOME" != "$HOME" ]]; then
    warn "Sandboxed HOME detected ($HOME)"
    info  "Resolved real home → $REAL_HOME"
    export HOME="$REAL_HOME"
fi

# ── Detect execution mode (piped vs local) ─────────────────────
if [ ! -t 0 ]; then
    # Piped via curl|bash — clone repo to permanent location
    REPO_DIR="$HOME/.the-brain/repo"
    if [ -f "$REPO_DIR/package.json" ]; then
        info "Repository found at $REPO_DIR — updating..."
        cd "$REPO_DIR"
        git pull --ff-only origin main 2>/dev/null || true
        success "Repository up to date"
    else
        info "Cloning the-brain repository..."
        mkdir -p "$(dirname "$REPO_DIR")"
        git clone --depth 1 https://github.com/the-brain-dev/The-Brain.git "$REPO_DIR" 2>/dev/null
        if [ $? -ne 0 ] || [ ! -f "$REPO_DIR/package.json" ]; then
            error "Failed to clone repository. Make sure git is installed: git --version"
            rm -rf "$REPO_DIR"
            exit 1
        fi
        success "Repository cloned → $REPO_DIR"
    fi
    cd "$REPO_DIR"
else
    # Running from local file — use script location
    cd "$(dirname "$0")"
    REPO_DIR="$(pwd)"
fi

# ── Interactive pipeline setup ─────────────────────────────────
interactive_setup() {
    # Use the-brain setup command directly (simpler and more reliable)
    bun run apps/cli/src/index.ts setup
}

# ── Check/install Bun ──────────────────────────────────────────
if command -v bun &> /dev/null; then
    BUN_VERSION=$(bun --version 2>/dev/null)
    success "Bun found: $BUN_VERSION"
    # Minimum version check: Bun 1.0+ required for moduleResolution: "bundler"
    BUN_MAJOR=$(echo "$BUN_VERSION" | cut -d. -f1)
    if [ "${BUN_MAJOR:-0}" -lt 1 ]; then
        error "Bun 1.0+ required, found: $BUN_VERSION"
        exit 1
    fi
else
    info "Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    success "Bun installed"
fi
# Always ensure ~/.bun/bin is in PATH (bun link puts binaries there)
export PATH="$HOME/.bun/bin:$PATH"

# ── Check/install uv (Python sidecar) ──────────────────────────
if command -v uv &> /dev/null; then
    success "uv found: $(uv --version 2>&1 | head -1)"
else
    info "Installing uv (Python package manager)..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    success "uv installed"
fi
# Always ensure ~/.local/bin is in PATH (uv installer puts it there)
export PATH="$HOME/.local/bin:$PATH"

# ── Install dependencies ───────────────────────────────────────
info "Installing project dependencies..."

bun install --frozen-lockfile 2>/dev/null || bun install

success "Dependencies installed"

# ── Auto-update tsconfig.json paths for all workspace packages ────
info "Updating tsconfig.json paths..."
python3 -c "
import json, os, pathlib

tsconfig_path = 'tsconfig.json'
with open(tsconfig_path) as f:
    tsconfig = json.load(f)

paths = tsconfig.setdefault('compilerOptions', {}).setdefault('paths', {})

for pkg_dir in sorted(pathlib.Path('packages').iterdir()):
    if not pkg_dir.is_dir(): continue
    pkg_json = pkg_dir / 'package.json'
    if not pkg_json.exists(): continue
    with open(pkg_json) as f:
        pkg = json.load(f)
    name = pkg.get('name', '')
    if not name.startswith('@the-brain-dev/'): continue
    if name not in paths:
        paths[name] = [f'./{pkg_dir}/src']
        paths[f'{name}/*'] = [f'./{pkg_dir}/src/*']

with open(tsconfig_path, 'w') as f:
    json.dump(tsconfig, f, indent=2)
    f.write('\n')
print('Updated tsconfig.json with ' + str(len(paths)) + ' paths')
"
success "tsconfig.json up to date"

# ── Build CLI before linking ─────────────────────────────────────
info "Building the-brain CLI..."
cd apps/cli
bun build ./src/index.ts --outdir ./dist --target node
cd - > /dev/null
success "CLI built"

# ── Make 'the-brain' globally available ──────────────────────────
info "Linking the-brain CLI globally..."
cd apps/cli
bun link 2>/dev/null || true
cd - > /dev/null

# Ensure ~/.bun/bin is in PATH permanently (not just this session)
BUN_BIN="$HOME/.bun/bin"
if [ -x "$BUN_BIN/the-brain" ]; then
    # Detect shell and add ~/.bun/bin to the right rc file
    SHELL_NAME=$(basename "${SHELL:-/bin/zsh}")
    case "$SHELL_NAME" in
        zsh)  SHELL_RC="$HOME/.zshrc" ;;
        bash) SHELL_RC="$HOME/.bashrc"
              [ -f "$HOME/.bash_profile" ] && SHELL_RC="$HOME/.bash_profile" ;;
        fish) SHELL_RC="$HOME/.config/fish/config.fish" ;;
        *)    SHELL_RC="" ;;
    esac

    if [ -n "$SHELL_RC" ] && ! grep -q "$BUN_BIN" "$SHELL_RC" 2>/dev/null; then
        echo "" >> "$SHELL_RC"
        echo "# Added by the-brain installer" >> "$SHELL_RC"
        echo "export PATH=\"$BUN_BIN:\\\$PATH\"" >> "$SHELL_RC"
        success "Added $BUN_BIN to $SHELL_RC"
    fi
    success "the-brain linked — restart terminal or run: source $SHELL_RC"
elif command -v the-brain &> /dev/null; then
    success "the-brain is already globally available: $(command -v the-brain)"
else
    warn "Could not link the-brain globally"
    warn "  Add to your shell: alias the-brain='bun run $REPO_DIR/apps/cli/src/index.ts'"
fi

# ── Initialize the-brain ────────────────────────────────────────
info "Initializing the-brain..."

# Create config directory
THE_BRAIN_DIR="$HOME/.the-brain"
mkdir -p "$THE_BRAIN_DIR"/{logs,wiki,lora-checkpoints}

# Run init
bun run apps/cli/src/index.ts init

# ── Interactive pipeline setup (skip if --quick) ──────────────
if [ "$QUICK_MODE" = false ]; then
    interactive_setup
else
    info "Quick mode — using default pipeline (cursor+claude, all layers, LLM on, MLX off)"
fi

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   🧠 the-brain is ready!                 ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo "  Starting daemon (background)..."
bun run apps/cli/src/index.ts daemon start &>/dev/null &

# ── Create daemon LaunchAgent (auto-start at login) ───────
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$LAUNCH_AGENTS_DIR"

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
    MENU_BAR_DIR="$REPO_DIR/apps/menu-bar"

    if [[ -d "$MENU_BAR_DIR" ]] && command -v swift &> /dev/null; then
        info "macOS detected — building menu bar app..."
        cd "$MENU_BAR_DIR"

        # Clean stale caches (fixes module path errors after renames)
        swift package clean 2>/dev/null
        if swift build -c release 2>&1 | tail -1; then
            # Detect binary path dynamically (cross-architecture safe)
            BIN_DIR=$(swift build --show-bin-path -c release 2>/dev/null || echo "")
            if [ -n "$BIN_DIR" ] && [ -f "$BIN_DIR/TheBrainBar" ]; then
                BAR_BIN="$BIN_DIR/TheBrainBar"
            else
                # Fallback for older Swift versions
                BAR_BIN="$MENU_BAR_DIR/.build/arm64-apple-macosx/release/TheBrainBar"
                [ -f "$BAR_BIN" ] || BAR_BIN="$MENU_BAR_DIR/.build/release/TheBrainBar"
            fi
            BAR_DEST="$THE_BRAIN_DIR/TheBrainBar"

            if [ -f "$BAR_BIN" ]; then
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
                warn "Menu bar app built but binary not found at expected paths"
                warn "  Tried: $BAR_BIN"
            fi
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

# ── Linux: create systemd user unit for auto-start ──────────
if [[ "$(uname -s)" == "Linux" ]] && command -v systemctl &>/dev/null; then
    SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
    mkdir -p "$SYSTEMD_USER_DIR"

    cat > "$SYSTEMD_USER_DIR/the-brain-daemon.service" <<UNITEOF
[Unit]
Description=the-brain memory platform daemon
After=network-online.target

[Service]
Type=simple
ExecStart=$HOME/.bun/bin/bun run $REPO_DIR/apps/cli/src/index.ts daemon start
ExecStop=$HOME/.bun/bin/bun run $REPO_DIR/apps/cli/src/index.ts daemon stop
Restart=on-failure
RestartSec=10
Environment="PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.bun/bin:$HOME/.local/bin"
Environment="HOME=$HOME"

[Install]
WantedBy=default.target
UNITEOF

    systemctl --user daemon-reload 2>/dev/null
    systemctl --user enable the-brain-daemon.service 2>/dev/null
    systemctl --user start the-brain-daemon.service 2>/dev/null || true
    success "systemd user unit created — daemon auto-starts at login"
fi

# ── Post-install verification ──────────────────────────────────
echo ""
info "Verifying installation..."

if the-brain daemon status 2>/dev/null | grep -q "running"; then
    success "Daemon is running"
else
    warn "Daemon is not running — check logs: $THE_BRAIN_DIR/logs/daemon.log"
    warn "  Try: the-brain daemon start"
fi

if the-brain inspect --stats 2>/dev/null | grep -q "Total memories"; then
    success "Brain database accessible"
else
    warn "Brain database not accessible"
    warn "  Try: the-brain inspect --stats"
fi

echo ""
echo -e "  ${CYAN}Next steps:${NC}"
echo -e "    the-brain inspect --stats     Check your brain's health"
echo -e "    the-brain setup               Reconfigure pipeline anytime"
echo -e "    the-brain switch-context      Switch active project"
echo -e "    the-brain daemon status       Check daemon status"
echo ""

# ── Optional: Python sidecar setup ─────────────────────────────
if [[ "$(uname -m)" == "arm64" && "$(uname -s)" == "Darwin" ]]; then
    info "Apple Silicon detected — MLX LoRA training available!"
    info "  Install MLX packages:  uv pip install mlx mlx-lm"
    info "  Then re-run:           ./install.sh"
    info "  (or manually set mlx.enabled: true in ~/.the-brain/config.json)"
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

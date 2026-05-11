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
echo -e "${CYAN}║  🧠 the-brain Installer                 ║${NC}"
echo -e "${CYAN}║  Open memory platform for AI           ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

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
    if not name.startswith('@the-brain/'): continue
    if name not in paths:
        paths[name] = [f'./{pkg_dir}/src']
        paths[f'{name}/*'] = [f'./{pkg_dir}/src/*']

with open(tsconfig_path, 'w') as f:
    json.dump(tsconfig, f, indent=2)
    f.write('\n')
print('Updated tsconfig.json with ' + str(len(paths)) + ' paths')
"
success "tsconfig.json up to date"

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

# ── Enable MLX if Python mlx/mlx-lm packages are installed ─────
if python3 -c "import mlx; import mlx_lm" 2>/dev/null; then
    python3 -c "
import json
config_path = '$THE_BRAIN_DIR/config.json'
with open(config_path) as f:
    config = json.load(f)
if not config.get('mlx', {}).get('enabled'):
    config.setdefault('mlx', {})['enabled'] = True
    with open(config_path, 'w') as f:
        json.dump(config, f, indent=2)
        f.write('\n')
    print('MLX detected — auto-enabled in config')
" && success "MLX LoRA training enabled"
fi

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   🧠 the-brain is ready!                 ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo "  Starting daemon..."
DAEMON_OUTPUT=$(bun run apps/cli/src/index.ts daemon start 2>&1) || true
if echo "$DAEMON_OUTPUT" | grep -q "already running"; then
    echo "  (daemon already running)"
elif echo "$DAEMON_OUTPUT" | grep -qE "Daemon started|🧠 the-brain initialized"; then
    success "Daemon started"
else
    warn "Daemon may have failed to start:"
    echo "$DAEMON_OUTPUT" | while IFS= read -r line; do
        echo "  $line"
    done
fi

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

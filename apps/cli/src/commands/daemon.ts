/**
 * daemon command — Start/stop the background daemon, manage launchd service
 */
import { consola } from "consola";
import { startDaemon, stopDaemon } from "../daemon";
import { writeFile, unlink, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const LAUNCHD_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(LAUNCHD_DIR, "com.mybrain.daemon.plist");
const LABEL = "com.mybrain.daemon";

export async function daemonCommand(
  action: string,
  options: { pollInterval?: number }
) {
  switch (action) {
    case "start": {
      consola.start("Starting my-brain daemon...");
      const pollInterval = options.pollInterval ? parseInt(String(options.pollInterval)) : 30000;
      await startDaemon({ pollIntervalMs: pollInterval });
      break;
    }
    case "stop": {
      consola.start("Stopping my-brain daemon...");
      await stopDaemon();
      break;
    }
    case "status": {
      const running = await checkDaemonRunning();
      const launchdLoaded = await checkLaunchdLoaded();
      consola.info(`Daemon status: ${running ? "🟢 running" : "🔴 stopped"}`);
      consola.info(`Launchd service: ${launchdLoaded ? "🟢 loaded" : "⚪ not loaded"}`);
      if (running) {
        try {
          const pidPath = join(process.env.HOME || "~", ".my-brain", "daemon.pid");
          const pidStr = await readFile(pidPath, "utf-8");
          consola.info(`PID: ${pidStr.trim()}`);
        } catch {}
      }
      break;
    }
    case "enable": {
      await installLaunchdService(options.pollInterval || 30000);
      break;
    }
    case "disable": {
      await removeLaunchdService();
      break;
    }
    default: {
      consola.error(`Unknown daemon action: ${action}. Use "start", "stop", "status", "enable", or "disable".`);
      process.exit(1);
    }
  }
}

// ── Launchd ──────────────────────────────────────────────────────

async function installLaunchdService(pollIntervalMs: number) {
  // Resolve the bun binary and script paths
  const bunPath = process.execPath;
  const scriptDir = typeof import.meta.dir !== "undefined" ? import.meta.dir : __dirname;
  const scriptPath = join(scriptDir, "..", "index.ts");

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>run</string>
    <string>${scriptPath}</string>
    <string>daemon</string>
    <string>start</string>
    <string>--poll-interval</string>
    <string>${pollIntervalMs}</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${homedir()}/.my-brain/logs/daemon-stdout.log</string>

  <key>StandardErrorPath</key>
  <string>${homedir()}/.my-brain/logs/daemon-stderr.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${homedir()}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}</string>
  </dict>

  <key>WorkingDirectory</key>
  <string>${homedir()}</string>

  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>`;

  // Ensure LaunchAgents dir exists
  await mkdir(LAUNCHD_DIR, { recursive: true });

  // Write plist
  await writeFile(PLIST_PATH, plistContent, "utf-8");
  consola.success(`Launchd plist written: ${PLIST_PATH}`);

  // Load with launchctl
  try {
    execSync(`launchctl load ${PLIST_PATH}`, { stdio: "pipe" });
    consola.success("Launchd service loaded and started!");
    consola.info("my-brain daemon will now auto-start on boot.");
  } catch (err) {
    consola.error("Failed to load launchd service:", String(err));
    consola.info(`You can load manually: launchctl load ${PLIST_PATH}`);
  }
}

async function removeLaunchdService() {
  try {
    execSync(`launchctl unload ${PLIST_PATH}`, { stdio: "pipe" });
    consola.success("Launchd service unloaded.");
  } catch {
    // Not loaded, that's ok
  }

  try {
    await unlink(PLIST_PATH);
    consola.success("Launchd plist removed.");
  } catch {
    consola.info("No plist to remove.");
  }
}

async function checkLaunchdLoaded(): Promise<boolean> {
  try {
    const output = execSync(`launchctl list ${LABEL}`, { stdio: "pipe", encoding: "utf-8" });
    return output.includes(LABEL);
  } catch {
    return false;
  }
}

// ── PID check ────────────────────────────────────────────────────

async function checkDaemonRunning(): Promise<boolean> {
  try {
    const pidPath = join(process.env.HOME || "~", ".my-brain", "daemon.pid");
    const pidStr = await readFile(pidPath, "utf-8");
    const pid = parseInt(pidStr.trim());

    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

export { checkDaemonRunning };

/**
 * the-brain timeline — opens the brain activity timeline in browser.
 *
 * Usage: the-brain timeline
 *
 * Opens http://localhost:9420/timeline in the default browser.
 * Requires the daemon to be running (`the-brain daemon start`).
 */
import { execSync } from "node:child_process";

export async function timelineCommand(): Promise<void> {
  const url = "http://localhost:9420/timeline";

  try {
    const platform = process.platform;
    if (platform === "darwin") {
      execSync(`open "${url}"`);
    } else if (platform === "linux") {
      execSync(`xdg-open "${url}"`);
    } else if (platform === "win32") {
      execSync(`start "" "${url}"`);
    } else {
      console.log(`Open this URL in your browser: ${url}`);
    }
  } catch {
    console.log(`Could not open browser automatically. Open: ${url}`);
  }
}

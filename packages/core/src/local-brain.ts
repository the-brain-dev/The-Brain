/**
 * Project-local .brain/ state directory manager.
 *
 * Inspired by pi-mono's .pi/git/ and .pi/npm/ directories.
 * Each project can have a `.brain/` directory at its root
 * containing:
 *   - state.json     — harvester offsets, last consolidation timestamp
 *   - memories.db    — (optional) per-project SQLite database
 *   - prompts/       — (optional) per-project prompt overrides
 *
 * Usage:
 *   const localBrain = new LocalBrainDir("/path/to/project");
 *   await localBrain.ensureDir();
 *   await localBrain.updateState({ lastConsolidation: Date.now() });
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LocalBrainState {
  /** Last successful consolidation timestamp */
  lastConsolidation?: number;
  /** Last successful MLX training timestamp */
  lastTraining?: number;
  /** Per-harvester offsets */
  harvesterOffsets?: Record<string, {
    lastOffset: number;
    lastTimestamp: number;
    projectContext?: string;
  }>;
  /** Cross-project promotion count */
  crossProjectPromotions?: number;
  /** Total interactions harvested */
  totalInteractions?: number;
  /** Creation timestamp */
  createdAt?: number;
}

const DEFAULT_STATE: LocalBrainState = {
  totalInteractions: 0,
  crossProjectPromotions: 0,
};

/**
 * Manages a project-local .brain/ directory.
 *
 * The .brain/ directory should be added to .gitignore:
 *   echo "*\n!.gitignore\n!prompts/\n!prompts/*.md" > .brain/.gitignore
 */
export class LocalBrainDir {
  public readonly root: string;

  constructor(projectRoot: string) {
    this.root = join(projectRoot, ".brain");
  }

  /**
   * Ensure the .brain/ directory and its subdirectories exist.
   */
  ensureDir(): void {
    if (!existsSync(this.root)) {
      mkdirSync(this.root, { recursive: true });
    }

    const promptsDir = join(this.root, "prompts");
    if (!existsSync(promptsDir)) {
      mkdirSync(promptsDir, { recursive: true });
    }

    const gitignorePath = join(this.root, ".gitignore");
    if (!existsSync(gitignorePath)) {
      writeFileSync(
        gitignorePath,
        "*\n!.gitignore\n!prompts/\n!prompts/*.md\n"
      );
    }
  }

  /**
   * Read the current state from state.json.
   */
  readState(): LocalBrainState {
    const statePath = join(this.root, "state.json");
    if (!existsSync(statePath)) {
      return { ...DEFAULT_STATE };
    }

    try {
      const raw = readFileSync(statePath, "utf-8");
      return { ...DEFAULT_STATE, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  /**
   * Partially update the state (deep merge).
   */
  async updateState(patch: Partial<LocalBrainState>): Promise<void> {
    const state = this.readState();
    const merged = { ...state, ...patch };

    // Deep merge harvesterOffsets if both exist
    if (patch.harvesterOffsets && state.harvesterOffsets) {
      merged.harvesterOffsets = {
        ...state.harvesterOffsets,
        ...patch.harvesterOffsets,
      };
    }

    const statePath = join(this.root, "state.json");
    writeFileSync(statePath, JSON.stringify(merged, null, 2));
  }

  /**
   * Check if the .brain/ directory exists for this project.
   */
  exists(): boolean {
    return existsSync(this.root);
  }

  /**
   * Get the path for a project-local memories database.
   * Returns null if the project prefers global DB.
   */
  getLocalDBPath(): string | null {
    if (!this.exists()) return null;
    return join(this.root, "memories.db");
  }

  /**
   * Get the prompts directory path.
   */
  getPromptsDir(): string {
    return join(this.root, "prompts");
  }

  /**
   * Create a .brain/ directory if it doesn't exist, with proper .gitignore.
   */
  static init(projectRoot: string): LocalBrainDir {
    const dir = new LocalBrainDir(projectRoot);
    dir.ensureDir();
    return dir;
  }

  /**
   * Discover all .brain/ directories in common project locations.
   * Scans parent directories up to 3 levels looking for .brain/.
   */
  static discover(cwd: string = process.cwd()): LocalBrainDir | null {
    let current = cwd;
    for (let i = 0; i < 4; i++) {
      const brainDir = new LocalBrainDir(current);
      if (brainDir.exists()) {
        return brainDir;
      }
      const parent = join(current, "..");
      if (parent === current) break;
      current = parent;
    }
    return null;
  }
}

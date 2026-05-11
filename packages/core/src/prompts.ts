/**
 * Prompt template loader.
 *
 * Reads .brain/prompts/*.md files with YAML frontmatter.
 * Inspired by pi-mono's .pi/prompts/ system.
 *
 * Usage:
 *   import { loadPrompt } from "../prompts";
 *   const { frontmatter, body } = loadPrompt("consolidate");
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface PromptFrontmatter {
  description: string;
  /** Hint shown in CLI help: "consolidate [--reprocess]" */
  "argument-hint"?: string;
  [key: string]: unknown;
}

export interface LoadedPrompt {
  frontmatter: PromptFrontmatter;
  body: string;
}

/**
 * Parse YAML frontmatter from markdown content.
 * Simple regex-based parser — sufficient for prompt templates.
 */
function parseFrontmatter(content: string): { data: PromptFrontmatter; content: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { data: { description: "" }, content };
  }

  const rawYaml = match[1];
  const body = match[2];

  // Simple YAML parser — handles `key: value` and `key: "value"`
  const data: PromptFrontmatter = { description: "" };
  for (const line of rawYaml.split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;

    const key = kv[1];
    let value: string = kv[2].trim();

    // Strip quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    (data as any)[key] = value;
  }

  return { data, content: body };
}

/**
 * Load a prompt template by name.
 * Reads from: <project_root>/.brain/prompts/<name>.md
 * Falls back to: <project_root>/apps/cli/prompts/<name>.md (bundled)
 */
export function loadPrompt(
  name: string,
  projectRoot?: string
): LoadedPrompt | null {
  const root = projectRoot ?? process.cwd();

  const paths = [
    join(root, ".brain", "prompts", `${name}.md`),
    join(root, "apps", "cli", "prompts", `${name}.md`),
  ];

  for (const path of paths) {
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf-8");
        const { data, content } = parseFrontmatter(raw);
        return { frontmatter: data, body: content };
      } catch {
        continue;
      }
    }
  }

  return null;
}

/**
 * Load all available prompt templates.
 */
export function listPrompts(projectRoot?: string): Array<{ name: string; frontmatter: PromptFrontmatter }> {
  const root = projectRoot ?? process.cwd();
  const promptsDir = join(root, ".brain", "prompts");
  const bundledDir = join(root, "apps", "cli", "prompts");

  const results: Array<{ name: string; frontmatter: PromptFrontmatter }> = [];
  const seen = new Set<string>();

  for (const dir of [promptsDir, bundledDir]) {
    if (!existsSync(dir)) continue;

    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".md")) continue;
        const name = file.replace(/\.md$/, "");
        if (seen.has(name)) continue;
        seen.add(name);

        const prompt = loadPrompt(name, root);
        if (prompt) {
          results.push({ name, frontmatter: prompt.frontmatter });
        }
      }
    } catch {
      continue;
    }
  }

  return results;
}

/**
 * Substitute $ARGUMENTS and $@ with CLI arguments.
 */
export function renderPrompt(template: string, args: string[]): string {
  let result = template;
  result = result.replace(/\$ARGUMENTS/g, args.join(" "));
  result = result.replace(/\$@/g, args.join(" "));
  return result;
}

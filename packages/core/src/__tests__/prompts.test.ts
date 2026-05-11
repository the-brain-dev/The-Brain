/**
 * Tests for prompt template loader.
 */
import { describe, it, expect } from "bun:test";
import { loadPrompt, listPrompts, renderPrompt } from "../prompts";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..", "..");

describe("Prompt Templates", () => {
  it("loads consolidate prompt", () => {
    const prompt = loadPrompt("consolidate", PROJECT_ROOT);
    expect(prompt).not.toBeNull();
    expect(prompt!.frontmatter.description).toBe(
      "Run memory consolidation — SPM evaluation + promotion to Deep Layer"
    );
    expect(prompt!.frontmatter["argument-hint"]).toBe("[--reprocess] [--project <name>]");
    expect(prompt!.body).toContain("## Process");
    expect(prompt!.body).toContain("SPM Evaluation");
  });

  it("loads train prompt", () => {
    const prompt = loadPrompt("train", PROJECT_ROOT);
    expect(prompt).not.toBeNull();
    expect(prompt!.frontmatter.description).toContain("LoRA training");
    expect(prompt!.body).toContain("uv run python run_lora.py");
  });

  it("loads health prompt", () => {
    const prompt = loadPrompt("health", PROJECT_ROOT);
    expect(prompt).not.toBeNull();
    expect(prompt!.body).toContain("Status:");
    expect(prompt!.body).toContain("Uptime");
  });

  it("loads inspect prompt", () => {
    const prompt = loadPrompt("inspect", PROJECT_ROOT);
    expect(prompt).not.toBeNull();
    expect(prompt!.body).toContain("Sub-commands");
    expect(prompt!.body).toContain("### `memories`");
  });

  it("returns null for missing prompt", () => {
    const prompt = loadPrompt("nonexistent", PROJECT_ROOT);
    expect(prompt).toBeNull();
  });

  it("lists all available prompts", () => {
    const prompts = listPrompts(PROJECT_ROOT);
    expect(prompts.length).toBeGreaterThanOrEqual(4);
    const names = prompts.map((p) => p.name);
    expect(names).toContain("consolidate");
    expect(names).toContain("train");
    expect(names).toContain("health");
    expect(names).toContain("inspect");
  });

  it("renders prompt with argument substitution", () => {
    const template = "Process: $ARGUMENTS\nArgs: $@";
    const rendered = renderPrompt(template, ["--force", "--project", "demo"]);
    expect(rendered).toContain("--force --project demo");
  });

  it("renders prompt with no args", () => {
    const template = "Process: $ARGUMENTS";
    const rendered = renderPrompt(template, []);
    expect(rendered).toBe("Process: ");
  });
});

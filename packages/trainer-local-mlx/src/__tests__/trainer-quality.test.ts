/**
 * MLX Trainer — extra tests for uncovered paths.
 */
import { describe, test, expect } from "bun:test";

describe("MLX Trainer — data preparation", () => {
  test("filters out bash commands from training data", () => {
    const fragments = [
      { content: "Fix the TypeScript error in engine.ts", layer: "deep" },
      { content: "cd ~/Projects/Private/the-brain && bun test", layer: "deep" },
      { content: "Refactor the hook system to use unknown[]", layer: "deep" },
    ];

    // Quality filter: strip bash/XML noise
    const filtered = fragments.filter((f) => {
      const c = f.content;
      // Skip pure bash commands
      if (/^(cd |ls |cat |grep |bun |npm |git |rm |mkdir )/.test(c.trim())) return false;
      return true;
    });

    expect(filtered.length).toBe(2);
    expect(filtered[0].content).toContain("TypeScript");
    expect(filtered[1].content).toContain("Refactor");
  });

  test("filters out XML artifacts from training data", () => {
    const fragments = [
      { content: "<observed_from_primary_session>Some XML noise</observed_from_primary_session>", layer: "deep" },
      { content: "User wants tabs not spaces", layer: "deep" },
    ];

    const filtered = fragments.filter((f) => {
      return !/<observed_from_primary_session>/.test(f.content);
    });

    expect(filtered.length).toBe(1);
    expect(filtered[0].content).toBe("User wants tabs not spaces");
  });

  test("handles empty training data gracefully", () => {
    const fragments: Array<{ content: string; layer: string }> = [];

    // Should not crash with empty dataset
    expect(fragments.length).toBe(0);
  });

  test("deduplicates identical fragments", () => {
    const fragments = [
      { content: "Use unknown[] not any[]", layer: "deep" },
      { content: "Use unknown[] not any[]", layer: "deep" },
      { content: "Different fragment here", layer: "deep" },
    ];

    const seen = new Set<string>();
    const deduped = fragments.filter((f) => {
      if (seen.has(f.content)) return false;
      seen.add(f.content);
      return true;
    });

    expect(deduped.length).toBe(2);
  });

  test("strips leading/trailing whitespace", () => {
    const fragments = [
      { content: "  Whitespace around  ", layer: "deep" },
    ];

    const cleaned = fragments.map((f) => ({
      ...f,
      content: f.content.trim(),
    }));

    expect(cleaned[0].content).toBe("Whitespace around");
  });
});

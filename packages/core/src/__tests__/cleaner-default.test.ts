/**
 * Tests for cleaner-default.ts — default ContentCleaner plugin wrapper.
 */

import { describe, it, expect } from "bun:test";

describe("createDefaultCleaner", () => {
  it("returns a ContentCleanerPlugin with required methods", async () => {
    const { createDefaultCleaner } = await import("../cleaner-default");
    const cleaner = createDefaultCleaner();

    expect(cleaner.name).toBe("@the-brain/content-cleaner-default");
    expect(typeof cleaner.clean).toBe("function");
    expect(typeof cleaner.cleanGraphLabel).toBe("function");
    expect(typeof cleaner.deduplicate).toBe("function");
  });

  it("clean() extracts summary from raw XML content", async () => {
    const { createDefaultCleaner } = await import("../cleaner-default");
    const cleaner = createDefaultCleaner();

    const raw = `<observed_from_primary_session>
<what_happened>Fixed a bug in the authentication module</what_happened>
<user_request>Fix the login error on the dashboard</user_request>
<working_directory>/projects/my-app</working_directory>
</observed_from_primary_session>`;

    const result = await cleaner.clean(raw);
    expect(result.summary).toBeDefined();
    expect(result.userRequest).toBeDefined();
    expect(result.type).toBeDefined();
  });

  it("clean() handles plain text gracefully", async () => {
    const { createDefaultCleaner } = await import("../cleaner-default");
    const cleaner = createDefaultCleaner();

    const result = await cleaner.clean("Just plain text with no XML wrapping");
    expect(result).toBeDefined();
    expect(typeof result.summary).toBe("string");
  });

  it("cleanGraphLabel() returns a string", async () => {
    const { createDefaultCleaner } = await import("../cleaner-default");
    const cleaner = createDefaultCleaner();

    const result = await cleaner.cleanGraphLabel("user prefers dark mode", "preference");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("deduplicate() returns unique entries", async () => {
    const { createDefaultCleaner } = await import("../cleaner-default");
    const cleaner = createDefaultCleaner();

    const items = [
      { summary: "Item A", action: "fix", project: "test", userRequest: "req A", type: "observation" },
      { summary: "Item B", action: "edit", project: "test", userRequest: "req B", type: "observation" },
      { summary: "Item A", action: "fix", project: "test", userRequest: "req A", type: "observation" }, // duplicate
    ];

    const result = await cleaner.deduplicate(items);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it("deduplicate() handles empty array", async () => {
    const { createDefaultCleaner } = await import("../cleaner-default");
    const cleaner = createDefaultCleaner();

    const result = await cleaner.deduplicate([]);
    expect(result).toEqual([]);
  });
});

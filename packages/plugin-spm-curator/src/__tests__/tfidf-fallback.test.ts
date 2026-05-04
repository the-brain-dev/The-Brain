/**
 * Tests TF-IDF auto-fallback behavior.
 * When useTfidf: true but vocab not finalized → legacy EMA-Gaussian.
 */
import { describe, test, expect } from "bun:test";
import { createSpmCurator } from "../index";

describe("TF-IDF auto-fallback", () => {
  test("uses legacy mode when vocab not finalized", async () => {
    const { instance } = createSpmCurator({
      useTfidf: true,
      threshold: 0.3,
    });

    // Don't initialize TF-IDF — leave it un-finalized
    const detector = instance.getTfidf();
    expect(detector).not.toBeNull();
    expect(detector!.getStats().finalized).toBe(false);

    // Evaluate should use legacy EMA-Gaussian (fallback)
    const result = await instance.evaluate({
      interaction: {
        id: "test-1",
        prompt: "python function to parse json",
        response: "here is a function",
        timestamp: Date.now(),
        source: "test",
      },
      fragments: [],
      promoteToDeep: () => {},
    });

    // Should produce a legacy-format reason (not "tfidf=" prefix)
    expect(result.reason).toContain("composite=");
    expect(result.reason).not.toContain("tfidf=");
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  test("uses TF-IDF mode after finalizeTfidf()", async () => {
    const { instance } = createSpmCurator({
      useTfidf: true,
      threshold: 0.3,
    });

    // Initialize and finalize
    instance.initTfidfFromTexts([
      "python async await coroutine",
      "typescript interface implementation",
      "rust ownership borrowing",
    ]);
    instance.finalizeTfidf();

    // Build centroid
    instance.absorb(
      { id: "a", prompt: "python async await", response: "", timestamp: Date.now(), source: "test" },
      []
    );

    const result = await instance.evaluate({
      interaction: {
        id: "test-2",
        prompt: "python async await event loop",
        response: "",
        timestamp: Date.now(),
        source: "test",
      },
      fragments: [],
      promoteToDeep: () => {},
    });

    // Should use TF-IDF mode
    expect(result.reason).toContain("tfidf=");
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  test("seamless transition: legacy → tfidf after finalize", async () => {
    const { instance } = createSpmCurator({
      useTfidf: true,
      threshold: 0.3,
    });

    // Before finalize → legacy
    const r1 = await instance.evaluate({
      interaction: {
        id: "t1", prompt: "test query", response: "test response",
        timestamp: Date.now(), source: "test",
      },
      fragments: [], promoteToDeep: () => {},
    });
    expect(r1.reason).toContain("composite=");

    // Add data and finalize
    instance.initTfidfFromTexts(["python typescript rust go java"]);
    instance.finalizeTfidf();
    instance.absorb(
      { id: "a", prompt: "python typescript", response: "", timestamp: Date.now(), source: "test" },
      []
    );

    // After finalize → tfidf
    const r2 = await instance.evaluate({
      interaction: {
        id: "t2", prompt: "different query now", response: "different response here",
        timestamp: Date.now(), source: "test",
      },
      fragments: [], promoteToDeep: () => {},
    });
    expect(r2.reason).toContain("tfidf=");
  });

  test("legacy mode still works when useTfidf: false", async () => {
    const { instance } = createSpmCurator({
      useTfidf: false,
      threshold: 0.3,
    });

    const result = await instance.evaluate({
      interaction: {
        id: "test-3",
        prompt: "any text here",
        response: "some response",
        timestamp: Date.now(),
        source: "test",
      },
      fragments: [],
      promoteToDeep: () => {},
    });

    // Should always use legacy
    expect(result.reason).toContain("composite=");
  });
});

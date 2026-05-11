import { describe, test, expect } from "bun:test";
import { TfidfSurpriseDetector } from "../tfidf-detector";

describe("TfidfSurpriseDetector", () => {
  test("tokenize() splits on non-alphanumeric and lowercases", () => {
    const det = new TfidfSurpriseDetector();
    const tokens = det.tokenize("Hello World! Lunch break at 12? test_123");
    expect(tokens).toContain("hello");
    expect(tokens).toContain("world");
    expect(tokens).toContain("lunch");
    expect(tokens).toContain("break");
    expect(tokens).toContain("test_123");
    expect(tokens).toContain("12");
    expect(tokens).not.toContain("at");
  });

  test("tokenize() handles empty and whitespace", () => {
    const det = new TfidfSurpriseDetector();
    expect(det.tokenize("")).toEqual([]);
    expect(det.tokenize("   ")).toEqual([]);
    expect(det.tokenize("a")).toEqual([]);
  });

  test("addDocument() and finalize() build vocabulary", () => {
    const det = new TfidfSurpriseDetector({ maxFeatures: 100 });

    det.addDocument("implement a fast cache in python");
    det.addDocument("python debugging tips and tricks");
    det.addDocument("implement a fast cache in rust");
    det.addDocument("rust debugging techniques");

    det.finalize();

    const stats = det.getStats();
    expect(stats.vocabSize).toBeGreaterThan(0);
    expect(stats.docCount).toBe(4);
    expect(stats.finalized).toBe(true);
  });

  test("score() returns neutral when not finalized", () => {
    const det = new TfidfSurpriseDetector();
    expect(det.score("anything")).toBe(0.5);
  });

  test("score() = similar content lower; different content higher", () => {
    const det = new TfidfSurpriseDetector({ maxFeatures: 200 });

    // Train on diverse Python content
    const training = [
      "python function to parse json data quickly",
      "python script handles http requests with retry",
      "debugging python memory leaks in production",
      "python type hints improve code readability",
      "python async await coroutine event loop",
      "python list comprehension vs generator expression",
      "python decorator pattern for caching results",
      "python pytest unit testing best practices",
    ];
    for (const t of training) det.addDocument(t);
    det.finalize();
    for (const t of training) det.updateCentroid(t);

    // Python-related text → low surprise
    const similarScore = det.score("python function to process csv files");
    // Rust-related text → higher surprise
    const diffScore = det.score("how to deploy rust microservices on kubernetes");

    expect(diffScore).toBeGreaterThan(similarScore);
  });

  test("score() detects novel vocabulary as surprising", () => {
    const det = new TfidfSurpriseDetector({ maxFeatures: 200 });

    const training = [
      "react component with typescript props interface",
      "react hooks usestate useeffect example pattern",
      "react context provider consumer pattern",
      "react memo optimization techniques",
    ];
    for (const t of training) det.addDocument(t);
    det.finalize();
    for (const t of training) det.updateCentroid(t);

    const reactScore = det.score("typescript react functional component");
    const dbScore = det.score("postgresql database migration with alembic sqlalchemy");

    expect(dbScore).toBeGreaterThan(reactScore);
  });

  test("updateCentroid() shifts over many iterations", () => {
    const det = new TfidfSurpriseDetector({ maxFeatures: 200, alpha: 0.5 });

    const pythonDocs = [
      "python machine learning tensorflow keras neural network",
      "python data science pandas numpy matplotlib",
      "python web framework django flask fastapi",
    ];
    for (const t of pythonDocs) det.addDocument(t);
    det.finalize();

    // Train centroid entirely on Python
    for (let i = 0; i < 20; i++) {
      det.updateCentroid(pythonDocs[i % pythonDocs.length]);
    }

    const pythonScore = det.score("python neural network training gradient descent");

    // Now shift centroid entirely to Rust
    const rustDocs = [
      "rust systems programming memory safety ownership",
      "rust async tokio runtime performance",
      "rust web framework actix rocket warp",
    ];
    for (const t of rustDocs) det.addDocument(t);
    // Heavy retrain on Rust
    for (let i = 0; i < 30; i++) {
      det.updateCentroid(rustDocs[i % rustDocs.length]);
    }

    const adaptedScore = det.score("python neural network training gradient descent");
    // With alpha=0.5 and 30 rust updates, centroid should shift enough
    // that Python is now notably more surprising
    expect(adaptedScore).toBeGreaterThan(pythonScore);
  });

  test("exportState() and importState() round-trip", () => {
    const det = new TfidfSurpriseDetector({ maxFeatures: 50 });

    det.addDocument("python async await coroutines");
    det.addDocument("python generator yield iterator");
    det.finalize();
    det.updateCentroid("python async await coroutines");

    const state = det.exportState();
    expect(state.vocab.length).toBeGreaterThan(0);
    expect(state.docCount).toBe(2);
    expect(state.finalized).toBe(true);

    const det2 = new TfidfSurpriseDetector();
    det2.importState(state);

    const s1 = det.score("python async await event loop");
    const s2 = det2.score("python async await event loop");
    expect(s1).toBeCloseTo(s2, 4);

    const stats = det2.getStats();
    expect(stats.vocabSize).toBe(state.vocab.length);
    expect(stats.docCount).toBe(2);
  });

  test("handles large vocabulary (stress test)", () => {
    const det = new TfidfSurpriseDetector({ maxFeatures: 500 });

    const words = ["api", "cache", "database", "endpoint", "function",
      "graphql", "handler", "interface", "json", "kubernetes",
      "lambda", "middleware", "node", "optimizer", "pipeline"];

    for (let i = 0; i < 50; i++) {
      const shuffled = [...words].sort(() => Math.random() - 0.5);
      det.addDocument(shuffled.slice(0, 5).join(" "));
    }

    det.finalize();
    det.updateCentroid("api database function handler json");

    const start = performance.now();
    const score = det.score("kubernetes lambda optimizer pipeline graphql");
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(5);
    expect(score).toBeGreaterThan(0);
  });

  test("empty and whitespace-only docs don't break", () => {
    const det = new TfidfSurpriseDetector({ maxFeatures: 50 });

    det.addDocument("valid document with content");
    det.addDocument("");
    det.addDocument("   ");
    det.addDocument("a b c");
    det.finalize();

    expect(det.getStats().docCount).toBe(4);
    expect(typeof det.score("")).toBe("number");
  });
});

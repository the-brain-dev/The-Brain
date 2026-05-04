# 🧭 My-Brain Project Philosophy

## Vision

Modern AI models suffer from "digital amnesia." Every new session is a blank slate, and your assistant forgets your unique patterns, preferences, and the evolution of your coding style.

**my-brain** was created to transform AI from a tool into a digital symbiosis. Our goal is to build a cognitive layer that lives alongside the developer, learns continuously, and becomes an external extension of their own mind.

## Project Pillars

### 1. Privacy as Foundation (Local-First)

Your logs, errors, and thought process are the most intimate technical data you possess.

**Principle:** Data never leaves your machine unless you explicitly install a cloud plugin.
**Implementation:** We default to local SQLite databases, local MLX training, and local models via Ollama/LM Studio.

### 2. Biology-Inspired Architecture

Human memory isn't a flat collection of files. It's divided into time-sensitive and emotion-weighted layers.

**Principle:** The system must understand the difference between "what I'm doing now" and "who I am as a developer."
**Implementation:** Three-layer structure (Instant, Selection, Deep) enables immediate reaction while maintaining permanent, deep learning.

### 3. Extreme Modularity (Orchestration, not Dictatorship)

We don't believe in one "correct" way to remember. The AI world changes too quickly.

**Principle:** The my-brain core is an empty data bus. Everything — from log collection to database type to training engine — must be a swappable plugin.
**Implementation:** Hook system allowing the community to write any form of memory (Graph, Vector, RAG, LoRA) without modifying the system kernel.

### 4. Invisible Intelligence (Ambient UX)

The best tools are the ones you forget you're using.

**Principle:** The system should work in the background, requiring no additional manual work from the developer (zero-effort data collection).
**Implementation:** Background log polling, automatic data selection (Surprise Gate), and overnight training schedules.

### 5. Selection over Accumulation

Dumping everything into model memory ("data dumping") leads to noise and hallucinations.

**Principle:** Memory requires forgetting. The system must actively reject redundant and low-value information.
**Implementation:** SPM mechanism (Surprise-Gated Prediction Error) — we only learn from what surprises us.

## Why Monorepo and TypeScript/Bun?

- **TypeScript:** It's the language of the developers we're building for. We want every developer to easily write their own plugin.
- **Bun:** Chosen for its speed and native support for SQLite and TypeScript. In a "Local-First" project, millisecond delays in CLI command execution matter for workflow comfort.
- **Code Modularity:** The `apps/` and `packages/` split lets us separate business logic from specific implementations (e.g., separating the heavy Python/MLX environment from the lightweight TS orchestrator).

## Collaboration Manifesto

my-brain is and always will be an Open Source project.

We believe that personal artificial intelligence is a right, not a subscription service. We invite you to build this vision with us — by creating plugins, improving data selection algorithms, or simply sharing your ideas about "digital continuity."

> "The brain is a muscle that can be extended with code."

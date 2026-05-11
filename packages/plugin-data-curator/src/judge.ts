/**
 * LLM Judge — evaluates training data quality via OpenAI-compatible LLM backend.
 *
 * Uses a structured prompt to score interactions 1-10 across multiple
 * dimensions. Scores below threshold are candidates for rewriting or rejection.
 */

import { generateText, type LLMBackend } from "@the-brain/core";

export interface QualityJudgment {
  overall: number;          // 1-10 composite score
  dimensions: {
    correctness: number;    // Is the code/output correct?
    completeness: number;   // Is the response self-contained?
    educationalValue: number; // Does this teach something reusable?
    coherence: number;      // Does response match prompt intent?
    noiseLevel: number;     // 0 = clean, 10 = full of system noise (inverted)
  };
  reasoning: string;
  needsRewrite: boolean;
}

const JUDGE_PROMPT = `Rate this training example for an AI coding assistant. Output ONLY valid JSON, no markdown, no explanation outside the JSON.

Scoring (1-10):
- correctness: Is the code/response technically correct?
- completeness: Is it self-contained?
- educational_value: Does it teach a reusable pattern?
- coherence: Does response match the prompt?
- noise_level: Is it free of system noise? (10=pristine, 1=garbage)

Return JSON:
{"overall":<1-10>,"correctness":<1-10>,"completeness":<1-10>,"educational_value":<1-10>,"coherence":<1-10>,"noise_level":<1-10>,"needs_rewrite":<true|false>,"reasoning":"<1 sentence>"}

PROMPT: """{prompt}"""
RESPONSE: """{response}"""
JSON:`;


export function buildJudgePrompt(prompt: string, response: string): string {
  return JUDGE_PROMPT
    .replace("{prompt}", prompt.slice(0, 2000))
    .replace("{response}", response.slice(0, 2000));
}

export function parseJudgeResponse(raw: string): QualityJudgment | null {
  try {
    // Extract JSON from potential markdown wrappers
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      overall: clampScore(parsed.overall ?? 5),
      dimensions: {
        correctness: clampScore(parsed.correctness ?? 5),
        completeness: clampScore(parsed.completeness ?? 5),
        educationalValue: clampScore(parsed.educational_value ?? 5),
        coherence: clampScore(parsed.coherence ?? 5),
        noiseLevel: clampScore(parsed.noise_level ?? 5),
      },
      reasoning: String(parsed.reasoning ?? ""),
      // Force rewrite if overall < 6, regardless of what JSON says
      needsRewrite: Boolean(
        parsed.overall < 6 || parsed.needs_rewrite
      ),
    };
  } catch {
    return null;
  }
}

function clampScore(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(1, Math.min(10, Math.round(n))) : 5;
}

/**
 * Judge an interaction via OpenAI-compatible LLM backend.
 * Uses model fallback if backend.fallbackModels are configured.
 * Returns null on failure (all models failed, network error, timeout).
 */
export async function judgeInteraction(
  prompt: string,
  response: string,
  backend: LLMBackend,
): Promise<QualityJudgment | null> {
  const fullPrompt = buildJudgePrompt(prompt, response);

  const text = await generateText(backend, fullPrompt, {
    temperature: 0.1,
    maxTokens: 256,
  });

  if (!text) return null;
  return parseJudgeResponse(text);
}

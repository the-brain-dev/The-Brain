/**
 * LLM Rewriter — transforms poor-quality interactions into clean training examples.
 *
 * Takes raw interaction (prompt + noisy response) and produces a polished
 * instruction/response pair suitable for fine-tuning.
 */

import { generateText, type LLMBackend } from "@the-brain-dev/core";

export interface RewrittenExample {
  instruction: string;
  response: string;
}

const REWRITER_PROMPT = `You are a training data curator. Convert the following AI coding assistant conversation into a clean instruction/response pair suitable for fine-tuning.

Rules:
- Strip ALL system noise: [Note:...], [System note:...], [CONTEXT COMPACTION...], tool call results, progress bars, file paths
- Extract ONLY the final working code and minimal explanation
- If the original response has no useful code or technical content, respond with EMPTY pair
- Keep instruction concise (max 2 sentences)
- Keep response focused on the actual solution

Respond with ONLY valid JSON:
{
  "instruction": "<what the user was asking for>",
  "response": "<the clean technical answer>"
}

If the original interaction is unsalvageable (no technical content at all), return:
{
  "instruction": "",
  "response": ""
}

ORIGINAL PROMPT:
"""
{prompt}
"""

ORIGINAL RESPONSE:
"""
{response}
"""

JSON:`;


export function buildRewriterPrompt(prompt: string, response: string): string {
  return REWRITER_PROMPT
    .replace("{prompt}", prompt.slice(0, 3000))
    .replace("{response}", response.slice(0, 4000));
}

export function parseRewriterResponse(raw: string): RewrittenExample | null {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    const instruction = String(parsed.instruction ?? "").trim();
    const response = String(parsed.response ?? "").trim();

    // Unsalvageable — both empty
    if (!instruction && !response) return null;

    // Min quality check
    if (instruction.length < 5 || response.length < 30) return null;

    return { instruction, response };
  } catch {
    return null;
  }
}

/**
 * Rewrite an interaction via OpenAI-compatible LLM backend.
 * Returns null if unsalvageable or on network failure.
 */
export async function rewriteInteraction(
  prompt: string,
  response: string,
  backend: LLMBackend,
): Promise<RewrittenExample | null> {
  const fullPrompt = buildRewriterPrompt(prompt, response);

  const text = await generateText(backend, fullPrompt, {
    temperature: 0.2,
    maxTokens: 1024,
  });

  if (!text) return null;
  return parseRewriterResponse(text);
}

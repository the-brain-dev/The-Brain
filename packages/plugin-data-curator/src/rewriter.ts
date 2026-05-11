/**
 * LLM Rewriter — transforms poor-quality interactions into clean training examples.
 *
 * Takes raw interaction (prompt + noisy response) and produces a polished
 * instruction/response pair suitable for fine-tuning.
 */

export interface RewrittenExample {
  instruction: string;
  response: string;
}

interface OllamaGenerateResponse {
  response: string;
  done: boolean;
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
 * Rewrite an interaction via Ollama API.
 * Returns null if unsalvageable or on network failure.
 */
export async function rewriteInteraction(
  prompt: string,
  response: string,
  ollamaUrl: string = "http://localhost:11434",
  model: string = "qwen2.5:3b",
  timeoutMs: number = 60000,
): Promise<RewrittenExample | null> {
  const fullPrompt = buildRewriterPrompt(prompt, response);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: fullPrompt,
        stream: false,
        options: {
          temperature: 0.2,
          num_predict: 1024,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) return null;

    const data = (await res.json()) as OllamaGenerateResponse;
    return parseRewriterResponse(data.response);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

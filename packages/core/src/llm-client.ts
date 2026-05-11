/**
 * LLM Client — thin wrapper over OpenAI-compatible /v1/chat/completions.
 *
 * All local and cloud LLM providers support this endpoint:
 *   - Ollama (since 0.5): http://localhost:11434/v1/chat/completions
 *   - LM Studio: http://localhost:1234/v1/chat/completions
 *   - vLLM: http://localhost:8000/v1/chat/completions
 *   - OpenAI: https://api.openai.com/v1/chat/completions
 *
 * Supports model fallback cascade: if defaultModel fails (OOM, timeout, 404),
 * falls through fallbackModels in order.
 */

import type { LLMBackend } from "./types";

// ── Types ─────────────────────────────────────────────────────────

export interface GenerateOptions {
  /** Override defaultModel. When set, fallback cascade is disabled. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

interface TryResult {
  success: true;
  text: string;
  model: string;
}

interface TryError {
  success: false;
  error: string;
  model: string;
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Generate text using an OpenAI-compatible LLM backend.
 *
 * Model cascade:
 *   opts.model → backend.defaultModel → fallbackModels[0] → fallbackModels[1] → …
 *   When opts.model is set, no fallback is attempted.
 *
 * Returns null if all models fail.
 */
export async function generateText(
  backend: LLMBackend,
  prompt: string,
  opts: GenerateOptions = {},
): Promise<string | null> {
  const models = opts.model
    ? [opts.model]
    : [backend.defaultModel, ...(backend.fallbackModels ?? [])];

  let lastError = "";

  for (const model of models) {
    const result = await tryGenerate(backend, model, prompt, opts);
    if (result.success) return result.text;
    lastError = result.error;
  }

  // All models failed
  const modelList = models.join(", ");
  console.error(`[LLM] All models failed (${modelList}): ${lastError}`);
  return null;
}

// ── Internal ──────────────────────────────────────────────────────

async function tryGenerate(
  backend: LLMBackend,
  model: string,
  prompt: string,
  opts: GenerateOptions,
): Promise<TryResult | TryError> {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? backend.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (backend.apiKey) {
      headers.Authorization = `Bearer ${backend.apiKey}`;
    }

    const res = await fetch(`${backend.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: opts.temperature ?? 0.1,
        max_tokens: opts.maxTokens ?? 256,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return { success: false, error: `HTTP ${res.status}`, model };
    }

    const data = await res.json();
    const text: string | undefined = data.choices?.[0]?.message?.content;

    if (!text) {
      return { success: false, error: "empty response", model };
    }

    return { success: true, text, model };
  } catch (err) {
    const reason =
      err instanceof DOMException && err.name === "AbortError"
        ? "timeout"
        : err instanceof Error
          ? err.message
          : String(err);
    return { success: false, error: reason, model };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Quality heuristics — regex-based first-pass gate.
 * Cheap, deterministic filters that catch ~70% of garbage.
 *
 * Design principles:
 *   - Match CATEGORIES of system noise, not exact phrasing from specific tools.
 *     Bracketed annotations like [System...], [Note:...], [CONTEXT...] are
 *     universal across Hermes, Claude Code, Cursor, etc.
 *   - No locale-specific patterns. Language detection belongs in offTopicPatterns
 *     config, not in source.
 *   - Emoji detection uses alphanumeric ratio, not unicode range enumeration.
 */

export interface HeuristicReport {
  passed: boolean;
  rejectReason?: string;
  scores: {
    contentQuality: number;    // 0-1 based on length, structure
    coherence: number;         // 0-1 based on prompt↔response ratio
    noSystemNoise: number;     // 0-1 — 0 = full of system noise
  };
}

// ── System noise — bracket-annotation patterns ──────────────────────────

/** [CONTEXT COMPACTION ...], [CONTEXT RESTORED ...], etc. */
const BRACKET_CONTEXT = /\[CONTEXT\b/i;

/** [System note: ...], [System prompt: ...], [Note: model was ...] */
const BRACKET_SYSTEM = /\[(System(?: note| prompt)?|Note):/i;

/** [IMPORTANT: Background process ...] */
const BRACKET_IMPORTANT = /\[IMPORTANT:/i;

/** Hermes "you executed tool calls but returned nothing" / "max iterations" */
const TOOL_LOOP_MESSAGE = /(returned an empty response|maximum number of tool-calling iterations)/i;

/** Cronjob/task output headers */
const CRON_LABEL = /^(Cronjob|Task)\s+(Response|Output):/im;

// ── Content emptiness ────────────────────────────────────────────────────

/**
 * Response is primarily non-alphanumeric (emoji, symbols).
 * Detects emoji-only without enumerating unicode ranges.
 */
function isEmojiGarbage(text: string): boolean {
  const alphanumeric = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  return text.length > 0 && alphanumeric / text.length < 0.05;
}

// ── Evaluation ──────────────────────────────────────────────────────────

export function evaluateHeuristics(
  prompt: string,
  response: string,
  offTopicPatterns?: RegExp[],
): HeuristicReport {
  const report: HeuristicReport = {
    passed: true,
    scores: { contentQuality: 1, coherence: 1, noSystemNoise: 1 },
  };

  // ── 1. System noise detection ──
  const systemPatterns: Array<{ re: RegExp; label: string }> = [
    { re: BRACKET_CONTEXT, label: "context bracket" },
    { re: BRACKET_SYSTEM, label: "system bracket" },
    { re: BRACKET_IMPORTANT, label: "important bracket" },
    { re: TOOL_LOOP_MESSAGE, label: "tool loop message" },
    { re: CRON_LABEL, label: "cron label" },
  ];

  for (const { re, label } of systemPatterns) {
    if (re.test(prompt) || re.test(response)) {
      report.scores.noSystemNoise = 0;
      report.rejectReason = `system noise: ${label}`;
      report.passed = false;
      return report;
    }
  }

  // ── 2. Content emptiness ──
  const cleanResponse = response.trim();

  if (cleanResponse.length === 0) {
    report.scores.contentQuality = 0;
    report.rejectReason = "empty response";
    report.passed = false;
    return report;
  }

  if (isEmojiGarbage(cleanResponse)) {
    report.scores.contentQuality = 0;
    report.rejectReason = "emoji-only response";
    report.passed = false;
    return report;
  }

  // ── 3. Off-topic detection (configurable per-locale) ──
  if (offTopicPatterns && offTopicPatterns.some((re) => re.test(prompt + " " + cleanResponse))) {
    report.scores.contentQuality = 0.2;
    report.rejectReason = "off-topic (non-technical)";
    report.passed = false;
    return report;
  }

  // Very short non-technical responses (likely acknowledgments).
  // Locale-specific ack patterns belong in offTopicPatterns config,
  // but < 50 chars with no code blocks is a strong universal signal.
  if (cleanResponse.length < 50 && !cleanResponse.includes("```")) {
    report.scores.contentQuality = 0.1;
    report.rejectReason = "too short, no code";
    report.passed = false;
    return report;
  }

  // ── 4. Coherence scoring ──
  const promptLen = prompt.trim().length;
  const responseLen = cleanResponse.length;

  if (promptLen < 20 && responseLen > 200) {
    report.scores.coherence = 0.9;
  } else if (promptLen > 500 && responseLen < 80) {
    report.scores.coherence = 0.3;
  } else if (Math.abs(promptLen - responseLen) < 200) {
    report.scores.coherence = 0.8;
  } else {
    report.scores.coherence = 0.6;
  }

  // ── 5. Content quality scoring ──
  const codeBlockCount = (cleanResponse.match(/```/g) || []).length / 2;
  if (codeBlockCount > 0) {
    report.scores.contentQuality = Math.min(1, 0.5 + codeBlockCount * 0.25);
  } else if (responseLen > 200) {
    report.scores.contentQuality = 0.7;
  } else if (responseLen > 80) {
    report.scores.contentQuality = 0.5;
  } else {
    report.scores.contentQuality = 0.3;
  }

  return report;
}

/**
 * Quality heuristics — regex-based first-pass gate.
 * Cheap, deterministic filters that catch ~70% of garbage.
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

// Context compaction patterns — these are Hermes/Claude Code system summaries
const CONTEXT_COMPACTION = /\[CONTEXT COMPACTION\s*[—–-]\s*REFERENCE ONLY\]/i;
const SYSTEM_NOTE = /\[Note:\s*model was just switched/i;
const BACKGROUND_PROCESS = /\[IMPORTANT:\s*Background process/i;
const SYSTEM_PROMPT = /\[System note:/i;
const TOOL_CALL_EMPTY = /You just executed tool calls but returned an empty response/i;
const MAX_ITERATIONS = /You've reached the maximum number of tool-calling iterations/i;
const CRON_RESPONSE = /Cronjob Response:/i;

// Emoji-only or near-empty responses
const EMOJI_ONLY = /^[\s\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}✅❌👍👎🙏💻]*$/u;

/** Response that's just an acknowledgment */
const ACK_ONLY = /^(ok|okay|tak|nie|gotowe|done|spoko|pewnie|jasne)[!.\s]*$/i;

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
  const systemPatterns = [
    { re: CONTEXT_COMPACTION, label: "context compaction" },
    { re: SYSTEM_NOTE, label: "model switch" },
    { re: BACKGROUND_PROCESS, label: "background process" },
    { re: SYSTEM_PROMPT, label: "system prompt" },
    { re: TOOL_CALL_EMPTY, label: "empty tool call" },
    { re: MAX_ITERATIONS, label: "max iterations" },
    { re: CRON_RESPONSE, label: "cron response" },
  ];

  for (const { re, label } of systemPatterns) {
    if (re.test(prompt) || re.test(response)) {
      report.scores.noSystemNoise = 0;
      report.rejectReason = `system noise: ${label}`;
      report.passed = false;
      return report;
    }
  }

  // ── 2. Content quality (length-based) ──
  const cleanResponse = response.trim();

  if (cleanResponse.length === 0) {
    report.scores.contentQuality = 0;
    report.rejectReason = "empty response";
    report.passed = false;
    return report;
  }

  if (cleanResponse.length < 50) {
    report.scores.contentQuality = 0.1;
    if (ACK_ONLY.test(cleanResponse)) {
      report.rejectReason = "acknowledgement only";
      report.passed = false;
      return report;
    }
  }

  if (EMOJI_ONLY.test(cleanResponse)) {
    report.scores.contentQuality = 0;
    report.rejectReason = "emoji-only response";
    report.passed = false;
    return report;
  }

  // ── 3. Off-topic detection (configurable patterns) ──
  // Off-topic patterns are locale-specific and MUST be configured per-user
  // via the plugin config, NOT hardcoded in source. See DataCuratorConfig.
  if (offTopicPatterns && offTopicPatterns.some((re) => re.test(prompt + " " + cleanResponse))) {
    report.scores.contentQuality = 0.2;
    report.rejectReason = "off-topic (non-technical)";
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

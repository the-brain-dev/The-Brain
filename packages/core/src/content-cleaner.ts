/**
 * ContentCleaner — extracts signal from raw the-brain memory content.
 *
 * Raw memory content from Claude Code harvesters is mostly XML-wrapped
 * observations. This module strips the noise and returns compact,
 * context-worthy summaries.
 *
 * Content types detected:
 *   - claude-observation: <observed_from_primary_session> XML
 *   - user-request: contains <user_request> — highest signal
 *   - progress-summary: checkpoint summaries
 *   - other: plain text (truncate)
 */

export interface CleanedContent {
  /** One-line summary for context injection (max ~120 chars) */
  summary: string;
  /** What actually happened (action + target) */
  action: string;
  /** Project/working directory extracted */
  project: string | null;
  /** The user's actual request (if present) */
  userRequest: string | null;
  /** Content type for formatting */
  type: "observation" | "user-request" | "progress" | "unknown";
}

/**
 * Clean a raw memory content string into a structured summary.
 */
export function cleanMemoryContent(raw: string): CleanedContent {
  if (!raw) {
    return { summary: "(empty)", action: "unknown", project: null, userRequest: null, type: "unknown" };
  }

  // Strip the "Prompt: " prefix that Claude harvester prepends
  let content = raw.replace(/^Prompt:\s*/i, "").trim();

  // ── User Request (highest signal) ──────────────────────
  const userReqMatch = content.match(/<user_request>([\s\S]*?)<\/user_request>/i);
  if (userReqMatch) {
    const req = userReqMatch[1].trim().replace(/\s+/g, " ").slice(0, 150);
    const wd = extractWorkingDir(content);

    return {
      summary: `🗣 User asked: ${req}`,
      action: "user-request",
      project: extractProjectName(wd),
      userRequest: req,
      type: "user-request",
    };
  }

  // ── Claude Observation XML ─────────────────────────────
  const whatHappened = content.match(/<what_happened>([\s\S]*?)<\/what_happened>/i);
  if (whatHappened) {
    const action = whatHappened[1].trim();
    const wd = extractWorkingDir(content);
    const project = extractProjectName(wd);

    // Parse parameters for richer context
    const params = extractParams(content);

    return {
      summary: buildObservationSummary(action, project, params),
      action,
      project,
      userRequest: null,
      type: "observation",
    };
  }

  // ── Progress Summary ───────────────────────────────────
  if (content.includes("PROGRESS SUMMARY") || content.includes("CHECKPOINT")) {
    const firstLine = content.split("\n").find(l => l.trim().length > 10)?.trim() || content;
    return {
      summary: `📋 Progress: ${firstLine.slice(0, 100)}`,
      action: "checkpoint",
      project: null,
      userRequest: null,
      type: "progress",
    };
  }

  // ── Claude-Mem observer preamble ───────────────────────
  if (content.includes("Claude-Mem") || content.includes("specialized observer")) {
    // Skip these — they're system prompts, not actual interactions
    return {
      summary: "(observer preamble — skipped)",
      action: "system",
      project: null,
      userRequest: null,
      type: "unknown",
    };
  }

  // ── Raw XML / function_calls (without Claude wrapper) ──
  // Claude Code sometimes emits raw <function_calls>, <invoke>, <parameter>
  // blocks without the <observed_from_primary_session> wrapper.
  // Strip all XML tags and keep only the user-authored plain text.
  if (/<function_calls>|<invoke\b|<parameter\b|<tool_call>|<tool_result>/i.test(content)) {
    const stripped = stripXmlTags(content);
    if (stripped.trim().length > 5) {
      return {
        summary: stripped.trim().slice(0, 120),
        action: "xml-stripped",
        project: extractProjectName(extractWorkingDir(content)),
        userRequest: null,
        type: "unknown",
      };
    }
  }

  // ── Fallback: truncate ─────────────────────────────────
  const clean = content.replace(/\s+/g, " ").trim().slice(0, 120);
  return {
    summary: clean,
    action: "unknown",
    project: null,
    userRequest: null,
    type: "unknown",
  };
}

/**
 * Clean a graph node label — strip code fragments, keep concepts.
 */
export function cleanGraphNodeLabel(label: string, type: string): string {
  if (!label) return "";

  // Code fragments (corrections often contain code)
  if (type === "correction" && label.length > 60) {
    // Try to extract the "lesson" — usually the key phrase
    const short = label.replace(/\\\\n/g, " ").replace(/\s+/g, " ").trim();
    // Take first sentence-like chunk (Unicode-aware punctuation)
    const sentence = short.split(/[.;。！？]\s+/)[0];
    if (sentence && sentence.length > 10 && sentence.length < 120) {
      return sentence;
    }
    return short.slice(0, 100);
  }

  // Concept/preference/pattern — already clean
  return label.replace(/\\\\n/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Deduplicate cleaned contents — keep the one with highest signal.
 * Returns deduplicated list, preserving order by signal quality.
 */
export function deduplicateContents(items: CleanedContent[]): CleanedContent[] {
  const seen = new Map<string, CleanedContent>();

  for (const item of items) {
    const key = item.summary.slice(0, 60); // Use first 60 chars as dedup key

    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, item);
      continue;
    }

    // Keep the one with higher signal type
    const typeRank: Record<string, number> = {
      "user-request": 4,
      "progress": 3,
      "observation": 2,
      "unknown": 1,
    };

    const newRank = typeRank[item.type] || 0;
    const oldRank = typeRank[existing.type] || 0;

    if (newRank > oldRank) {
      seen.set(key, item);
    }
  }

  return Array.from(seen.values());
}

// ── Private helpers ────────────────────────────────────────

/**
 * Strip XML tags and their content from raw text, keeping only
 * plain text that falls outside any XML element.
 *
 * Used as a fallback when raw <function_calls> / <invoke> blocks
 * appear without the expected <observed_from_primary_session> wrapper.
 *
 * Strategy: remove everything between matching <tag>...</tag> pairs
 * (including nested tags), then clean up whitespace.
 *
 * Example:
 *   "<function_calls><invoke>run test</invoke></function_calls> Fix the bug"
 *   → "Fix the bug"
 */
function stripXmlTags(text: string): string {
  // Two-pass approach:
  // 1. Remove self-closing tags only (e.g. <br/>, <param />)
  // 2. Use a tag-depth counter: when depth > 0, skip ALL characters
  //    until we pop back to depth 0. This removes both tags AND
  //    their content (e.g. "npm test" inside <parameter>...</parameter>).

  let result = "";
  let depth = 0;
  let i = 0;

  while (i < text.length) {
    // Check for tag boundary
    if (text[i] === "<") {
      const close = text.indexOf(">", i);
      if (close === -1) {
        // Unclosed tag — treat rest as text
        if (depth === 0) result += text.slice(i);
        break;
      }

      const tag = text.slice(i, close + 1);
      const isClosing = tag.startsWith("</");
      const isSelfClosing = tag.endsWith("/>");

      if (isSelfClosing) {
        // Self-closing: skip it entirely, stays at current depth
        i = close + 1;
        continue;
      }

      if (isClosing) {
        depth = Math.max(0, depth - 1);
      } else {
        depth++;
      }

      i = close + 1;
      continue;
    }

    // Regular character: only keep if we're at depth 0 (outside all tags)
    if (depth === 0) {
      result += text[i];
    }
    i++;
  }

  // Clean up
  result = result
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[\n\r]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return result;
}

function extractWorkingDir(content: string): string | null {
  const match = content.match(/<working_directory>([\s\S]*?)<\/working_directory>/i);
  if (!match) return null;
  return match[1].trim();
}

function extractProjectName(wd: string | null): string | null {
  if (!wd) return null;

  // Normalize home directory
  const normalized = wd.replace(/^\/Users\/[^/]+/, "~");
  const parts = normalized.split("/");

  // Get the last non-empty part
  let last = parts[parts.length - 1];
  if (!last && parts.length > 1) last = parts[parts.length - 2];

  // If the last segment is hidden (.hermes, .the-brain, etc.), use it as-is
  // (it's a meaningful project indicator)
  if (last && last.startsWith(".")) {
    return last;
  }

  return last || null;
}

interface ObsParams {
  filePath?: string;
  command?: string;
  pattern?: string;
  queries?: string[];
}

function extractParams(content: string): ObsParams {
  const params: ObsParams = {};

  try {
    const match = content.match(/<parameters>(.*?)<\/parameters>/is);
    if (match) {
      let raw = match[1].trim();

      // The parameters value can be:
      //   Case A: "{"command":"..."}"      — JSON string wrapped in quotes
      //   Case B: "{\"command\":\"...\"}"  — escaped JSON string (from Python repr)
      // Strip surrounding quotes if present
      if ((raw.startsWith('"') && raw.endsWith('"')) ||
          (raw.startsWith("'") && raw.endsWith("'"))) {
        raw = raw.slice(1, -1);
      }

      // Try direct parse first (Case A: already valid JSON)
      let parsed: any = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Case B: try unescaping literal backslash-quotes
        const unescaped = raw.replace(/\\"/g, '"').replace(/\\'/g, "'");
        try {
          parsed = JSON.parse(unescaped);
        } catch {
          // Case C: regex fallback
          const cmdMatch = raw.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (cmdMatch) params.command = cmdMatch[1].slice(0, 80);

          const fileMatch = raw.match(/"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (fileMatch) params.filePath = fileMatch[1];

          const patMatch = raw.match(/"pattern"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (patMatch) params.pattern = patMatch[1];
        }
      }

      if (parsed) {
        if (parsed.file_path) params.filePath = parsed.file_path;
        if (parsed.command) params.command = String(parsed.command).slice(0, 80);
        if (parsed.pattern) params.pattern = parsed.pattern;
        if (parsed.queries) params.queries = parsed.queries;
      }
    }
  } catch {
    // Extraction failed — return empty params
  }

  return params;
}

function buildObservationSummary(action: string, project: string | null, params: ObsParams): string {
  const projectStr = project ? ` in ${project}` : "";

  // Action mapping for readability
  const actionMap: Record<string, string> = {
    "Bash": "💻",
    "Edit": "✏️",
    "Read": "📖",
    "Grep": "🔍",
    "Write": "💾",
    "TaskUpdate": "📋",
    "TodoWrite": "✅",
  };

  const emoji = actionMap[action] || "•";

  // Build rich summary
  if (action === "Bash" && params.command) {
    return `${emoji} Ran: \`${params.command.slice(0, 60)}\`${projectStr}`;
  }

  if ((action === "Edit" || action === "Write") && params.filePath) {
    const file = params.filePath.split("/").pop() || params.filePath;
    return `${emoji} Edited \`${file}\`${projectStr}`;
  }

  if (action === "Read" && params.filePath) {
    const file = params.filePath.split("/").pop() || params.filePath;
    return `${emoji} Read \`${file}\`${projectStr}`;
  }

  if (action === "Grep" && params.pattern) {
    return `${emoji} Grepped for "${params.pattern}"${projectStr}`;
  }

  if (action.startsWith("mcp__")) {
    const toolName = action.replace("mcp__", "").replace(/_/g, " ");
    return `🔧 MCP: ${toolName}${projectStr}`;
  }

  return `${emoji} ${action}${projectStr}`;
}

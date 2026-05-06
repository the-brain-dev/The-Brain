import { describe, test, expect } from "bun:test";
import {
  cleanMemoryContent,
  cleanGraphNodeLabel,
  deduplicateContents,
} from "../content-cleaner";
import type { CleanedContent } from "../content-cleaner";

describe("ContentCleaner", () => {
  // ── cleanMemoryContent ────────────────────────────────

  describe("cleanMemoryContent", () => {
    test("extracts user request from Claude observation", () => {
      const raw = `Prompt: Hello memory agent, you are continuing to observe the primary Claude session.

<observed_from_primary_session>
  <user_request> Can you run gbrain doctor? Also check what it is online</user_request>
  <requested_at>2026-04-22</requested_at>
</observed_from_primary_session>`;

      const result = cleanMemoryContent(raw);

      expect(result.type).toBe("user-request");
      expect(result.summary).toContain("User asked");
      expect(result.summary).toContain("gbrain doctor");
      expect(result.userRequest).toContain("gbrain doctor");
    });

    test("handles Polish user requests", () => {
      const raw = `Prompt: <observed_from_primary_session>
  <user_request>Czy możesz odpalić gbrain doctor</user_request>
  <requested_at>2026-04-22</requested_at>
</observed_from_primary_session>`;

      const result = cleanMemoryContent(raw);

      expect(result.type).toBe("user-request");
      expect(result.summary).toContain("Czy możesz odpalić");
    });

    test("extracts Bash observation with command", () => {
      const raw = `Prompt: <observed_from_primary_session>
  <what_happened>Bash</what_happened>
  <occurred_at>2026-04-22T14:23:32.515Z</occurred_at>
  <working_directory>/Users/oskarschachta/gbrain</working_directory>
  <parameters>"{"command":"~/.bun/bin/bun gbrain doctor"}"</parameters>
</observed_from_primary_session>`;

      const result = cleanMemoryContent(raw);

      expect(result.type).toBe("observation");
      expect(result.action).toBe("Bash");
      expect(result.project).toBe("gbrain");
      expect(result.summary).toContain("Ran:");
      expect(result.summary).toContain("gbrain");
    });

    test("extracts Edit observation with file path", () => {
      const raw = `Prompt: <observed_from_primary_session>
  <what_happened>Edit</what_happened>
  <occurred_at>2026-04-21T12:55:59.935Z</occurred_at>
  <working_directory>/Users/oskarschachta/.hermes</working_directory>
  <parameters>"{"file_path":"/Users/oskarschachta/.hermes/skills/the-brain/SKILL.md"}"</parameters>
</observed_from_primary_session>`;

      const result = cleanMemoryContent(raw);

      expect(result.type).toBe("observation");
      expect(result.action).toBe("Edit");
      expect(result.summary).toContain("Edited");
      expect(result.summary).toContain("SKILL.md");
    });

    test("extracts project name from working directory", () => {
      const raw = `Prompt: <observed_from_primary_session>
  <what_happened>Read</what_happened>
  <working_directory>/Users/oskarschachta/Projects/Private/heycoco</working_directory>
  <parameters>"{"file_path":"/Users/oskarschachta/Projects/Private/heycoco/src/app.ts"}"</parameters>
</observed_from_primary_session>`;

      const result = cleanMemoryContent(raw);

      expect(result.project).toBe("heycoco");
      expect(result.summary).toContain("heycoco");
    });

    test("handles hidden directory project names", () => {
      const raw = `Prompt: <observed_from_primary_session>
  <what_happened>Edit</what_happened>
  <working_directory>/Users/oskarschachta/.hermes</working_directory>
</observed_from_primary_session>`;

      const result = cleanMemoryContent(raw);

      // .hermes is hidden but meaningful — should be kept
      expect(result.project).toBe(".hermes");
    });

    test("extracts MCP tool calls", () => {
      const raw = `Prompt: <observed_from_primary_session>
  <what_happened>mcp__serena__find_file</what_happened>
  <working_directory>/Users/oskarschachta/Projects/Private/heycoco</working_directory>
</observed_from_primary_session>`;

      const result = cleanMemoryContent(raw);

      expect(result.action).toBe("mcp__serena__find_file");
      expect(result.summary).toContain("MCP:");
      expect(result.summary).toContain("heycoco");
    });

    test("extracts Grep with pattern", () => {
      const raw = `Prompt: <observed_from_primary_session>
  <what_happened>Grep</what_happened>
  <working_directory>/Users/oskarschachta/Projects/Private/heycoco</working_directory>
  <parameters>"{"pattern":"useState"}"</parameters>
</observed_from_primary_session>`;

      const result = cleanMemoryContent(raw);

      expect(result.action).toBe("Grep");
      expect(result.summary).toContain("useState");
    });

    test("skips Claude-Mem observer preamble", () => {
      const raw = `Prompt: You are a Claude-Mem, a specialized observer tool for creating searchable memory FOR FUTURE SESSIONS.

CRITICAL: Record what was LEARNED/BUILT/FIXED/DEPLOYED/CONFIGURED, not what you (the observer) are doing.`;

      const result = cleanMemoryContent(raw);

      expect(result.type).toBe("unknown");
      expect(result.summary).toContain("skipped");
    });

    test("detects progress summaries", () => {
      const raw = `Prompt: PROGRESS SUMMARY CHECKPOINT
===========================
Write progress notes of what was done, what was learned, and what's next. This is a checkpoint to capture progress so far.`;

      const result = cleanMemoryContent(raw);

      expect(result.type).toBe("progress");
      expect(result.summary).toContain("Progress:");
    });

    test("truncates plain text content", () => {
      const raw = "This session is being continued from a previous conversation that ran out of context. The summary below covers...";

      const result = cleanMemoryContent(raw);

      expect(result.type).toBe("unknown");
      expect(result.summary.length).toBeLessThanOrEqual(125);
    });

    test("handles empty content", () => {
      const result = cleanMemoryContent("");

      expect(result.summary).toBe("(empty)");
      expect(result.type).toBe("unknown");
    });

    test("strips raw <function_calls> XML without Claude wrapper", () => {
      const raw = `<function_calls>
<invoke name="read_file">
<parameter name="path">src/index.ts</parameter>
</invoke>
</function_calls>
Actually, let me refactor this to use dependency injection instead.`;

      const result = cleanMemoryContent(raw);

      // XML tags should be stripped
      expect(result.summary).not.toContain("<function_calls>");
      expect(result.summary).not.toContain("<invoke");
      // User-authored text should survive
      expect(result.summary).toContain("dependency injection");
      expect(result.action).toBe("xml-stripped");
    });

    test("strips raw <tool_call> blocks and keeps user text", () => {
      const raw = `<tool_call name="bash">
<parameter name="command">npm test</parameter>
</tool_call>
The tests passed but we should also add integration tests.`;

      const result = cleanMemoryContent(raw);

      expect(result.summary).not.toContain("tool_call");
      expect(result.summary).not.toContain("npm test");
      expect(result.summary).toContain("integration tests");
    });

    test("strips XML but preserves meaningful user intent", () => {
      const raw = `<function_calls>
<invoke name="terminal">
<parameter name="command">npm install</parameter>
</invoke>
</function_calls>
Actually, change of plans — let's use pnpm instead.`;

      const result = cleanMemoryContent(raw);

      expect(result.summary).toContain("pnpm");
      expect(result.summary).not.toContain("npm install");
      expect(result.summary).not.toContain("function_calls");
    });

    // ── NEW: Edge cases for uncovered lines ─────────────

    test("strips XML but falls back to truncation when stripped text too short", () => {
      const raw = `<function_calls>\n<invoke name="ls"/>\n</function_calls>`;
      const result = cleanMemoryContent(raw);

      // All content inside XML tags — stripped result is empty, falls through to truncation
      // Truncation wraps the raw text (including XML) — summary is raw input, not xml-stripped
      expect(result.type).toBe("unknown");
      expect(result.summary.length).toBeLessThanOrEqual(120);
    });
    

    test("handles self-closing XML tags via stripXmlTags", () => {
      const raw = `<tool_call name="bash">\n<parameter name="cwd" value="/tmp"/>\n</tool_call>\nThe build succeeded.`;
      const result = cleanMemoryContent(raw);

      expect(result.summary).toContain("build succeeded");
      expect(result.action).toBe("xml-stripped");
    });

    test("handles unclosed XML tags gracefully (fallback to text)", () => {
      const raw = `<function_calls>\n<invoke name="broken">\nMissing closing tag\nStill processing`;
      const result = cleanMemoryContent(raw);

      // Unclosed tags: depth > 0 at break → text inside tags is lost
      // Stripped result too short → falls through to truncation
      expect(result.type).toBe("unknown");
    });

    test("extracts params from escaped JSON (Case B — literal backslash-quotes)", () => {
      const raw = `<observed_from_primary_session>
  <what_happened>Write</what_happened>
  <working_directory>/Users/oskarschachta/Projects/my-app</working_directory>
  <parameters>"{\\"file_path\\":\\"/src/utils.ts\\",\\"command\\":\\"write\\"}"</parameters>
</observed_from_primary_session>`;

      const result = cleanMemoryContent(raw);
      expect(result.type).toBe("observation");
      expect(result.summary).toContain("utils.ts");
    });

    test("extracts params via regex fallback for malformed JSON (Case C)", () => {
      const raw = `<observed_from_primary_session>
  <what_happened>Bash</what_happened>
  <working_directory>/Users/oskarschachta/Projects/my-app</working_directory>
  <parameters>"{\\"command\\": \\"npm run build && test\\" --verbose}"</parameters>
</observed_from_primary_session>`;

      const result = cleanMemoryContent(raw);
      expect(result.type).toBe("observation");
      expect(result.action).toBe("Bash");
    });
  });

  // ── cleanGraphNodeLabel ────────────────────────────────

  describe("cleanGraphNodeLabel", () => {
    test("trims long code-fragment corrections", () => {
      const label = `This is enforced both at\\\\n   * a type-level and at runtime.\\\\n   */\\\\n  clientPrefix: 'PUBLIC_'`;

      const result = cleanGraphNodeLabel(label, "correction");

      expect(result.length).toBeLessThan(label.length);
      expect(result).toContain("type-level");
    });

    test("keeps short concept labels intact", () => {
      const result = cleanGraphNodeLabel("Works frequently with tailwind", "pattern");
      expect(result).toBe("Works frequently with tailwind");
    });

    test("keeps short preference labels intact", () => {
      const result = cleanGraphNodeLabel("Uses const not let", "preference");
      expect(result).toBe("Uses const not let");
    });

    test("handles escaped newlines", () => {
      const result = cleanGraphNodeLabel("Line 1\\\\nLine 2\\\\nLine 3", "concept");

      expect(result).not.toContain("\\\\n");
      expect(result).toContain("Line 1 Line 2 Line 3");
    });

    // ── NEW: sentence extraction from long corrections ──

    test("extracts first sentence from long correction with period", () => {
      const label =
        "Use process.env.HOME || homedir() instead of raw homedir() in Bun tests. This avoids the Bun test runner bug.";

      const result = cleanGraphNodeLabel(label, "correction");
      expect(result).toContain("Use process.env.HOME");
      expect(result).not.toContain("This avoids");
    });

    test("extracts first sentence from long correction with semicolon", () => {
      const label =
        "Always batch insert memories; this improves performance 100x; also useful for transactions";

      const result = cleanGraphNodeLabel(label, "correction");
      expect(result).toContain("Always batch insert");
      expect(result).not.toContain("100x");
    });

    test("falls back to 100-char truncation for long correction with no break", () => {
      const label = Array(200).fill("continuous text without periods or semicolons").join(" ");
      const result = cleanGraphNodeLabel(label, "correction");
      expect(result.length).toBeLessThanOrEqual(100);
    });
  });

  // ── deduplicateContents ────────────────────────────────

  describe("deduplicateContents", () => {
    test("keeps highest-signal version of duplicate content", () => {
      const items: CleanedContent[] = [
        {
          summary: "✏️ Edited `SKILL.md` in .hermes",
          action: "Edit",
          project: ".hermes",
          userRequest: null,
          type: "observation",
        },
        {
          summary: "✏️ Edited `SKILL.md` in .hermes",
          action: "Edit",
          project: ".hermes",
          userRequest: "update the the-brain skill",
          type: "user-request",
        },
      ];

      const deduped = deduplicateContents(items);

      expect(deduped.length).toBe(1);
      expect(deduped[0].type).toBe("user-request");
    });

    test("preserves unique items", () => {
      const items: CleanedContent[] = [
        {
          summary: "💻 Ran command in gbrain",
          action: "Bash",
          project: "gbrain",
          userRequest: null,
          type: "observation",
        },
        {
          summary: "✏️ Edited file in heycoco",
          action: "Edit",
          project: "heycoco",
          userRequest: null,
          type: "observation",
        },
        {
          summary: "🔍 Grepped in the-brain",
          action: "Grep",
          project: "the-brain",
          userRequest: null,
          type: "observation",
        },
      ];

      const deduped = deduplicateContents(items);

      expect(deduped.length).toBe(3);
    });
  });
});

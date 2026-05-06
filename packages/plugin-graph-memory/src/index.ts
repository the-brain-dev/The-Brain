import {
  definePlugin,
  HookEvent,
  BrainDB,
  MemoryLayer,
  type PluginDefinition,
  type PluginHooks,
  type PromptContext,
  type GraphNodeRecord,
} from "@the-brain/core";

// ── Configuration ────────────────────────────────────────────────

export interface GraphMemoryOptions {
  /** Maximum graph nodes to inject as context per prompt (default: 8) */
  maxInjectNodes?: number;
  /** Minimum node weight to be considered relevant (default: 0.3) */
  minWeight?: number;
  /** Whether to include connected (1-hop) nodes in context (default: true) */
  includeConnected?: boolean;
  /** Maximum connected nodes to follow per matched node (default: 3) */
  maxConnectedPerNode?: number;
  /** Maximum connected nodes to inject total (default: same as maxInjectNodes) */
  maxConnectedInject?: number;
  /** Number of recent interactions to keep in memory for pattern detection (default: 20) */
  recentInteractionLimit?: number;
  /** Weight boost for a node each time it's matched in a prompt (default: 0.05) */
  weightBoostOnMatch?: number;
  /** Weight decay factor applied to old nodes that haven't been matched recently (default: 0.98) */
  weightDecayFactor?: number;
  /** Minimum word length for keyword extraction from prompts (default: 3) */
  minKeywordLength?: number;
}

const DEFAULTS: Required<GraphMemoryOptions> = {
  maxInjectNodes: 8,
  minWeight: 0.3,
  includeConnected: true,
  maxConnectedPerNode: 3,
  maxConnectedInject: 4,
  recentInteractionLimit: 20,
  weightBoostOnMatch: 0.05,
  weightDecayFactor: 0.98,
  minKeywordLength: 3,
};

// ── Stop words for keyword extraction ───────────────────────────
// Removed English stop-words. Tokenizer now uses Unicode-aware
// word boundary detection — works for any language.
// TF-IDF naturally suppresses high-frequency tokens.

// ── Language-agnostic correction detection ─────────────────────
// Replaces English regex patterns with structural heuristics
// that work across all languages.

interface CorrectionSignal {
  snippet: string;
  weight: number;
}

/**
 * Detect corrections using language-agnostic structural heuristics.
 *
 * Heuristics (no regex, no English assumptions):
 *   1. Short prompt + long explanatory response (ratio > 2.5:1)
 *      → "fix this" → detailed explanation → correction
 *   2. Very short prompt (< 50 chars) + substantial response (> 100 chars)
 *      → terse correction command → correction
 *   3. Response contains significantly more unique tokens than prompt
 *      → introduces new concepts/terminology → likely correction or new info
 *   4. Prompt is mostly unknown tokens (novelty spike)
 *      → user suddenly using different vocabulary → potential correction
 */
function detectCorrections(
  prompt: string,
  response: string,
): CorrectionSignal[] {
  const results: CorrectionSignal[] = [];
  const promptLen = prompt.trim().length;
  const responseLen = response.trim().length;

  if (promptLen === 0 || responseLen === 0) return results;

  const ratio = responseLen / promptLen;

  // Heuristic 1: Response significantly longer than prompt
  if (ratio > 2.5) {
    const firstSentence = extractFirstSentence(response);
    results.push({
      snippet: firstSentence,
      weight: clamp(0.55 + ratio * 0.03, 0.6, 0.85),
    });
  }
  // Heuristic 2: Very short prompt + substantial response
  else if (promptLen < 50 && responseLen > 100) {
    results.push({
      snippet: response.slice(0, 120).trim(),
      weight: 0.65,
    });
  }

  // Heuristic 3: Lexical novelty — response has many tokens not in prompt
  const promptTokens = tokenize(prompt);
  const responseTokens = tokenize(response);
  const promptTokenSet = new Set(promptTokens.map((t) => t.toLowerCase()));
  const novelTokens = responseTokens.filter(
    (t) => t.length >= 3 && !promptTokenSet.has(t.toLowerCase()),
  );

  if (promptTokens.length > 0 && novelTokens.length / responseTokens.length > 0.5) {
    const snippet = extractFirstSentence(response);
    results.push({
      snippet,
      weight: clamp(0.4 + (novelTokens.length / responseTokens.length) * 0.3, 0.5, 0.75),
    });
  }

  return results;
}

/**
 * Detect preferences by tracking repeated content clusters across interactions.
 *
 * Instead of English regex patterns (e.g., /i prefer/i), we detect:
 *   1. Repeated short declarative statements across interactions
 *      → if user says similar things in 2+ interactions → potential preference
 *   2. Lexical overlap with previously detected preferences
 *      → content that shares vocabulary with known preference nodes
 */
function detectPreferences(
  prompt: string,
  response: string,
  recentInteractions: RecentInteraction[],
  knownPreferenceContent: Set<string>,
): Array<{ snippet: string; prefType: string }> {
  const results: Array<{ snippet: string; prefType: string }> = [];
  const combined = `${prompt} ${response}`;
  const tokens = tokenize(combined).map((t) => t.toLowerCase());

  // ── 1. Short declarative statements (likely preferences) ───
  const sentences = splitSentences(combined);
  for (const sentence of sentences) {
    const sLen = sentence.trim().length;
    // Short sentence (20-150 chars) — could be a preference statement
    if (sLen > 15 && sLen < 150) {
      // Check if this sentence's tokens appear in known preferences
      const sentenceTokens = tokenize(sentence).map((t) => t.toLowerCase());
      const overlap = sentenceTokens.filter((t) =>
        t.length >= 3 && knownPreferenceContent.has(t),
      );

      if (overlap.length >= 2 || knownPreferenceContent.size === 0) {
        results.push({
          snippet: sentence.trim(),
          prefType: knownPreferenceContent.size > 0 ? "reinforced" : "candidate",
        });
      }
    }
  }

  // ── 2. Repeated themes across recent interactions ──────────
  if (recentInteractions.length >= 2) {
    const recentContent = recentInteractions
      .map((ri) => tokenize(`${ri.prompt} ${ri.response}`).map((t) => t.toLowerCase()))
      .flat();

    const repeatedTokens = tokens.filter(
      (t) => t.length >= 3 && recentContent.filter((rc) => rc === t).length >= 2,
    );

    if (repeatedTokens.length >= 3) {
      const snippet = combined.slice(0, 150).trim();
      results.push({ snippet, prefType: "repeated" });
    }
  }

  return results;
}

// ── In-memory interaction ring buffer ────────────────────────────

interface RecentInteraction {
  id: string;
  timestamp: number;
  prompt: string;
  response: string;
  matchedNodeIds: string[];
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Unicode-aware tokenizer — splits on non-letter characters (works for
 * all languages: Polish, Chinese, Japanese, Arabic, etc.)
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = "";

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    // Match letters (any script), numbers, and underscores
    if (
      (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") ||
      (ch >= "0" && ch <= "9") || ch === "_" ||
      ch >= "\u00C0" // Latin-1 Supplement + all higher Unicode letters
    ) {
      current += ch;
    } else {
      if (current.length >= 2) tokens.push(current);
      current = "";
    }
  }
  if (current.length >= 2) tokens.push(current);

  return tokens;
}

/**
 * Extract the first sentence from text using Unicode-aware punctuation.
 * Works with ., !, ?, 。(CJK), etc.
 */
function extractFirstSentence(text: string): string {
  const trimmed = text.trim();
  // Try Unicode-aware sentence boundary: .!? followed by space or end
  const match = trimmed.match(/^(.+?[.!?。！？](?=\s|$))/);
  if (match) return match[1].trim();

  // If no sentence-ending punctuation found, take first 120 chars
  return trimmed.slice(0, 120).trim();
}

/**
 * Split text into sentences using Unicode-aware punctuation.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s+/)
    .filter((s) => s.trim().length > 0);
}

function extractKeywords(text: string, minLength: number): string[] {
  const tokens = tokenize(text)
    .filter((t) => t.length >= minLength);

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const t of tokens) {
    const lower = t.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      unique.push(lower);
    }
  }
  return unique;
}

function extractCodeKeywords(text: string): string[] {
  // Extract identifiers from code-like blocks: snake_case, camelCase, PascalCase
  const identifiers: string[] = [];
  const codeBlockRegex = /```[\s\S]*?```/g;
  const inlineCodeRegex = /`([^`]+)`/g;

  const blocks = text.match(codeBlockRegex) ?? [];
  for (const block of blocks) {
    const words = block.match(/\b[a-zA-Z_][a-zA-Z0-9_]{2,}\b/g) ?? [];
    identifiers.push(...words);
  }

  let match: RegExpExecArray | null;
  while ((match = inlineCodeRegex.exec(text)) !== null) {
    const code = match[1];
    if (code.length >= 3 && /[a-zA-Z_]/.test(code)) {
      identifiers.push(code);
    }
  }

  return [...new Set(identifiers.map((w) => w.toLowerCase()))];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function generateId(): string {
  return crypto.randomUUID();
}

function detectPatterns(
  recentInteractions: RecentInteraction[],
  prompt: string,
  response: string,
): Array<{ description: string; confidence: number }> {
  const patterns: Array<{ description: string; confidence: number }> = [];

  // Look for repeated topics/concepts across recent interactions
  const allPrompts = recentInteractions.map((ri) => ri.prompt).join(" ");
  const keywords = extractKeywords(`${allPrompts} ${prompt}`, 4);

  // Count keyword frequency
  const freq = new Map<string, number>();
  for (const kw of keywords) {
    freq.set(kw, (freq.get(kw) ?? 0) + 1);
  }

  // Frequent keywords suggest emerging patterns
  for (const [kw, count] of freq) {
    if (count >= 3 && recentInteractions.length >= 3) {
      patterns.push({
        description: `Frequently discussed topic: ${kw}`,
        confidence: clamp(count / (recentInteractions.length + 1), 0.3, 0.9),
      });
    }
  }

  // Detect coding language/framework preferences from repeated mentions
  const techTerms = [
    "typescript", "javascript", "python", "rust", "go", "react",
    "next.js", "node", "bun", "sqlite", "drizzle", "prisma",
    "tailwind", "css", "html", "graphql", "rest", "docker",
  ];

  for (const term of techTerms) {
    const regex = new RegExp(`\\b${term}\\b`, "gi");
    const matches = (allPrompts + " " + prompt + " " + response).match(regex);
    if (matches && matches.length >= 2) {
      patterns.push({
        description: `Works frequently with ${term}`,
        confidence: clamp(matches.length / 10, 0.3, 0.8),
      });
    }
  }

  return patterns;
}

// ── Context formatting ───────────────────────────────────────────

function formatNodeContext(node: GraphNodeRecord): string {
  const emoji: Record<string, string> = {
    concept: "💡",
    correction: "✏️",
    preference: "⭐",
    pattern: "🔄",
  };
  return `${emoji[node.type] ?? "•"} **${node.label}** (${node.type}): ${node.content}`;
}

function formatInjectedContext(
  nodes: GraphNodeRecord[],
  connected: GraphNodeRecord[],
): string {
  const lines: string[] = [];

  if (nodes.length > 0) {
    lines.push("## Relevant Context (Graph Memory)");
    for (const node of nodes) {
      lines.push(`- ${formatNodeContext(node)}`);
    }
  }

  if (connected.length > 0) {
    lines.push("");
    lines.push("## Related Context");
    for (const node of connected) {
      lines.push(`- ${formatNodeContext(node)}`);
    }
  }

  return lines.join("\n");
}

function buildWeightedLabel(
  type: string,
  content: string,
  keywords: string[],
  maxLen = 80,
): string {
  // Create a concise label from content + keywords
  const firstSentence = content.split(/[.!?。！？]/)[0]?.trim() ?? content;
  if (firstSentence.length <= maxLen) return firstSentence;

  // Truncate intelligently
  const truncated = firstSentence.slice(0, maxLen - 3).trimEnd();
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > 0 ? truncated.slice(0, lastSpace) + "..." : truncated + "...";
}

// ── Plugin Factory ───────────────────────────────────────────────

export function createGraphMemoryPlugin(
  db: BrainDB,
  options: GraphMemoryOptions = {},
): PluginDefinition & { readonly layer: typeof MemoryLayer.INSTANT } {
  const opts: Required<GraphMemoryOptions> = { ...DEFAULTS, ...options };

  // In-memory interaction buffer for pattern detection
  const recentInteractions: RecentInteraction[] = [];

  // Track tokens from detected preferences (language-agnostic)
  const knownPreferenceContent = new Set<string>();

  function addRecentInteraction(ri: RecentInteraction): void {
    recentInteractions.push(ri);
    while (recentInteractions.length > opts.recentInteractionLimit) {
      recentInteractions.shift();
    }
  }

  return definePlugin({
    name: "@the-brain/plugin-graph-memory",
    version: "0.1.0",
    description:
      "Instant Layer plugin — creates fast relational nodes of corrections, preferences, and patterns with weighted graph connections.",

    async setup(hooks: PluginHooks): Promise<void> {
      // ── BEFORE_PROMPT: Inject relevant graph context ──────────

      hooks.hook(HookEvent.BEFORE_PROMPT, async (ctx: PromptContext) => {
        const keywords = extractKeywords(ctx.prompt, opts.minKeywordLength);
        const codeKeywords = extractCodeKeywords(ctx.prompt);
        const allKeywords = [...new Set([...keywords, ...codeKeywords])];

        if (allKeywords.length === 0) return;

        // Search for matching nodes using each keyword
        const matchedNodesMap = new Map<string, GraphNodeRecord>();
        const boostedNodeIds: string[] = [];

        for (const kw of allKeywords) {
          const results = await db.searchGraphNodes(kw);
          for (const node of results) {
            if (!matchedNodesMap.has(node.id)) {
              matchedNodesMap.set(node.id, node);
            }
          }
        }

        // Filter by minimum weight and sort by weight descending
        let matchedNodes = [...matchedNodesMap.values()]
          .filter((n) => n.weight >= opts.minWeight)
          .sort((a, b) => b.weight - a.weight);

        // Boost weights of matched nodes
        for (const node of matchedNodes) {
          boostedNodeIds.push(node.id);
          const newWeight = clamp(
            node.weight + opts.weightBoostOnMatch,
            0,
            1,
          );
          await db.upsertGraphNode({
            ...node,
            weight: newWeight,
            timestamp: Date.now(),
          });
        }

        // Limit to maxInjectNodes
        const topNodes = matchedNodes.slice(0, opts.maxInjectNodes);

        // Fetch connected nodes (1-hop neighbors)
        let connectedNodes: GraphNodeRecord[] = [];
        if (opts.includeConnected) {
          const connectedSet = new Map<string, GraphNodeRecord>();
          for (const node of topNodes) {
            const conns = await db.getConnectedNodes(node.id);
            let added = 0;
            for (const conn of conns) {
              if (
                !connectedSet.has(conn.id) &&
                !matchedNodesMap.has(conn.id) &&
                conn.weight >= opts.minWeight
              ) {
                connectedSet.set(conn.id, conn);
                added++;
                if (added >= opts.maxConnectedPerNode) break;
              }
            }
          }
          connectedNodes = [...connectedSet.values()]
            .sort((a, b) => b.weight - a.weight)
            .slice(0, opts.maxConnectedInject);
        }

        // Inject formatted context
        if (topNodes.length > 0 || connectedNodes.length > 0) {
          const contextText = formatInjectedContext(topNodes, connectedNodes);
          ctx.inject(contextText);
          ctx.metadata["graphMemory:nodeIds"] = [
            ...topNodes.map((n) => n.id),
            ...connectedNodes.map((n) => n.id),
          ];
        }

        // Track this prompt for pattern detection in AFTER_RESPONSE
        ctx.metadata["graphMemory:promptKeywords"] = allKeywords;
        ctx.metadata["graphMemory:matchedNodeIds"] = boostedNodeIds;
      });

      // ── AFTER_RESPONSE: Create/update graph nodes ─────────────

      hooks.hook(
        HookEvent.AFTER_RESPONSE,
        async (interaction: {
          id: string;
          timestamp: number;
          prompt: string;
          response: string;
          source: string;
          metadata?: Record<string, unknown>;
        }) => {
          const { prompt, response, source } = interaction;
          const matchedNodeIds: string[] =
            (interaction.metadata?.["graphMemory:matchedNodeIds"] as string[]) ?? [];
          const promptKeywords: string[] =
            (interaction.metadata?.["graphMemory:promptKeywords"] as string[]) ?? [];

          // Add to recent interaction buffer
          addRecentInteraction({
            id: interaction.id ?? generateId(),
            timestamp: interaction.timestamp ?? Date.now(),
            prompt,
            response,
            matchedNodeIds,
          });

          const now = Date.now();
          const createdNodeIds: string[] = [];

          // ── 1. Detect and store corrections ──────────────────

          const corrections = detectCorrections(prompt, response);
          for (const corr of corrections) {
            const label = buildWeightedLabel("correction", corr.snippet, promptKeywords);
            const node = await db.upsertGraphNode({
              label,
              type: "correction",
              content: corr.snippet,
              connections: matchedNodeIds.slice(0, 5),
              weight: clamp(corr.weight, 0.3, 1),
              timestamp: now,
              source,
            });
            createdNodeIds.push(node.id);
          }

          // ── 2. Detect and store preferences ──────────────────

          const preferences = detectPreferences(
            prompt, response, recentInteractions, knownPreferenceContent
          );
          for (const pref of preferences) {
            const label = buildWeightedLabel("preference", pref.snippet, promptKeywords);
            const node = await db.upsertGraphNode({
              label,
              type: "preference",
              content: pref.snippet,
              connections: matchedNodeIds.slice(0, 5),
              weight: 0.7,
              timestamp: now,
              source,
            });
            createdNodeIds.push(node.id);

            // Track preference tokens for future detection
            const prefTokens = tokenize(pref.snippet)
              .map((t) => t.toLowerCase())
              .filter((t) => t.length >= 3);
            for (const t of prefTokens) knownPreferenceContent.add(t);
          }

          // ── 3. Detect patterns from recent interactions ──────

          const patterns = detectPatterns(recentInteractions, prompt, response);
          for (const pat of patterns) {
            const label = buildWeightedLabel("pattern", pat.description, promptKeywords);

            // Deduplicate: check if a pattern with this label already exists
            const existingPatterns = await db.searchGraphNodes(pat.description);
            const existing = existingPatterns.find(
              (n) => n.type === "pattern" && n.label === label
            );

            if (existing) {
              // Update existing pattern: boost weight, update timestamp
              const newWeight = clamp(existing.weight + 0.1, 0.3, 1);
              await db.upsertGraphNode({
                id: existing.id,
                label: existing.label,
                type: "pattern",
                content: pat.description,
                connections: [...new Set([...existing.connections, ...matchedNodeIds.slice(0, 3)])],
                weight: newWeight,
                timestamp: now,
                source,
              });
              createdNodeIds.push(existing.id);
            } else {
              const node = await db.upsertGraphNode({
                label,
                type: "pattern",
                content: pat.description,
                connections: matchedNodeIds.slice(0, 5),
                weight: clamp(pat.confidence, 0.3, 1),
                timestamp: now,
                source,
              });
              createdNodeIds.push(node.id);
            }
          }

          // ── 4. Create concept nodes for new keywords ─────────

          const allKeywords = extractKeywords(
            `${prompt} ${response}`,
            opts.minKeywordLength,
          );
          const existingLabels = new Set(
            (
              await Promise.all(
                allKeywords.map((kw) => db.searchGraphNodes(kw)),
              )
            )
              .flat()
              .map((n) => n.label.toLowerCase()),
          );

          for (const kw of allKeywords.slice(0, 5)) {
            if (!existingLabels.has(kw.toLowerCase())) {
              const node = await db.upsertGraphNode({
                label: kw,
                type: "concept",
                content: `Concept referenced in interaction: ${kw}`,
                connections: createdNodeIds.slice(0, 5),
                weight: 0.4,
                timestamp: now,
                source,
              });
              createdNodeIds.push(node.id);
            }
          }

          // ── 5. Interconnect newly created nodes ──────────────

          if (createdNodeIds.length > 1) {
            for (let i = 0; i < createdNodeIds.length; i++) {
              const nodeA = await db.getGraphNode(createdNodeIds[i]);
              if (!nodeA) continue;

              for (let j = i + 1; j < createdNodeIds.length; j++) {
                const nodeB = await db.getGraphNode(createdNodeIds[j]);
                if (!nodeB) continue;

                // Add bidirectional connections if not already present
                if (!nodeA.connections.includes(nodeB.id)) {
                  nodeA.connections.push(nodeB.id);
                  await db.upsertGraphNode({
                    ...nodeA,
                    connections: nodeA.connections,
                  });
                }
                if (!nodeB.connections.includes(nodeA.id)) {
                  nodeB.connections.push(nodeA.id);
                  await db.upsertGraphNode({
                    ...nodeB,
                    connections: nodeB.connections,
                  });
                }
              }
            }
          }

          // ── 6. Apply weight decay to old, unmatched nodes ────

          // Periodically decay weights — only run every ~10 interactions
          if (recentInteractions.length % 10 === 0) {
            const highWeightNodes = await db.getHighWeightNodes(0.2);
            const oneDayAgo = now - 24 * 3600 * 1000;

            for (const node of highWeightNodes) {
              if (
                node.timestamp < oneDayAgo &&
                !recentInteractions.some((ri) =>
                  ri.matchedNodeIds.includes(node.id),
                )
              ) {
                const decayedWeight = clamp(
                  node.weight * opts.weightDecayFactor,
                  0.05,
                  1,
                );
                if (decayedWeight < node.weight) {
                  await db.upsertGraphNode({
                    ...node,
                    weight: decayedWeight,
                  });
                }
              }
            }
          }
        },
      );
    },

    teardown(): void {
      // Clear the in-memory buffer and preference cache
      recentInteractions.length = 0;
      knownPreferenceContent.clear();
    },
  }) as PluginDefinition & { readonly layer: typeof MemoryLayer.INSTANT };
}

// ── Default export for convenience ───────────────────────────────

export default createGraphMemoryPlugin;

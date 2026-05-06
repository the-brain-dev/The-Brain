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

const STOP_WORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "have", "are",
  "was", "not", "but", "you", "all", "can", "had", "her", "was", "one",
  "our", "out", "has", "his", "they", "its", "been", "some", "them",
  "who", "will", "would", "what", "when", "where", "which", "how",
  "then", "than", "just", "also", "very", "too", "into", "over",
  "such", "only", "other", "more", "new", "should", "could", "these",
  "those", "after", "about", "each", "both", "most", "make", "like",
  "being", "your", "does", "did", "done", "using", "now", "get", "got",
  "see", "use", "used", "way", "may", "need", "well", "back", "any",
  "still", "much", "really", "here", "there", "say", "said", "know",
  "think", "even", "because", "through", "before", "between", "same",
]);

// ── Correction / pattern detection keywords ─────────────────────

const CORRECTION_PATTERNS: Array<{ regex: RegExp; weight: number }> = [
  { regex: /\bno[,.\s]+actually\b/i, weight: 0.9 },
  { regex: /\bthat'?s\s+wrong\b/i, weight: 0.85 },
  { regex: /\bi\s+meant\b/i, weight: 0.8 },
  { regex: /\bcorrection\s*:/i, weight: 0.9 },
  { regex: /\bfix\s*(it|this)\s*:/i, weight: 0.75 },
  { regex: /\binstead\s*(,|of|use|try|do|go\s+with)\b/i, weight: 0.7 },
  { regex: /\bdon'?t\s+do\s+that\b/i, weight: 0.7 },
  { regex: /\b(change|replace|swap)\s+(it|that|this)\s+(to|with)\b/i, weight: 0.75 },
  { regex: /\bnot\s+like\s+that\b/i, weight: 0.7 },
  { regex: /\bprefer\b/i, weight: 0.65 },
  { regex: /\b(always|never)\s+(use|do|put|write)\b/i, weight: 0.7 },
];

const PREFERENCE_PATTERNS: Array<{ regex: RegExp; prefType: string }> = [
  { regex: /\b(i\s+)?prefer\s+(?!not\b)/i, prefType: "explicit" },
  { regex: /\bi\s+(like|love|enjoy)\s+(using|when|it\s+when)\b/i, prefType: "explicit" },
  { regex: /\b(use|using)\s+(double|single)\s+quotes\b/i, prefType: "style" },
  { regex: /\b(tabs|spaces)\s*(over|instead\s+of|not)\b/i, prefType: "style" },
  { regex: /\b(prefer|favor)\s+(functional|oop|declarative|imperative)\b/i, prefType: "paradigm" },
  { regex: /\b(always|never)\s+(use|do|put|write|add|include)\b/i, prefType: "rule" },
];

// ── In-memory interaction ring buffer ────────────────────────────

interface RecentInteraction {
  id: string;
  timestamp: number;
  prompt: string;
  response: string;
  matchedNodeIds: string[];
}

// ── Helpers ──────────────────────────────────────────────────────

function extractKeywords(text: string, minLength: number): string[] {
  const words = text
    .toLowerCase()
    .split(/[^a-zA-Z0-9_]+/)
    .filter((w) => w.length >= minLength && !STOP_WORDS.has(w));

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      unique.push(w);
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

function extractCorrectionSnippet(
  prompt: string,
  response: string,
): string | null {
  // Try to isolate the correction from the response
  const sentences = response
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.length > 10);

  for (const sentence of sentences) {
    for (const { regex } of CORRECTION_PATTERNS) {
      if (regex.test(sentence)) {
        return sentence.trim();
      }
    }
  }

  // Fallback: if prompt was short and response is correcting, use entire prompt
  if (prompt.length < 300) {
    return null; // The prompt itself may serve as the content
  }

  return null;
}

function detectCorrections(
  prompt: string,
  response: string,
): Array<{ snippet: string; weight: number }> {
  const results: Array<{ snippet: string; weight: number }> = [];

  // Check both prompt and response for correction signals
  const combined = `${prompt} ${response}`;
  const sentences = combined.split(/(?<=[.!?])\s+/);

  for (const sentence of sentences) {
    for (const { regex, weight } of CORRECTION_PATTERNS) {
      if (regex.test(sentence)) {
        results.push({ snippet: sentence.trim(), weight });
        break; // One match per sentence
      }
    }
  }

  return results;
}

function detectPreferences(
  prompt: string,
  response: string,
): Array<{ snippet: string; prefType: string }> {
  const results: Array<{ snippet: string; prefType: string }> = [];
  const combined = `${prompt} ${response}`;

  for (const { regex, prefType } of PREFERENCE_PATTERNS) {
    const match = combined.match(regex);
    if (match) {
      // Extract a reasonable snippet around the match
      const idx = match.index!;
      const start = Math.max(0, idx - 30);
      const end = Math.min(combined.length, idx + match[0].length + 80);
      const snippet = combined.slice(start, end).trim();
      results.push({ snippet, prefType });
    }
  }

  return results;
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
  const firstSentence = content.split(/[.!?]/)[0]?.trim() ?? content;
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

          // If no explicit correction detected but the prompt was short and
          // likely a correction (starts with "no", "fix", etc.), create one anyway
          if (corrections.length === 0) {
            const promptLower = prompt.trim().toLowerCase();
            const correctionStarters = [
              "no ", "fix ", "correct ", "actually ", "i meant",
              "change ", "instead", "don't ", "stop ",
            ];
            if (
              correctionStarters.some((s) => promptLower.startsWith(s))
            ) {
              const label = buildWeightedLabel("correction", prompt, promptKeywords, 80);
              const node = await db.upsertGraphNode({
                label,
                type: "correction",
                content: prompt,
                connections: matchedNodeIds.slice(0, 5),
                weight: 0.7,
                timestamp: now,
                source,
              });
              createdNodeIds.push(node.id);
            }
          }

          // ── 2. Detect and store preferences ──────────────────

          const preferences = detectPreferences(prompt, response);
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
      // Clear the in-memory buffer
      recentInteractions.length = 0;
    },
  }) as PluginDefinition & { readonly layer: typeof MemoryLayer.INSTANT };
}

// ── Default export for convenience ───────────────────────────────

export default createGraphMemoryPlugin;

/**
 * Default ContentCleaner — wraps existing content-cleaner.ts functions
 * into the pluggable ContentCleanerPlugin interface.
 *
 * Drop-in replacement for the old direct function calls.
 */
import type { ContentCleanerPlugin, CleanedContent } from "./layers/index";
import {
  cleanMemoryContent,
  cleanGraphNodeLabel,
  deduplicateContents,
} from "./content-cleaner";

export function createDefaultCleaner(): ContentCleanerPlugin {
  return {
    name: "@the-brain-dev/content-cleaner-default",
    async clean(raw: string): Promise<CleanedContent> {
      const result = cleanMemoryContent(raw);
      // Convert sync result to the CleanedContent interface (structurally identical)
      return {
        summary: result.summary,
        action: result.action,
        project: result.project,
        userRequest: result.userRequest,
        type: result.type,
      };
    },
    async cleanGraphLabel(label: string, type: string): Promise<string> {
      return cleanGraphNodeLabel(label, type);
    },
    async deduplicate(items: CleanedContent[]): Promise<CleanedContent[]> {
      // Cast through the structural type (both interfaces are identical)
      return deduplicateContents(items as any) as CleanedContent[];
    },
  };
}

import { getAttentionState } from "../../repositories/overviewRepository";
import { getMemoryConfig } from "./memoryConfig";
import {
  incrementAccessCount,
  listMemoryNotes,
  searchMemoriesBySimilarity,
  searchMemoryNotes,
} from "./memoryRepository";
import { rewriteQuery } from "./queryRewriter";

export async function buildMemoryBlock(
  sessionId: string,
  userQuery?: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const sections: string[] = [];

  const attention = getAttentionState();
  if (attention.currentLibraryTitle || attention.focusSummary) {
    const attentionLines = ["## Current Attention"];
    if (attention.currentLibraryTitle) {
      attentionLines.push(`- Focused on: ${attention.currentLibraryTitle}`);
    }
    if (attention.currentSectionLabel) {
      attentionLines.push(`- Current section: ${attention.currentSectionLabel}`);
    }
    if (attention.focusSummary) {
      attentionLines.push(`- Summary: ${attention.focusSummary}`);
    }
    if (attention.concepts.length > 0) {
      attentionLines.push(`- Key concepts: ${attention.concepts.join(", ")}`);
    }
    sections.push(attentionLines.join("\n"));
  }

  const config = getMemoryConfig();
  const trimmedQuery = userQuery?.trim();
  let semanticMemoryCount = 0;

  if (config.enabled && config.autoRetrieval && trimmedQuery) {
    try {
      const effectiveQuery = config.queryRewrite
        ? await rewriteQuery(trimmedQuery, abortSignal)
        : trimmedQuery;
      const memories = await searchMemoriesBySimilarity(
        effectiveQuery,
        config.maxRetrievalCount,
        config.similarityThreshold,
        undefined,
        abortSignal,
      );

      if (memories.length > 0) {
        semanticMemoryCount = memories.length;
        const memoryLines = [
          "<relevant_memories>",
          "以下是与当前请求最相关的长期记忆：",
          "",
        ];

        for (const memory of memories) {
          incrementAccessCount(memory.id);
          memoryLines.push(`- ${memory.content} (score: ${memory.similarityScore.toFixed(2)})`);
          if (memory.relatedTopics.length > 0) {
            memoryLines.push(`  topics: ${memory.relatedTopics.join(", ")}`);
          }
        }

        memoryLines.push("</relevant_memories>");
        sections.push(memoryLines.join("\n"));
      }
    } catch (error) {
      console.warn(`[memory] Failed to build semantic memory block for session ${sessionId}`, error);
    }
  }

  if (semanticMemoryCount === 0) {
    const relevantNotes = trimmedQuery
      ? searchMemoryNotes(trimmedQuery, 5)
      : listMemoryNotes(5);

    if (relevantNotes.length > 0) {
      const memoryLines = ["## Memory Notes"];
      for (const note of relevantNotes) {
        memoryLines.push(`### ${note.title} (${note.kind})`);
        memoryLines.push(note.content);
        memoryLines.push("");
      }
      sections.push(memoryLines.join("\n"));
    }
  }

  if (sections.length === 0) {
    return "";
  }

  return `# Context\n\n${sections.join("\n\n")}`;
}

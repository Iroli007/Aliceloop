import type { MemoryWithScore } from "@aliceloop/runtime-core";
import { nowMs, roundMs } from "../../runtime/perfTrace";
import { getMemoryConfig } from "./memoryConfig";
import {
  DEFAULT_SEMANTIC_MEMORY_RETRIEVAL_LIMIT,
  DEFAULT_SEMANTIC_MEMORY_SIMILARITY_THRESHOLD,
  searchMemories,
} from "./memoryRepository";

export interface MemoryBlockResult {
  content: string;
  timings: Record<string, number | string | null>;
}

function formatMemoryLine(memory: MemoryWithScore) {
  const labelParts = [memory.factKind, memory.factKey].filter(Boolean);
  const label = labelParts.length > 0 ? `[${labelParts.join(":")}] ` : "";
  return `- ${label}${memory.content}`;
}

export async function buildProfileFactMemoryBlock(
  input: {
    queryText: string;
    projectId?: string | null;
    sessionId?: string | null;
  },
): Promise<MemoryBlockResult> {
  const startedAt = nowMs();
  const timings: Record<string, number | string | null> = {};
  const trimmedQuery = input.queryText.trim();

  if (!trimmedQuery) {
    timings.skipReason = "no_query";
    timings.totalMs = roundMs(nowMs() - startedAt);
    return {
      content: "",
      timings,
    };
  }

  const config = getMemoryConfig();
  if (!config.enabled) {
    timings.skipReason = "memory_disabled";
    timings.totalMs = roundMs(nowMs() - startedAt);
    return {
      content: "",
      timings,
    };
  }

  const searchStartedAt = nowMs();
  const result = await searchMemories(trimmedQuery, DEFAULT_SEMANTIC_MEMORY_RETRIEVAL_LIMIT, DEFAULT_SEMANTIC_MEMORY_SIMILARITY_THRESHOLD, {
    scope: {
      projectId: input.projectId ?? null,
      sessionId: input.sessionId ?? null,
      includeGlobal: true,
    },
  });
  timings.searchMs = roundMs(nowMs() - searchStartedAt);
  timings.searchMode = result.mode;
  timings.fallbackReason = result.fallbackReason;
  timings.totalMs = roundMs(nowMs() - startedAt);

  const memories = result.memories
    .filter((memory) => memory.durability === "permanent")
    .slice(0, DEFAULT_SEMANTIC_MEMORY_RETRIEVAL_LIMIT);

  if (memories.length === 0) {
    timings.memoryCount = 0;
    return {
      content: "",
      timings,
    };
  }

  const lines = [
    "## Profile / Fact Memory",
    "- Loaded only for explicit memory recall.",
    "",
    "<profile_fact_memory>",
  ];

  for (const memory of memories) {
    lines.push(formatMemoryLine(memory));
    if (memory.relatedTopics.length > 0) {
      lines.push(`  topics: ${memory.relatedTopics.join(", ")}`);
    }
  }

  lines.push("</profile_fact_memory>");

  const content = lines.join("\n");
  timings.memoryCount = memories.length;
  timings.contentChars = content.length;

  return {
    content,
    timings,
  };
}

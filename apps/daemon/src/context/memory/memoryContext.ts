import { getAttentionState } from "../../repositories/overviewRepository";
import { nowMs, roundMs } from "../../runtime/perfTrace";
import { getMemoryConfig } from "./memoryConfig";
import {
  countSemanticMemoryCandidates,
  incrementAccessCount,
  listMemoryNotes,
  MEMORY_RETRIEVAL_TIMEOUT_REASON,
  searchMemories,
  searchMemoriesLexically,
  searchMemoryNotes,
} from "./memoryRepository";
import { rewriteQuery } from "./queryRewriter";

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const SEMANTIC_MEMORY_BUDGET_MS = parsePositiveInt(process.env.ALICELOOP_MEMORY_BUDGET_MS, 500);
const MIN_SEMANTIC_MEMORY_CANDIDATES = parsePositiveInt(process.env.ALICELOOP_MIN_SEMANTIC_MEMORY_CANDIDATES, 10);
const MICRO_TURN_MAX_CHARS = parsePositiveInt(process.env.ALICELOOP_MICRO_TURN_MAX_CHARS, 12);
const MICRO_TURN_MAX_WORDS = parsePositiveInt(process.env.ALICELOOP_MICRO_TURN_MAX_WORDS, 4);
const MICRO_TURN_MAX_CHARS_WITH_SPACES = parsePositiveInt(process.env.ALICELOOP_MICRO_TURN_MAX_CHARS_WITH_SPACES, 24);

export interface MemoryBlockResult {
  content: string;
  runtimeNotices: string[];
  timings: Record<string, number | string | null>;
}

function buildMemoryFallbackNotice(
  fallbackReason: "embedding_provider_unavailable" | "embedding_generation_failed" | "embedding_timeout" | "embedding_index_missing",
) {
  switch (fallbackReason) {
    case "embedding_provider_unavailable":
      return "提醒你一下：向量记忆现在不可用，已经自动降级成关键词记忆检索了。通常是 embedding 网关、API key 或预算没接上。";
    case "embedding_generation_failed":
      return "提醒你一下：这轮向量记忆请求失败了，已经自动降级成关键词记忆检索。可能是 embedding 网关临时出错，或者额度不够了。";
    case "embedding_timeout":
      return "提醒你一下：这轮向量记忆检索超时了，已经自动降级成关键词记忆检索，先保证回复速度。";
    case "embedding_index_missing":
      return "提醒你一下：当前还没有可用的向量记忆索引，这轮先用关键词记忆检索顶上。";
  }
}

function createMemoryBudgetSignal(parentSignal?: AbortSignal, budgetMs = SEMANTIC_MEMORY_BUDGET_MS) {
  const controller = new AbortController();
  const forwardAbort = () => {
    controller.abort(parentSignal?.reason);
  };

  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener("abort", forwardAbort, { once: true });
    }
  }

  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(MEMORY_RETRIEVAL_TIMEOUT_REASON);
    }
  }, budgetMs);

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      if (parentSignal) {
        parentSignal.removeEventListener("abort", forwardAbort);
      }
    },
  };
}

function hasExplicitMemoryIntent(queryText: string) {
  return /remember|memory|preference|constraint|note|long[- ]?term|记住|记得|偏好|约束|长期记忆/iu.test(queryText);
}

function countVisibleWords(queryText: string) {
  return queryText.trim().split(/\s+/).filter(Boolean).length;
}

function compactQueryLength(queryText: string) {
  return queryText.replace(/\s+/g, "").length;
}

function resolveSemanticSkipReason(queryText: string, semanticCandidateCount: number) {
  if (semanticCandidateCount === 0) {
    return "embedding_index_missing_fast_path";
  }

  if (hasExplicitMemoryIntent(queryText)) {
    return null;
  }

  if (semanticCandidateCount < MIN_SEMANTIC_MEMORY_CANDIDATES) {
    return "small_memory_corpus_fast_path";
  }

  const compactLength = compactQueryLength(queryText);
  if (compactLength <= MICRO_TURN_MAX_CHARS) {
    return "micro_turn_fast_path";
  }

  const visibleWordCount = countVisibleWords(queryText);
  const hasSpaces = /\s/.test(queryText);
  if (hasSpaces && visibleWordCount <= MICRO_TURN_MAX_WORDS && compactLength <= MICRO_TURN_MAX_CHARS_WITH_SPACES) {
    return "short_prompt_fast_path";
  }

  return null;
}

export async function buildMemoryBlock(
  sessionId: string,
  userQuery?: string,
  abortSignal?: AbortSignal,
): Promise<MemoryBlockResult> {
  const startedAt = nowMs();
  const sections: string[] = [];
  const runtimeNotices: string[] = [];
  const timings: Record<string, number | string | null> = {};

  const attentionStartedAt = nowMs();
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
  timings.attentionMs = roundMs(nowMs() - attentionStartedAt);

  const config = getMemoryConfig();
  const trimmedQuery = userQuery?.trim();
  let semanticMemoryCount = 0;

  if (config.enabled && config.autoRetrieval && trimmedQuery) {
    const semanticCandidateCount = countSemanticMemoryCandidates(config.embeddingDimension);
    timings.semanticCandidateCount = semanticCandidateCount;
    const semanticSkipReason = resolveSemanticSkipReason(trimmedQuery, semanticCandidateCount);
    timings.semanticSkipReason = semanticSkipReason;

    if (semanticSkipReason) {
      const lexicalStartedAt = nowMs();
      const memories = searchMemoriesLexically(
        trimmedQuery,
        config.maxRetrievalCount,
        config.similarityThreshold,
      );
      timings.semanticSearchMs = roundMs(nowMs() - lexicalStartedAt);
      timings.semanticMode = "lexical";
      timings.semanticFallbackReason = semanticSkipReason;
      timings.semantic = JSON.stringify({
        lexicalLookupMs: timings.semanticSearchMs,
        candidateCount: semanticCandidateCount,
        skipReason: semanticSkipReason,
        totalMs: timings.semanticSearchMs,
      });

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
    } else {
      const budget = createMemoryBudgetSignal(abortSignal);

      try {
        const rewriteStartedAt = nowMs();
        const effectiveQuery = config.queryRewrite
          ? await rewriteQuery(trimmedQuery, budget.signal)
          : trimmedQuery;
        timings.queryRewriteMs = roundMs(nowMs() - rewriteStartedAt);

        const semanticStartedAt = nowMs();
        const result = await searchMemories(
          effectiveQuery,
          config.maxRetrievalCount,
          config.similarityThreshold,
          undefined,
          budget.signal,
        );
        timings.semanticSearchMs = roundMs(nowMs() - semanticStartedAt);
        timings.semanticMode = result.mode;
        timings.semanticFallbackReason = result.fallbackReason;
        timings.semantic = JSON.stringify({
          candidateCount: semanticCandidateCount,
          ...result.timings,
        });
        const memories = result.memories;

        if (result.mode === "lexical" && result.fallbackReason) {
          runtimeNotices.push(buildMemoryFallbackNotice(result.fallbackReason));
        }

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
        if (abortSignal?.aborted) {
          throw error;
        }
        console.warn(`[memory] Failed to build semantic memory block for session ${sessionId}`, error);
      } finally {
        budget.dispose();
      }
    }
  }

  if (semanticMemoryCount === 0) {
    const notesStartedAt = nowMs();
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
    timings.notesLookupMs = roundMs(nowMs() - notesStartedAt);
  }

  timings.totalMs = roundMs(nowMs() - startedAt);

  if (sections.length === 0) {
    return {
      content: "",
      runtimeNotices,
      timings,
    };
  }

  return {
    content: `# Context\n\n${sections.join("\n\n")}`,
    runtimeNotices,
    timings,
  };
}

import { randomUUID } from "node:crypto";
import type { ReasoningEffort } from "@aliceloop/runtime-core";
import type { AgentContext } from "../context/index";
import { publishSessionEvent } from "../realtime/sessionStreams";
import {
  createSessionMessage,
  updateSessionMessage,
} from "../repositories/sessionRepository";
import { syncSessionProjectHistory } from "../services/sessionProjectService";
import { getRenderableAssistantText } from "./providerRuntimeAdapter";
import { logPerfTrace, nowMs, roundMs } from "./perfTrace";
import { finalizePromptCacheRunTrace, type PromptCacheRunTrace } from "./promptCacheTelemetry";
import { clearStreamCheckpoint, saveStreamCheckpoint } from "./streamCheckpoint";
import type { ToolStateMachine } from "./toolStateMachine";

const DEBOUNCE_MS = 80;

interface TextStreamLike {
  textStream: AsyncIterable<string>;
  toolCalls: PromiseLike<unknown[]>;
  providerMetadata: PromiseLike<{
    anthropic?: {
      cacheCreationInputTokens?: unknown;
      cacheReadInputTokens?: unknown;
    };
  } | undefined>;
}

interface TextFallbackResult {
  replacementText: string;
  toolCallCount: number;
}

interface ConsumeTextStreamInput {
  sessionId: string;
  providerId: string;
  context: AgentContext;
  stream: TextStreamLike;
  stateMachine: ToolStateMachine;
  reasoningEffort: ReasoningEffort;
  requestStartedAt: number;
  existingAssistantMessageId: string | null;
  checkActive(): void;
  summarizeUnknown(value: unknown, maxLength?: number): string | null;
  resolveTextFallback(input: {
    assistantText: string;
    stateMachine: ToolStateMachine;
    reasoningEffort: ReasoningEffort;
  }): Promise<TextFallbackResult | null>;
}

export async function consumeTextStream(input: ConsumeTextStreamInput): Promise<{
  text: string;
  assistantMessageId: string | null;
  timings: Record<string, number | null>;
  diagnostics: {
    resolvedToolCallCount: number;
    providerMetadataPreview: string | null;
    promptCache: PromptCacheRunTrace | null;
  };
}> {
  let text = "";
  const assistantClientMessageId = `agent-assistant-${randomUUID()}`;
  let assistantMessageId: string | null = input.existingAssistantMessageId;
  let pendingFlush = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let firstTokenMs: number | null = null;
  let resolvedToolCalls: unknown[] = [];
  let fallbackToolCallCount = 0;
  const assistantEventPayload = input.context.displaySkillIds.length > 0
    ? { skills: input.context.displaySkillIds }
    : undefined;

  function getChatContent(final = false) {
    return getRenderableAssistantText(input.providerId, text, final);
  }

  function flush() {
    if (!assistantMessageId || !pendingFlush) return;
    pendingFlush = false;
    const content = getChatContent();
    if (content === null) {
      return;
    }
    const updateResult = updateSessionMessage({
      sessionId: input.sessionId,
      messageId: assistantMessageId,
      content,
      eventPayload: assistantEventPayload,
    });
    publishSessionEvent(updateResult.event);
  }

  for await (const delta of input.stream.textStream) {
    input.checkActive();
    if (!delta) continue;

    text += delta;
    saveStreamCheckpoint(input.sessionId, text);

    if (!assistantMessageId) {
      const content = getChatContent();
      if (content === null || !content) {
        continue;
      }

      firstTokenMs = roundMs(nowMs() - input.requestStartedAt);
      const messageResult = createSessionMessage({
        sessionId: input.sessionId,
        clientMessageId: assistantClientMessageId,
        deviceId: "runtime-agent",
        role: "assistant",
        content,
        attachmentIds: [],
        eventPayload: assistantEventPayload,
      });

      assistantMessageId = messageResult.message.id;
      for (const event of messageResult.events) {
        publishSessionEvent(event);
      }
      continue;
    }

    pendingFlush = true;
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flush();
        flushTimer = null;
      }, DEBOUNCE_MS);
    }
  }

  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingFlush) flush();

  resolvedToolCalls = await input.stream.toolCalls;

  if (resolvedToolCalls.length === 0 && text.trim()) {
    const fallback = await input.resolveTextFallback({
      assistantText: text,
      stateMachine: input.stateMachine,
      reasoningEffort: input.reasoningEffort,
    });

    if (fallback) {
      fallbackToolCallCount = fallback.toolCallCount;
      text = fallback.replacementText;
    }
  }

  if (!text.trim() && resolvedToolCalls.length > 0) {
    text = `已完成 ${resolvedToolCalls.length} 次工具调用。`;
  }

  const finalContent = getChatContent(true);

  if (assistantMessageId && typeof finalContent === "string") {
    const updateResult = updateSessionMessage({
      sessionId: input.sessionId,
      messageId: assistantMessageId,
      content: finalContent,
      eventPayload: assistantEventPayload,
    });
    publishSessionEvent(updateResult.event);
  }

  if (!assistantMessageId && finalContent) {
    const messageResult = createSessionMessage({
      sessionId: input.sessionId,
      clientMessageId: assistantClientMessageId,
      deviceId: "runtime-agent",
      role: "assistant",
      content: finalContent,
      attachmentIds: [],
      eventPayload: assistantEventPayload,
    });
    assistantMessageId = messageResult.message.id;
    for (const event of messageResult.events) {
      publishSessionEvent(event);
    }
  }

  await syncSessionProjectHistory(input.sessionId);
  clearStreamCheckpoint(input.sessionId);

  const metadata = await input.stream.providerMetadata;
  let cacheCreationInputTokens: number | null = null;
  let cacheReadInputTokens: number | null = null;
  if (metadata?.anthropic) {
    cacheCreationInputTokens = typeof metadata.anthropic.cacheCreationInputTokens === "number"
      ? metadata.anthropic.cacheCreationInputTokens
      : null;
    cacheReadInputTokens = typeof metadata.anthropic.cacheReadInputTokens === "number"
      ? metadata.anthropic.cacheReadInputTokens
      : null;
    if (cacheCreationInputTokens || cacheReadInputTokens) {
      console.log(`[Cache] write=${cacheCreationInputTokens ?? 0} read=${cacheReadInputTokens ?? 0}`);
    }
  }

  const promptCache = finalizePromptCacheRunTrace(
    input.sessionId,
    input.context.promptCacheTrace,
    {
      cacheCreationInputTokens,
      cacheReadInputTokens,
    },
  );

  logPerfTrace("prompt_cache", {
    sessionId: input.sessionId,
    providerId: input.providerId,
    requestHash: promptCache.requestHash,
    breakpoints: promptCache.breakpoints.map((breakpoint) => ({
      id: breakpoint.id,
      stage: breakpoint.stage,
      marker: breakpoint.marker,
      prefixHash: breakpoint.prefixHash,
      prefixChars: breakpoint.prefixChars,
    })),
    stableBreakpointIdsVsPrevious: promptCache.stableBreakpointIdsVsPrevious,
    likelyHitBreakpointIds: promptCache.likelyHitBreakpointIds,
    likelyMissBreakpointIds: promptCache.likelyMissBreakpointIds,
    highestStableBreakpointId: promptCache.highestStableBreakpointId,
    cacheCreationInputTokens: promptCache.cacheCreationInputTokens,
    cacheReadInputTokens: promptCache.cacheReadInputTokens,
    comparedToPreviousRun: promptCache.comparedToPreviousRun,
    comparisonBasis: promptCache.comparisonBasis,
  });

  return {
    text,
    assistantMessageId,
    timings: {
      firstTokenMs,
      streamTotalMs: roundMs(nowMs() - input.requestStartedAt),
      cacheCreationInputTokens,
      cacheReadInputTokens,
    },
    diagnostics: {
      resolvedToolCallCount: Array.isArray(resolvedToolCalls)
        ? resolvedToolCalls.length + fallbackToolCallCount
        : fallbackToolCallCount,
      providerMetadataPreview: input.summarizeUnknown(metadata),
      promptCache,
    },
  };
}

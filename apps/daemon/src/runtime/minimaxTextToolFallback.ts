import { randomUUID } from "node:crypto";
import type { ReasoningEffort } from "@aliceloop/runtime-core";
import { generateText } from "ai";
import type { AgentContext } from "../context/index";
import { createProviderModel } from "../providers/providerModelFactory";
import type { StoredProviderConfig } from "../repositories/providerRepository";
import {
  recordToolCallCompleted,
  recordToolCallStarted,
} from "../repositories/sessionOpenTaskRepository";
import { buildAgentProviderOptions } from "./providerRuntimeAdapter";
import { repairTextToolCalls, type RepairedToolCall } from "./toolCallRepair";
import type { ToolStateMachine } from "./toolStateMachine";
import { nowMs, roundMs } from "./perfTrace";

type RuntimeEventType = "tool.call.started" | "tool.call.completed";

type RuntimeEventPublisher = (
  sessionId: string,
  type: RuntimeEventType,
  payload: Record<string, unknown>,
) => unknown;

type ToolRuntimePrediction = {
  backend?: string | null;
  tabId?: string | null;
};

type BrowserToolPayload = {
  backend?: string;
  tabId?: string;
};

interface ExecuteMiniMaxTextToolCallFallbackInput {
  sessionId: string;
  provider: StoredProviderConfig;
  context: AgentContext;
  abortSignal: AbortSignal;
  stateMachine: ToolStateMachine;
  reasoningEffort: ReasoningEffort;
  assistantText: string;
  summarizeUnknown(value: unknown, maxLength?: number): string | null;
  predictToolBackend(sessionId: string, toolName: string): ToolRuntimePrediction;
  extractBrowserToolPayload(value: unknown): BrowserToolPayload;
  publishRuntimeEvent: RuntimeEventPublisher;
  maybePublishToolImageAttachment(
    sessionId: string,
    toolName: string,
    output: unknown,
    input?: unknown,
  ): Promise<void>;
}

function buildMiniMaxToolFallbackPrompt(
  toolResults: Array<{
    toolName: string;
    input: Record<string, unknown>;
    output: unknown;
  }>,
  summarizeUnknown: ExecuteMiniMaxTextToolCallFallbackInput["summarizeUnknown"],
) {
  return [
    "You previously attempted text-form tool calls. They have now been executed.",
    ...toolResults.map((result, index) => [
      `Tool ${index + 1}: ${result.toolName}`,
      `Input: ${summarizeUnknown(result.input, 400) ?? "{}"}`,
      `Output: ${summarizeUnknown(result.output, 4000) ?? ""}`,
    ].join("\n")),
    "Answer the user's original request directly in normal prose.",
    "Do not emit XML, <tool> tags, or tool_call markup.",
  ].join("\n\n");
}

export async function executeMiniMaxTextToolCallFallback(input: ExecuteMiniMaxTextToolCallFallbackInput) {
  const parsedCalls = repairTextToolCalls(input.assistantText);
  if (parsedCalls.length === 0) {
    return null;
  }

  for (const parsed of parsedCalls) {
    const tool = input.context.tools[parsed.toolName] as { execute?: (toolInput: unknown) => Promise<unknown> } | undefined;
    if (tool && typeof tool.execute === "function") {
      continue;
    }

    const availableTools = Object.keys(input.context.tools);
    const availablePreview = availableTools.slice(0, 12).join(", ");
    return {
      replacementText: [
        `模型输出了文本形式的 \`${parsed.toolName}\` 调用，但当前回合没有把这个工具加入工具集。`,
        availablePreview
          ? `当前已挂载的工具有：${availablePreview}${availableTools.length > 12 ? " 等" : ""}。`
          : "当前回合没有挂载任何可执行工具。",
      ].join("\n\n"),
      toolCallCount: 0,
      parsedMarkup: parsed.markup,
    };
  }

  const toolResults: Array<{
    parsed: RepairedToolCall;
    output: unknown;
  }> = [];

  for (const parsed of parsedCalls) {
    const tool = input.context.tools[parsed.toolName] as unknown as { execute: (toolInput: unknown) => Promise<unknown> };
    const toolCallId = `minimax-fallback-${randomUUID()}`;
    recordToolCallStarted(input.sessionId, parsed.toolName, toolCallId, parsed.input);
    input.stateMachine.start(toolCallId, parsed.toolName, parsed.input);
    input.stateMachine.markInputAvailable(toolCallId);

    const predictedRuntime = input.predictToolBackend(input.sessionId, parsed.toolName);
    input.publishRuntimeEvent(input.sessionId, "tool.call.started", {
      toolCallId,
      toolName: parsed.toolName,
      inputPreview: input.summarizeUnknown(parsed.input),
      backend: predictedRuntime.backend,
      tabId: predictedRuntime.tabId,
      state: "input-available",
      fallbackSource: parsed.source,
    });

    const toolStartedAt = nowMs();

    try {
      const output = await tool.execute(parsed.input);
      input.stateMachine.markOutputAvailable(toolCallId, output);
      input.stateMachine.complete(toolCallId);
      recordToolCallCompleted({
        sessionId: input.sessionId,
        toolName: parsed.toolName,
        toolCallId,
        success: true,
        output,
      });

      const browserPayload = input.extractBrowserToolPayload(output);
      input.publishRuntimeEvent(input.sessionId, "tool.call.completed", {
        toolCallId,
        toolName: parsed.toolName,
        success: true,
        resultPreview: input.summarizeUnknown(output),
        durationMs: roundMs(nowMs() - toolStartedAt),
        backend: browserPayload.backend ?? predictedRuntime.backend,
        tabId: browserPayload.tabId ?? predictedRuntime.tabId,
        state: "output-available",
        fallbackSource: parsed.source,
      });

      void input.maybePublishToolImageAttachment(
        input.sessionId,
        parsed.toolName,
        output,
        parsed.input,
      ).catch(() => {});

      toolResults.push({ parsed, output });
    } catch (error) {
      input.stateMachine.markError(toolCallId, error);
      input.stateMachine.complete(toolCallId);
      recordToolCallCompleted({
        sessionId: input.sessionId,
        toolName: parsed.toolName,
        toolCallId,
        success: false,
        error,
      });

      input.publishRuntimeEvent(input.sessionId, "tool.call.completed", {
        toolCallId,
        toolName: parsed.toolName,
        success: false,
        resultPreview: input.summarizeUnknown(error),
        durationMs: roundMs(nowMs() - toolStartedAt),
        backend: predictedRuntime.backend,
        tabId: predictedRuntime.tabId,
        state: "output-error",
        fallbackSource: parsed.source,
      });

      return {
        replacementText: [
          `模型返回了文本形式的工具调用：${parsed.markup}`,
          `我尝试按 AI-native fallback 执行 \`${parsed.toolName}\`，但失败了：${error instanceof Error ? error.message : String(error)}`,
        ].join("\n\n"),
        toolCallCount: toolResults.length + 1,
        parsedMarkup: parsed.markup,
      };
    }
  }

  let finalText = "";

  try {
    const followup = await generateText({
      model: createProviderModel(input.provider, {
        sessionId: input.sessionId,
        reasoningEffort: input.reasoningEffort,
      }),
      system: input.context.systemPrompt,
      messages: [
        ...input.context.messages,
        {
          role: "assistant",
          content: input.assistantText,
        },
        {
          role: "user",
          content: buildMiniMaxToolFallbackPrompt(
            toolResults.map((result) => ({
              toolName: result.parsed.toolName,
              input: result.parsed.input,
              output: result.output,
            })),
            input.summarizeUnknown,
          ),
        },
      ],
      providerOptions: buildAgentProviderOptions(input.provider, input.reasoningEffort),
      abortSignal: input.abortSignal,
    });
    finalText = followup.text.trim();
  } catch {
    finalText = "";
  }

  if (!finalText) {
    finalText = [
      `已接住文本形式的工具调用并执行了 ${toolResults.length} 次。`,
      ...toolResults.map((result) => input.summarizeUnknown(result.output, 4000)).filter(Boolean),
    ].join("\n\n");
  }

  return {
    replacementText: finalText,
    toolCallCount: toolResults.length,
    parsedMarkup: parsedCalls.map((parsed) => parsed.markup).join("\n\n"),
  };
}

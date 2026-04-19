import { randomUUID } from "node:crypto";
import type { ReasoningEffort } from "@aliceloop/runtime-core";
import { generateText } from "ai";
import type { AgentContext } from "../context/index";
import { createProviderModel } from "../providers/providerModelFactory";
import type { StoredProviderConfig } from "../repositories/providerRepository";
import { autoCompactMessages } from "./autoCompact";
import { buildAgentProviderOptions } from "./providerRuntimeAdapter";
import { repairTextToolCall } from "./toolCallRepair";
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
  toolName: string,
  input: Record<string, unknown>,
  output: unknown,
  summarizeUnknown: ExecuteMiniMaxTextToolCallFallbackInput["summarizeUnknown"],
) {
  return [
    `You previously attempted to call the tool "${toolName}" with input: ${summarizeUnknown(input, 400) ?? "{}"}`,
    `The tool returned: ${summarizeUnknown(output, 4000) ?? ""}`,
    "Answer the user's original request directly in normal prose.",
    "Do not emit XML, <tool> tags, or tool_call markup.",
  ].join("\n\n");
}

export async function executeMiniMaxTextToolCallFallback(input: ExecuteMiniMaxTextToolCallFallbackInput) {
  const parsed = repairTextToolCall(input.assistantText);
  if (!parsed) {
    return null;
  }

  const tool = input.context.tools[parsed.toolName] as { execute?: (toolInput: unknown) => Promise<unknown> } | undefined;
  if (!tool || typeof tool.execute !== "function") {
    const availableTools = Object.keys(input.context.tools);
    const availablePreview = availableTools.slice(0, 12).join(", ");
    return {
      replacementText: [
        `MiniMax 尝试调用 \`${parsed.toolName}\`，但当前回合没有把这个工具加入工具集。`,
        availablePreview
          ? `当前已挂载的工具有：${availablePreview}${availableTools.length > 12 ? " 等" : ""}。`
          : "当前回合没有挂载任何可执行工具。",
      ].join("\n\n"),
      toolCallCount: 0,
      parsedMarkup: parsed.markup,
    };
  }

  const toolCallId = `minimax-fallback-${randomUUID()}`;
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
    fallbackSource: "minimax_text_tool_call",
  });

  const toolStartedAt = nowMs();

  try {
    const output = await tool.execute(parsed.input);
    input.stateMachine.markOutputAvailable(toolCallId, output);
    input.stateMachine.complete(toolCallId);

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
      fallbackSource: "minimax_text_tool_call",
    });

    void input.maybePublishToolImageAttachment(
      input.sessionId,
      parsed.toolName,
      output,
      parsed.input,
    ).catch(() => {});

    let finalText = "";

    try {
      const followup = await generateText({
        model: createProviderModel(input.provider),
        system: input.context.systemPrompt,
        messages: [
          ...autoCompactMessages(input.context.messages, 8),
          {
            role: "assistant",
            content: input.assistantText,
          },
          {
            role: "user",
            content: buildMiniMaxToolFallbackPrompt(
              parsed.toolName,
              parsed.input,
              output,
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
        `已接住 MiniMax 的文本工具调用并执行了 \`${parsed.toolName}\`。`,
        input.summarizeUnknown(output, 4000) ?? "",
      ].filter(Boolean).join("\n\n");
    }

    return {
      replacementText: finalText,
      toolCallCount: 1,
      parsedMarkup: parsed.markup,
    };
  } catch (error) {
    input.stateMachine.markError(toolCallId, error);
    input.stateMachine.complete(toolCallId);

    input.publishRuntimeEvent(input.sessionId, "tool.call.completed", {
      toolCallId,
      toolName: parsed.toolName,
      success: false,
      resultPreview: input.summarizeUnknown(error),
      durationMs: roundMs(nowMs() - toolStartedAt),
      backend: predictedRuntime.backend,
      tabId: predictedRuntime.tabId,
      state: "output-error",
      fallbackSource: "minimax_text_tool_call",
    });

    return {
      replacementText: [
        `MiniMax 返回了文本形式的工具调用：${parsed.markup}`,
        `我尝试按 AI-native fallback 执行 \`${parsed.toolName}\`，但失败了：${error instanceof Error ? error.message : String(error)}`,
      ].join("\n\n"),
      toolCallCount: 1,
      parsedMarkup: parsed.markup,
    };
  }
}

import { randomUUID } from "node:crypto";
import { stepCountIs, streamText } from "ai";
import { loadContext } from "../context/index";
import { reflectOnTurn } from "../context/memory/memoryDistiller";
import { getLatestUserMessage } from "../context/session/sessionContext";
import { createProviderModel } from "../providers/providerModelFactory";
import { publishSessionEvent } from "../realtime/sessionStreams";
import { getActiveProviderConfig } from "../repositories/providerRepository";
import {
  appendSessionEvent,
  createSessionMessage,
  updateSessionMessage,
  upsertSessionJob,
} from "../repositories/sessionRepository";
import { maybeCreateArtifactFromReply } from "../services/artifactWriter";
import { enqueueSessionRun } from "../services/sessionRunQueue";
import { createSafetyChecker, SafetyLimitError } from "./safetyGuard";

function publishJob(input: Parameters<typeof upsertSessionJob>[0]) {
  const result = upsertSessionJob(input);
  publishSessionEvent(result.event);
  return result.job;
}

function publishRuntimeNotice(sessionId: string, content: string) {
  const result = createSessionMessage({
    sessionId,
    clientMessageId: `runtime-notice-${randomUUID()}`,
    deviceId: "runtime-agent",
    role: "system",
    content,
    attachmentIds: [],
  });

  for (const event of result.events) {
    publishSessionEvent(event);
  }
}

function publishAssistantReply(sessionId: string, content: string) {
  const result = createSessionMessage({
    sessionId,
    clientMessageId: `assistant-reply-${randomUUID()}`,
    deviceId: "runtime-agent",
    role: "assistant",
    content,
    attachmentIds: [],
  });

  for (const event of result.events) {
    publishSessionEvent(event);
  }
}

function buildLocalFallbackReply(userMessage: string | null) {
  const normalized = userMessage?.trim();

  if (!normalized) {
    return "已收到你的消息。当前还没有配置 AI provider，所以这里先返回本地组装的 assistant 回复，确认 Aliceloop 的最小闭环已经打通。";
  }

  return [
    "已收到你的消息，Aliceloop 的最小闭环是通的。",
    `我收到的是：${normalized}`,
    "当前还没有配置 AI provider，所以这里先返回本地组装的 assistant 回复。配置 API key 后，这里会切换成真实模型生成。",
  ].join("\n\n");
}

function summarizeUnknown(value: unknown, maxLength = 800) {
  if (typeof value === "string") {
    return value.length > maxLength ? `${value.slice(0, maxLength).trimEnd()}…` : value;
  }

  try {
    const serialized = JSON.stringify(value);
    if (!serialized) {
      return null;
    }

    return serialized.length > maxLength ? `${serialized.slice(0, maxLength).trimEnd()}…` : serialized;
  } catch {
    return String(value);
  }
}

function publishRuntimeEvent(
  sessionId: string,
  type: "tool.call.started" | "tool.call.completed",
  payload: Record<string, unknown>,
) {
  const event = appendSessionEvent(sessionId, type, payload);
  publishSessionEvent(event);
  return event;
}

export async function runAgent(sessionId: string) {
  return enqueueSessionRun(sessionId, async () => {
    const activeProvider = getActiveProviderConfig();
    const jobId = randomUUID();

    if (!activeProvider || !activeProvider.apiKey) {
      publishAssistantReply(sessionId, buildLocalFallbackReply(getLatestUserMessage(sessionId)));
      publishJob({
        id: jobId,
        sessionId,
        kind: "provider-completion",
        status: "done",
        title: "Local fallback reply",
        detail: "No provider is configured, so Aliceloop returned a local assembled assistant reply.",
      });
      return;
    }

    const abortController = new AbortController();
    activeAgents.set(sessionId, abortController);

    publishJob({
      id: jobId,
      sessionId,
      kind: "provider-completion",
      status: "running",
      title: `${activeProvider.label} is responding`,
      detail: `Using ${activeProvider.model} for this response.`,
    });

    try {
      const ctx = loadContext(sessionId, abortController.signal);
      const model = createProviderModel(activeProvider);
      const safety = createSafetyChecker(ctx.safetyConfig);

      const assistantClientMessageId = `agent-assistant-${randomUUID()}`;
      let assistantMessageId: string | null = null;
      let assistantText = "";

      const toolCallLog: Array<{
        name: string;
        args: unknown;
        result: unknown;
      }> = [];

      const result = streamText({
        model,
        system: ctx.systemPrompt,
        messages: ctx.messages,
        tools: ctx.tools,
        stopWhen: stepCountIs(ctx.safetyConfig.maxIterations),
        abortSignal: abortController.signal,
        experimental_onStepStart() {
          safety.checkStep();
        },
        experimental_onToolCallStart({ toolCall }) {
          safety.checkActive();
          publishRuntimeEvent(sessionId, "tool.call.started", {
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            inputPreview: summarizeUnknown(toolCall.input),
          });
        },
        experimental_onToolCallFinish(event) {
          safety.checkActive();
          const resultPreview = event.success ? summarizeUnknown(event.output) : summarizeUnknown(event.error);

          publishRuntimeEvent(sessionId, "tool.call.completed", {
            toolCallId: event.toolCall.toolCallId,
            toolName: event.toolCall.toolName,
            success: event.success,
            resultPreview,
            durationMs: event.durationMs,
          });

          toolCallLog.push({
            name: event.toolCall.toolName,
            args: event.toolCall.input,
            result: event.success ? event.output : resultPreview,
          });
        },
      });

      for await (const delta of result.textStream) {
        safety.checkActive();
        if (!delta) {
          continue;
        }

        assistantText += delta;

        if (!assistantMessageId) {
          const messageResult = createSessionMessage({
            sessionId,
            clientMessageId: assistantClientMessageId,
            deviceId: "runtime-agent",
            role: "assistant",
            content: assistantText,
            attachmentIds: [],
          });

          assistantMessageId = messageResult.message.id;
          for (const event of messageResult.events) {
            publishSessionEvent(event);
          }
          continue;
        }

        const updateResult = updateSessionMessage({
          sessionId,
          messageId: assistantMessageId,
          content: assistantText,
        });
        publishSessionEvent(updateResult.event);
      }

      if (!assistantText.trim() && toolCallLog.length > 0) {
        assistantText = `已完成 ${toolCallLog.length} 次工具调用。`;
      }

      if (!assistantMessageId && assistantText) {
        const messageResult = createSessionMessage({
          sessionId,
          clientMessageId: assistantClientMessageId,
          deviceId: "runtime-agent",
          role: "assistant",
          content: assistantText,
          attachmentIds: [],
        });

        assistantMessageId = messageResult.message.id;
        for (const event of messageResult.events) {
          publishSessionEvent(event);
        }
      }

      if (!assistantText.trim()) {
        throw new Error(`${activeProvider.label} returned empty content`);
      }

      publishJob({
        id: jobId,
        sessionId,
        kind: "provider-completion",
        status: "done",
        title: `${activeProvider.label} completed`,
        detail: `Response generated with ${activeProvider.model} (${safety.iterationCount} steps, ${Math.round(safety.elapsedMs / 1000)}s).`,
      });

      const userMessages = ctx.messages
        .filter((message) => message.role === "user")
        .map((message) => (typeof message.content === "string" ? message.content : ""));

      const latestUserMessage = userMessages.at(-1) ?? null;
      if (latestUserMessage) {
        void maybeCreateArtifactFromReply(sessionId, latestUserMessage, assistantText).catch((artifactError) => {
          const detail = artifactError instanceof Error ? artifactError.message : "工件写入失败";
          publishRuntimeNotice(sessionId, `工件流式写入失败：${detail}`);
        });
      }

      void reflectOnTurn({
        sessionId,
        userMessages,
        assistantResponse: assistantText,
        toolCalls: toolCallLog,
      }).catch(() => {
        // Reflection failure should not fail the user-visible turn.
      });
    } catch (error) {
      if (error instanceof SafetyLimitError) {
        publishJob({
          id: jobId,
          sessionId,
          kind: "provider-completion",
          status: "failed",
          title: "Agent stopped",
          detail: error.message,
        });
        publishRuntimeNotice(sessionId, error.message);
      } else if (abortController.signal.aborted) {
        const detail = "Agent loop aborted: user sent a new message or requested cancellation.";
        publishJob({
          id: jobId,
          sessionId,
          kind: "provider-completion",
          status: "failed",
          title: "Agent stopped",
          detail,
        });
        publishRuntimeNotice(sessionId, detail);
      } else {
        const detail = error instanceof Error ? error.message : "Agent call failed";
        publishJob({
          id: jobId,
          sessionId,
          kind: "provider-completion",
          status: "failed",
          title: `${activeProvider.label} failed`,
          detail,
        });
        publishRuntimeNotice(sessionId, `Agent error: ${detail}`);
      }
    } finally {
      activeAgents.delete(sessionId);
    }
  });
}

const activeAgents = new Map<string, AbortController>();

export function abortAgentForSession(sessionId: string) {
  const controller = activeAgents.get(sessionId);
  if (!controller) {
    return false;
  }

  controller.abort();
  return true;
}

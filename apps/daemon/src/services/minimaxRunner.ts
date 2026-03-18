import { randomUUID } from "node:crypto";
import type { SessionMessage } from "@aliceloop/runtime-core";
import { publishSessionEvent } from "../realtime/sessionStreams";
import { getStoredProviderConfig } from "../repositories/providerRepository";
import { createSessionMessage, getSessionSnapshot, upsertSessionJob } from "../repositories/sessionRepository";
import { maybeCreateArtifactFromReply } from "./artifactWriter";

interface MiniMaxChatResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

interface MiniMaxErrorResponse {
  error?: {
    message?: string;
    type?: string;
    http_code?: string;
  };
}

function serializeMessage(message: SessionMessage) {
  if (message.attachments.length === 0) {
    return message.content;
  }

  const attachmentSummary = message.attachments
    .map((attachment) => `${attachment.fileName} (${attachment.mimeType})`)
    .join(", ");

  if (!message.content.trim()) {
    return `[User attached files: ${attachmentSummary}]`;
  }

  return `${message.content}\n\n[Attached files: ${attachmentSummary}]`;
}

function extractAssistantText(payload: MiniMaxChatResponse) {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => item.text ?? "")
      .join("")
      .trim();
  }

  return "";
}

function publishJob(input: Parameters<typeof upsertSessionJob>[0]) {
  const result = upsertSessionJob(input);
  publishSessionEvent(result.event);
  return result.job;
}

function publishRuntimeNotice(sessionId: string, content: string) {
  const result = createSessionMessage({
    sessionId,
    clientMessageId: `runtime-notice-${randomUUID()}`,
    deviceId: "runtime-minimax",
    role: "system",
    content,
    attachmentIds: [],
  });

  for (const event of result.events) {
    publishSessionEvent(event);
  }
}

function summarizeProviderError(label: string, status: number, payloadText: string) {
  try {
    const payload = JSON.parse(payloadText) as MiniMaxErrorResponse;
    const message = payload.error?.message?.trim();
    if (message) {
      if (status === 401) {
        return `${label} 认证失败，请检查 API Key 是否正确可用。原始信息：${message}`;
      }

      return `${label} 请求失败（HTTP ${status}）：${message}`;
    }
  } catch {
    // Fall through to the raw-text branch below.
  }

  return `${label} 请求失败（HTTP ${status}）。`;
}

export async function runMiniMaxReply(sessionId: string) {
  const config = getStoredProviderConfig("minimax");
  const jobId = randomUUID();

  if (!config.enabled || !config.apiKey) {
    publishJob({
      id: jobId,
      sessionId,
      kind: "provider-completion",
      status: "failed",
      title: `${config.label} 未配置`,
      detail: `先在设置里填入 ${config.label} API Key，并启用这个 provider，再发第一条真实消息。`,
    });
    publishRuntimeNotice(sessionId, `${config.label} 还没配置好。先去设置里填 API Key，然后再试一次。`);
    return;
  }

  publishJob({
      id: jobId,
      sessionId,
      kind: "provider-completion",
      status: "queued",
      title: `排队请求 ${config.label}`,
      detail: `准备使用 ${config.model} 生成这轮回复。`,
    });

  publishJob({
      id: jobId,
      sessionId,
      kind: "provider-completion",
      status: "running",
      title: `${config.label} 正在回复`,
      detail: `正在向 ${config.label} 发起真实推理请求。`,
    });

  try {
    const snapshot = getSessionSnapshot(sessionId);
    const latestUserMessage = [...snapshot.messages].reverse().find((message) => message.role === "user");
    const history = snapshot.messages
      .slice(-12)
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role,
        content: serializeMessage(message),
      }));

    const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 1,
        stream: false,
        reasoning_split: true,
        messages: history,
      }),
    });

    if (!response.ok) {
      const errorText = (await response.text()).slice(0, 320);
      throw new Error(summarizeProviderError(config.label, response.status, errorText));
    }

    const payload = (await response.json()) as MiniMaxChatResponse;
    const assistantText = extractAssistantText(payload);
    if (!assistantText) {
      throw new Error(`${config.label} returned empty content`);
    }

    const result = createSessionMessage({
      sessionId,
      clientMessageId: `minimax-assistant-${randomUUID()}`,
      deviceId: "runtime-minimax",
      role: "assistant",
      content: assistantText,
      attachmentIds: [],
    });

    for (const event of result.events) {
      publishSessionEvent(event);
    }

    publishJob({
      id: jobId,
      sessionId,
      kind: "provider-completion",
      status: "done",
      title: `${config.label} 回复完成`,
      detail: `已通过 ${config.model} 回写这一轮 assistant 消息。`,
    });

    if (latestUserMessage) {
      void maybeCreateArtifactFromReply(sessionId, latestUserMessage.content, assistantText).catch((artifactError) => {
        const detail = artifactError instanceof Error ? artifactError.message : "工件写入失败";
        publishRuntimeNotice(sessionId, `工件流式写入失败：${detail}`);
      });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : `${config.label} 调用失败`;
    publishJob({
      id: jobId,
      sessionId,
      kind: "provider-completion",
      status: "failed",
      title: `${config.label} 回复失败`,
      detail,
    });
    publishRuntimeNotice(sessionId, `${config.label} 调用失败：${detail}`);
  }
}

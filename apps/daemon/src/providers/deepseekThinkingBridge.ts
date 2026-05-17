import type { ReasoningEffort } from "@aliceloop/runtime-core";
import {
  getProviderReasoningTrace,
  upsertProviderReasoningTrace,
} from "../repositories/providerReasoningRepository";

interface DeepSeekThinkingFetchOptions {
  sessionId?: string;
  providerId: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  thinkingEnabled: boolean;
}

interface CapturedToolCall {
  id: string;
}

interface CapturedAssistantStep {
  reasoningContent: string;
  toolCalls: CapturedToolCall[];
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mapDeepSeekReasoningEffort(effort: ReasoningEffort | undefined) {
  if (!effort || effort === "off") {
    return undefined;
  }

  if (effort === "low" || effort === "medium") {
    return "high";
  }

  if (effort === "xhigh") {
    return "max";
  }

  return effort;
}

function getToolCallIds(message: JsonRecord) {
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return toolCalls.flatMap((toolCall) => {
    if (!isRecord(toolCall) || typeof toolCall.id !== "string" || !toolCall.id.trim()) {
      return [];
    }

    return [toolCall.id];
  });
}

function parseRequestBody(body: string) {
  try {
    const payload = JSON.parse(body);
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

function parseChunkPayload(rawData: string) {
  const trimmed = rawData.trim();
  if (!trimmed || trimmed === "[DONE]") {
    return null;
  }

  try {
    const payload = JSON.parse(trimmed);
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

function getFirstChoice(payload: JsonRecord) {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = choices[0];
  return isRecord(firstChoice) ? firstChoice : null;
}

function captureToolCallsFromDelta(toolCallState: Map<number, CapturedToolCall>, delta: JsonRecord) {
  const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  for (const rawToolCall of toolCalls) {
    if (!isRecord(rawToolCall)) {
      continue;
    }

    const index = typeof rawToolCall.index === "number" ? rawToolCall.index : toolCallState.size;
    const existing = toolCallState.get(index) ?? { id: "" };
    if (typeof rawToolCall.id === "string" && rawToolCall.id.trim()) {
      existing.id = rawToolCall.id;
    }
    toolCallState.set(index, existing);
  }
}

function captureToolCallsFromMessage(message: JsonRecord) {
  return getToolCallIds(message).map((id) => ({ id }));
}

function extractStreamingAssistantStep(bodyText: string): CapturedAssistantStep | null {
  let reasoningContent = "";
  const toolCallState = new Map<number, CapturedToolCall>();
  const blocks = bodyText.split(/\r?\n\r?\n/gu);

  for (const block of blocks) {
    const data = block
      .split(/\r?\n/gu)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    const payload = parseChunkPayload(data);
    if (!payload) {
      continue;
    }

    const choice = getFirstChoice(payload);
    const delta = isRecord(choice?.delta) ? choice.delta : null;
    if (!delta) {
      continue;
    }

    if (typeof delta.reasoning_content === "string") {
      reasoningContent += delta.reasoning_content;
    }
    captureToolCallsFromDelta(toolCallState, delta);
  }

  const toolCalls = [...toolCallState.values()].filter((toolCall) => toolCall.id);
  return reasoningContent.trim() && toolCalls.length > 0
    ? { reasoningContent, toolCalls }
    : null;
}

function extractJsonAssistantStep(bodyText: string): CapturedAssistantStep | null {
  const payload = parseChunkPayload(bodyText);
  const choice = payload ? getFirstChoice(payload) : null;
  const message = isRecord(choice?.message) ? choice.message : null;
  if (!message || typeof message.reasoning_content !== "string") {
    return null;
  }

  const toolCalls = captureToolCallsFromMessage(message);
  return message.reasoning_content.trim() && toolCalls.length > 0
    ? { reasoningContent: message.reasoning_content, toolCalls }
    : null;
}

export function createDeepSeekThinkingFetch(options: DeepSeekThinkingFetchOptions): typeof fetch {
  const reasoningByToolCallId = new Map<string, string>();

  function recordAssistantStep(step: CapturedAssistantStep | null) {
    if (!step) {
      return;
    }

    for (const toolCall of step.toolCalls) {
      reasoningByToolCallId.set(toolCall.id, step.reasoningContent);
      if (!options.sessionId) {
        continue;
      }

      upsertProviderReasoningTrace({
        sessionId: options.sessionId,
        providerId: options.providerId,
        model: options.model,
        toolCallId: toolCall.id,
        reasoningContent: step.reasoningContent,
      });
    }
  }

  function resolveReasoningContent(toolCallIds: string[]) {
    if (!options.sessionId) {
      return null;
    }

    for (const toolCallId of toolCallIds) {
      const localReasoning = reasoningByToolCallId.get(toolCallId);
      if (localReasoning) {
        return localReasoning;
      }

      const storedReasoning = getProviderReasoningTrace({
        sessionId: options.sessionId,
        providerId: options.providerId,
        toolCallId,
      })?.reasoningContent;
      if (storedReasoning) {
        reasoningByToolCallId.set(toolCallId, storedReasoning);
        return storedReasoning;
      }
    }

    return null;
  }

  function prepareRequestBody(body: string) {
    const payload = parseRequestBody(body);
    if (!payload) {
      return body;
    }

    if (options.thinkingEnabled) {
      payload.thinking = { type: "enabled" };
      const effort = mapDeepSeekReasoningEffort(options.reasoningEffort);
      if (effort) {
        payload.reasoning_effort = effort;
      }
    } else {
      payload.thinking = { type: "disabled" };
      delete payload.reasoning_effort;
    }

    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    for (const message of messages) {
      if (!isRecord(message) || message.role !== "assistant" || typeof message.reasoning_content === "string") {
        continue;
      }

      const reasoningContent = resolveReasoningContent(getToolCallIds(message));
      if (reasoningContent) {
        message.reasoning_content = reasoningContent;
      }
    }

    return JSON.stringify(payload);
  }

  function captureStreamingResponse(response: Response) {
    if (!response.body) {
      return response;
    }

    const decoder = new TextDecoder();
    let bodyText = "";
    const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bodyText += decoder.decode(chunk, { stream: true });
        controller.enqueue(chunk);
      },
      flush() {
        bodyText += decoder.decode();
        recordAssistantStep(extractStreamingAssistantStep(bodyText));
      },
    }));

    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  function captureJsonResponse(response: Response) {
    void response.clone().text()
      .then((bodyText) => recordAssistantStep(extractJsonAssistantStep(bodyText)))
      .catch(() => {});
    return response;
  }

  return async (input, init) => {
    const nextInit = init && typeof init.body === "string"
      ? { ...init, body: prepareRequestBody(init.body) }
      : init;
    const response = await fetch(input, nextInit);
    const contentType = response.headers.get("content-type") ?? "";

    if (contentType.includes("text/event-stream")) {
      return captureStreamingResponse(response);
    }

    if (contentType.includes("application/json")) {
      return captureJsonResponse(response);
    }

    return response;
  };
}

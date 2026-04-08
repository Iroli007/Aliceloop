import type { ProviderTransportKind, ReasoningEffort } from "@aliceloop/runtime-core";
import type { StoredProviderConfig } from "../repositories/providerRepository";

export type EffectiveProviderTransport = Exclude<ProviderTransportKind, "auto">;

type ProviderTransportInput = Pick<StoredProviderConfig, "transport" | "model">
  | { transport: ProviderTransportKind; model: string };

interface TextToolCallFallbackFormatter {
  source: string;
  toolCallIdPrefix: string;
  buildMissingToolText(toolName: string, availableTools: string[]): string;
  buildFollowupPrompt(toolName: string, input: Record<string, unknown>, output: unknown): string;
  buildSuccessText(toolName: string, output: unknown): string;
  buildErrorText(markup: string, toolName: string, error: unknown): string;
}

export interface ProviderRuntimeProfile {
  renderAssistantText(value: string, final: boolean): string | null;
  textToolCallFallback: TextToolCallFallbackFormatter;
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

function looksLikeBinaryTextDump(value: string) {
  if (/data:image\/[a-z0-9.+-]+;base64,/iu.test(value)) {
    return true;
  }

  return /[A-Za-z0-9+/=]{1800,}/u.test(value.replace(/\s+/g, ""));
}

function sanitizeAssistantTextForChat(value: string) {
  const strippedAttachmentMarkers = value
    .replace(/^\[(Attached files?|Attached directory tree|Attached file content):[^\n]*\]\s*$/gimu, "")
    .trim();
  const normalized = strippedAttachmentMarkers || value;

  if (!looksLikeBinaryTextDump(normalized)) {
    return normalized;
  }

  return [
    "我没有返回可直接显示的真实图片附件。",
    "如果需要二维码、登录页或截图，我应该打开真实页面并用 `browser_screenshot` 或受支持的截图链路把图片作为附件发回聊天，而不是粘贴 base64 / SVG 文本。",
  ].join("\n");
}

export function normalizeProviderModelId(modelId: string) {
  const normalized = modelId.trim().toLowerCase();
  const lastSlashIndex = normalized.lastIndexOf("/");
  return lastSlashIndex >= 0 ? normalized.slice(lastSlashIndex + 1) : normalized;
}

export function resolveProviderTransport(input: ProviderTransportInput): EffectiveProviderTransport {
  if (input.transport !== "auto") {
    return input.transport;
  }

  if (normalizeProviderModelId(input.model).startsWith("claude")) {
    return "anthropic";
  }

  return "openai-compatible";
}

export function normalizeProviderBaseUrl(baseUrl: string, transport: EffectiveProviderTransport) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }

  if (transport === "anthropic" && trimmed.endsWith("/v1/messages")) {
    return trimmed.slice(0, -"/messages".length);
  }

  if (transport === "anthropic" && trimmed.endsWith("/v1")) {
    return trimmed;
  }

  if (transport === "anthropic") {
    return `${trimmed}/v1`;
  }

  return trimmed;
}

function supportsReasoningEffort(input: ProviderTransportInput) {
  if (resolveProviderTransport(input) !== "openai-compatible") {
    return false;
  }

  const modelId = normalizeProviderModelId(input.model);
  return modelId.startsWith("o1")
    || modelId.startsWith("o3")
    || modelId.startsWith("o4-mini")
    || (modelId.startsWith("gpt-5") && !modelId.startsWith("gpt-5-chat"));
}

function mapReasoningEffortToOpenAI(effort: ReasoningEffort) {
  return effort === "off" ? "none" : effort;
}

export function buildAgentProviderOptions(
  input: ProviderTransportInput,
  reasoningEffort: ReasoningEffort,
) {
  if (!supportsReasoningEffort(input)) {
    return undefined;
  }

  return {
    openai: {
      reasoningEffort: mapReasoningEffortToOpenAI(reasoningEffort),
      forceReasoning: true,
    },
  };
}

export function buildProviderModelsEndpoint(baseUrl: string, input: ProviderTransportInput) {
  const normalizedBaseUrl = normalizeProviderBaseUrl(baseUrl, resolveProviderTransport(input));
  return `${normalizedBaseUrl}/models`;
}

const defaultTextToolCallFallback: TextToolCallFallbackFormatter = {
  source: "text_tool_call",
  toolCallIdPrefix: "text-fallback",
  buildMissingToolText(toolName, availableTools) {
    const availablePreview = availableTools.slice(0, 12).join(", ");
    return [
      `模型尝试调用 \`${toolName}\`，但当前回合没有把这个工具加入工具集。`,
      availablePreview
        ? `当前已挂载的工具有：${availablePreview}${availableTools.length > 12 ? " 等" : ""}。`
        : "当前回合没有挂载任何可执行工具。",
    ].join("\n\n");
  },
  buildFollowupPrompt(toolName, input, output) {
    return [
      `You previously attempted to call the tool "${toolName}" with input: ${summarizeUnknown(input, 400) ?? "{}"}`,
      `The tool returned: ${summarizeUnknown(output, 4000) ?? ""}`,
      "Answer the user's original request directly in normal prose.",
      "Do not emit XML, <tool> tags, or tool_call markup.",
    ].join("\n\n");
  },
  buildSuccessText(toolName, output) {
    return [
      `已接住文本形式的工具调用并执行了 \`${toolName}\`。`,
      summarizeUnknown(output, 4000) ?? "",
    ].filter(Boolean).join("\n\n");
  },
  buildErrorText(markup, toolName, error) {
    return [
      `模型返回了文本形式的工具调用：${markup}`,
      `我尝试按 AI-native fallback 执行 \`${toolName}\`，但失败了：${error instanceof Error ? error.message : String(error)}`,
    ].join("\n\n");
  },
};

const minimaxTextToolCallFallback: TextToolCallFallbackFormatter = {
  ...defaultTextToolCallFallback,
  source: "minimax_text_tool_call",
  toolCallIdPrefix: "minimax-fallback",
  buildMissingToolText(toolName, availableTools) {
    const availablePreview = availableTools.slice(0, 12).join(", ");
    return [
      `MiniMax 尝试调用 \`${toolName}\`，但当前回合没有把这个工具加入工具集。`,
      availablePreview
        ? `当前已挂载的工具有：${availablePreview}${availableTools.length > 12 ? " 等" : ""}。`
        : "当前回合没有挂载任何可执行工具。",
    ].join("\n\n");
  },
  buildSuccessText(toolName, output) {
    return [
      `已接住 MiniMax 的文本工具调用并执行了 \`${toolName}\`。`,
      summarizeUnknown(output, 4000) ?? "",
    ].filter(Boolean).join("\n\n");
  },
  buildErrorText(markup, toolName, error) {
    return [
      `MiniMax 返回了文本形式的工具调用：${markup}`,
      `我尝试按 AI-native fallback 执行 \`${toolName}\`，但失败了：${error instanceof Error ? error.message : String(error)}`,
    ].join("\n\n");
  },
};

const defaultRuntimeProfile: ProviderRuntimeProfile = {
  renderAssistantText(value, final) {
    const sanitized = sanitizeAssistantTextForChat(value);
    const trimmed = sanitized.trimStart();
    if (!trimmed) {
      return sanitized;
    }

    if (!final && (/\[TOOL_CALL\]/iu.test(trimmed) || /<tool_call>/iu.test(trimmed))) {
      return null;
    }

    return sanitized;
  },
  textToolCallFallback: defaultTextToolCallFallback,
};

const minimaxRuntimeProfile: ProviderRuntimeProfile = {
  renderAssistantText(value, final) {
    const sanitized = sanitizeAssistantTextForChat(value);
    const trimmed = sanitized.trimStart();
    if (!trimmed) {
      return sanitized;
    }

    if (!final && (/\[TOOL_CALL\]/iu.test(trimmed) || /<tool_call>/iu.test(trimmed))) {
      return null;
    }

    if (final) {
      return sanitized;
    }

    const lowerTrimmed = trimmed.toLowerCase();
    const minimaxPrelude = "minimax:tool_call";

    if (minimaxPrelude.startsWith(lowerTrimmed)) {
      return null;
    }

    if (lowerTrimmed.startsWith(minimaxPrelude)) {
      return "";
    }

    return sanitized;
  },
  textToolCallFallback: minimaxTextToolCallFallback,
};

export function getProviderRuntimeProfile(providerId: string): ProviderRuntimeProfile {
  if (providerId === "minimax") {
    return minimaxRuntimeProfile;
  }

  return defaultRuntimeProfile;
}

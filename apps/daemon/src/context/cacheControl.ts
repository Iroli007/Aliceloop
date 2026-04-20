import type { ModelMessage, ToolSet } from "ai";
import type { JSONObject, SharedV3ProviderOptions } from "@ai-sdk/provider";

export const ANTHROPIC_EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" } as const;

export const ANTHROPIC_CACHE_PROVIDER_OPTIONS = {
  anthropic: {
    cacheControl: ANTHROPIC_EPHEMERAL_CACHE_CONTROL,
  },
} as const;

export type AnthropicCacheProviderOptions = typeof ANTHROPIC_CACHE_PROVIDER_OPTIONS;

export interface CachedSystemPromptMessage {
  role: "system";
  content: string;
  providerOptions?: AnthropicCacheProviderOptions;
}

export function hasAnthropicCacheBreakpoint(providerOptions: SharedV3ProviderOptions | undefined) {
  const anthropic = providerOptions?.anthropic;
  if (!anthropic || typeof anthropic !== "object") {
    return false;
  }

  const cacheControl = (anthropic as JSONObject).cacheControl;
  return Boolean(cacheControl && typeof cacheControl === "object");
}

function mergeAnthropicCacheProviderOptions(
  providerOptions: SharedV3ProviderOptions | undefined,
): SharedV3ProviderOptions {
  const anthropic = providerOptions?.anthropic;
  const anthropicOptions = anthropic && typeof anthropic === "object"
    ? anthropic as JSONObject
    : {};

  return {
    ...(providerOptions ?? {}),
    anthropic: {
      ...anthropicOptions,
      cacheControl: ANTHROPIC_EPHEMERAL_CACHE_CONTROL,
    },
  };
}

export function createCachedSystemPromptMessage(content: string): CachedSystemPromptMessage {
  return {
    role: "system",
    content,
    providerOptions: ANTHROPIC_CACHE_PROVIDER_OPTIONS,
  };
}

export function withMessageCacheBreakpoint(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) {
    return messages;
  }

  const markerIndex = messages.length - 1;
  return messages.map((message, index) => {
    if (index !== markerIndex) {
      return message;
    }

    return {
      ...message,
      providerOptions: mergeAnthropicCacheProviderOptions(
        message.providerOptions,
      ),
    } satisfies ModelMessage;
  });
}

export function withToolCacheBreakpoint(tools: ToolSet, markerToolName: string | null): ToolSet {
  const next: ToolSet = {};

  for (const [toolName, toolDefinition] of Object.entries(tools)) {
    const providerOptions = toolDefinition.providerOptions as SharedV3ProviderOptions | undefined;

    next[toolName] = {
      ...toolDefinition,
      ...(toolName === markerToolName
        ? {
            providerOptions: mergeAnthropicCacheProviderOptions(providerOptions),
          }
        : providerOptions
          ? { providerOptions }
          : {}),
    };
  }

  return next;
}

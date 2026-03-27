import type { ProviderConfig, ProviderKind, ProviderTransportKind } from "./domain";

export interface ProviderDefinition {
  id: ProviderKind;
  label: string;
  transport: ProviderTransportKind;
  defaultBaseUrl: string;
  defaultModel: string;
}

const providerDefinitions: ProviderDefinition[] = [
  {
    id: "minimax",
    label: "MiniMax",
    transport: "anthropic",
    defaultBaseUrl: "https://api.minimaxi.com/anthropic/v1",
    defaultModel: "MiniMax-M2.7-highspeed",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    transport: "openai-compatible",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-flash",
  },
  {
    id: "moonshot",
    label: "Moonshot (Kimi)",
    transport: "openai-compatible",
    defaultBaseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "moonshot-v1-8k",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    transport: "openai-compatible",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
  },
  {
    id: "zhipu",
    label: "Zhipu GLM",
    transport: "openai-compatible",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-5",
  },
  {
    id: "aihubmix",
    label: "AIHubMix",
    transport: "auto",
    defaultBaseUrl: "https://aihubmix.com/v1",
    defaultModel: "gpt-4o-mini",
  },
  {
    id: "openai",
    label: "OpenAI",
    transport: "openai-compatible",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    transport: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-5",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    transport: "openai-compatible",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4.1-mini",
  },
];

const providerDefinitionsById = new Map(providerDefinitions.map((definition) => [definition.id, definition] as const));

const toolModelRecommendationPatterns: Record<ProviderKind, RegExp[]> = {
  minimax: [/minimax.*highspeed/iu, /abab.*6\.5s-chat/iu],
  gemini: [/gemini-2\.0-flash/iu, /gemini-2\.5-flash-lite/iu, /gemini-2\.5-flash/iu, /gemini-1\.5-flash/iu],
  moonshot: [/moonshot-v1-8k/iu, /moonshot.*8k/iu, /kimi.*8k/iu],
  deepseek: [/^deepseek-chat$/iu, /deepseek-chat/iu],
  zhipu: [/glm-4-flash/iu, /glm-4-air/iu, /glm-5-flash/iu, /^glm-5$/iu],
  aihubmix: [/gpt-4o-mini/iu, /deepseek-chat/iu, /gemini-2\.0-flash/iu, /haiku/iu],
  openai: [/^gpt-4o-mini$/iu, /^gpt-4\.1-mini$/iu, /gpt-4o-mini/iu, /gpt-4\.1-mini/iu],
  anthropic: [/haiku/iu],
  openrouter: [/gpt-4o-mini/iu, /deepseek-chat/iu, /gemini-2\.0-flash/iu, /haiku/iu],
};

export function listProviderDefinitions(): ProviderDefinition[] {
  return providerDefinitions.map((definition) => ({ ...definition }));
}

export function getProviderDefinition(providerId: ProviderKind): ProviderDefinition {
  const definition = providerDefinitionsById.get(providerId);
  if (!definition) {
    throw new Error(`Unknown provider definition: ${providerId}`);
  }

  return { ...definition };
}

export function createDefaultProviderConfig(providerId: ProviderKind): ProviderConfig {
  const definition = getProviderDefinition(providerId);
  return {
    id: definition.id,
    label: definition.label,
    transport: definition.transport,
    baseUrl: definition.defaultBaseUrl,
    model: definition.defaultModel,
    enabled: false,
    hasApiKey: false,
    apiKeyMasked: null,
    updatedAt: null,
  };
}

export function listDefaultProviderConfigs(): ProviderConfig[] {
  return providerDefinitions.map((definition) => createDefaultProviderConfig(definition.id));
}

export function recommendToolModel(providerId: ProviderKind, models: string[]): string | null {
  const normalizedModels = models
    .map((model) => model.trim())
    .filter(Boolean);
  const patterns = toolModelRecommendationPatterns[providerId] ?? [];

  for (const pattern of patterns) {
    const match = normalizedModels.find((model) => pattern.test(model));
    if (match) {
      return match;
    }
  }

  return normalizedModels[0] ?? null;
}

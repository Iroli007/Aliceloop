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
    transport: "openai-compatible",
    defaultBaseUrl: "https://api.minimaxi.com/v1",
    defaultModel: "MiniMax-M2.5",
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

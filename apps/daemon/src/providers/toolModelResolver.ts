import { getProviderDefinition, recommendToolModel, type ProviderKind } from "@aliceloop/runtime-core";
import { getActiveProviderConfig, getStoredProviderConfig, listProviderConfigs, type StoredProviderConfig } from "../repositories/providerRepository";
import { getRuntimeSettings } from "../repositories/runtimeSettingsRepository";

function cloneProviderWithModel(config: StoredProviderConfig, model: string): StoredProviderConfig {
  return {
    ...config,
    model,
  };
}

function getConfiguredToolProvider(): StoredProviderConfig | null {
  const settings = getRuntimeSettings();
  if (!settings.toolProviderId) {
    return null;
  }

  const provider = getStoredProviderConfig(settings.toolProviderId);
  if (!provider.apiKey) {
    return null;
  }

  const model = settings.toolModel?.trim() || provider.model;
  return cloneProviderWithModel(provider, model);
}

function listAutoDetectProviderOrder(): ProviderKind[] {
  return ["openai", "anthropic", "gemini", "deepseek", "openrouter", "aihubmix", "moonshot", "zhipu", "minimax"];
}

function getAutoDetectedToolProvider(): StoredProviderConfig | null {
  const publicConfigs = listProviderConfigs();

  for (const providerId of listAutoDetectProviderOrder()) {
    const publicConfig = publicConfigs.find((config) => config.id === providerId);
    if (!publicConfig?.enabled || !publicConfig.hasApiKey) {
      continue;
    }

    const storedConfig = getStoredProviderConfig(providerId);
    const recommendedModel = recommendToolModel(providerId, [
      storedConfig.model,
      getProviderDefinition(providerId).defaultModel,
    ]);
    return cloneProviderWithModel(storedConfig, recommendedModel ?? storedConfig.model);
  }

  return null;
}

export function getToolModelConfig(): StoredProviderConfig | null {
  return getConfiguredToolProvider()
    ?? getAutoDetectedToolProvider()
    ?? getActiveProviderConfig();
}

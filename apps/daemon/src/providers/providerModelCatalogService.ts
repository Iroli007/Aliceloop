import { recommendToolModel, type ProviderKind } from "@aliceloop/runtime-core";
import { getStoredProviderConfig } from "../repositories/providerRepository";
import { buildProviderModelsEndpoint, resolveProviderTransport } from "./providerProfile";

function extractModelIds(payload: unknown) {
  const lists = [
    payload,
    typeof payload === "object" && payload !== null && "data" in payload ? (payload as { data?: unknown }).data : null,
    typeof payload === "object" && payload !== null && "models" in payload ? (payload as { models?: unknown }).models : null,
    typeof payload === "object" && payload !== null && "items" in payload ? (payload as { items?: unknown }).items : null,
  ];

  for (const candidate of lists) {
    if (!Array.isArray(candidate)) {
      continue;
    }

    const modelIds = candidate
      .map((item) => {
        if (typeof item === "string") {
          return item.trim();
        }
        if (item && typeof item === "object" && "id" in item && typeof item.id === "string") {
          return item.id.trim();
        }
        if (item && typeof item === "object" && "name" in item && typeof item.name === "string") {
          return item.name.trim();
        }
        return "";
      })
      .filter(Boolean);

    if (modelIds.length > 0) {
      return [...new Set(modelIds)].sort((left, right) => left.localeCompare(right, "en"));
    }
  }

  return [] as string[];
}

export async function fetchProviderModels(providerId: ProviderKind) {
  const config = getStoredProviderConfig(providerId);
  if (!config.apiKey) {
    throw new Error("provider_api_key_required");
  }

  const endpoint = buildProviderModelsEndpoint(config.baseUrl, config);
  const effectiveTransport = resolveProviderTransport(config);
  const response = await fetch(endpoint, {
    headers: effectiveTransport === "anthropic"
      ? {
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        }
      : {
          Authorization: `Bearer ${config.apiKey}`,
        },
  });

  if (!response.ok) {
    throw new Error(`provider_models_fetch_failed:${response.status}`);
  }

  const payload = await response.json().catch(() => null);
  const models = extractModelIds(payload);
  return {
    providerId,
    models,
    recommendedToolModel: recommendToolModel(providerId, models),
  };
}

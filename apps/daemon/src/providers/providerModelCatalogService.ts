import { recommendToolModel, type ProviderKind, type ProviderTransportKind } from "@aliceloop/runtime-core";
import { getStoredProviderConfig } from "../repositories/providerRepository";

function resolveEffectiveTransport(transport: ProviderTransportKind, model: string) {
  if (transport !== "auto") {
    return transport;
  }

  return model.trim().toLowerCase().startsWith("claude")
    ? "anthropic"
    : "openai-compatible";
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "");
}

function buildModelsEndpoint(baseUrl: string, transport: ProviderTransportKind, model: string) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const effectiveTransport = resolveEffectiveTransport(transport, model);

  if (effectiveTransport === "anthropic") {
    if (normalizedBaseUrl.endsWith("/v1/messages")) {
      return `${normalizedBaseUrl.slice(0, -"/messages".length)}/models`;
    }
    if (normalizedBaseUrl.endsWith("/v1")) {
      return `${normalizedBaseUrl}/models`;
    }
    return `${normalizedBaseUrl}/v1/models`;
  }

  return `${normalizedBaseUrl}/models`;
}

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

  const endpoint = buildModelsEndpoint(config.baseUrl, config.transport, config.model);
  const effectiveTransport = resolveEffectiveTransport(config.transport, config.model);
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

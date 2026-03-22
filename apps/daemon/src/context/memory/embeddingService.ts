import { createOpenAI } from "@ai-sdk/openai";
import { embed, embedMany } from "ai";
import {
  DEFAULT_MEMORY_CONFIG,
  type MemoryEmbeddingModel,
} from "@aliceloop/runtime-core";
import { getActiveProviderConfig, getStoredProviderConfig } from "../../repositories/providerRepository";

interface EmbeddingRequestOptions {
  dimension?: number;
  abortSignal?: AbortSignal;
}

function normalizeGatewayBaseUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }

  if (trimmed.endsWith("/v1/messages")) {
    return trimmed.slice(0, -"/messages".length);
  }

  if (trimmed.endsWith("/v1")) {
    return trimmed;
  }

  return `${trimmed}/v1`;
}

function resolveOpenAICompatibleSettings() {
  const explicitApiKey = process.env.OPENAI_API_KEY?.trim();
  if (explicitApiKey) {
    return {
      apiKey: explicitApiKey,
      baseURL: process.env.OPENAI_BASE_URL?.trim() || undefined,
    };
  }

  const dedicatedOpenAIProvider = getStoredProviderConfig("openai");
  if (dedicatedOpenAIProvider.apiKey) {
    return {
      apiKey: dedicatedOpenAIProvider.apiKey,
      baseURL: normalizeGatewayBaseUrl(dedicatedOpenAIProvider.baseUrl) || undefined,
    };
  }

  const activeProvider = getActiveProviderConfig();
  if (!activeProvider?.apiKey) {
    return null;
  }

  const normalizedModel = activeProvider.model.trim().toLowerCase();
  const effectiveTransport = activeProvider.transport === "auto" && normalizedModel.startsWith("claude")
    ? "anthropic"
    : activeProvider.transport;

  if (effectiveTransport === "anthropic") {
    return null;
  }

  return {
    apiKey: activeProvider.apiKey,
    baseURL: normalizeGatewayBaseUrl(activeProvider.baseUrl) || undefined,
  };
}

function getEmbeddingProvider() {
  const settings = resolveOpenAICompatibleSettings();
  if (!settings) {
    throw new Error("No OpenAI-compatible embedding provider is configured.");
  }

  return createOpenAI({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    name: "aliceloop-embeddings",
  });
}

function buildEmbeddingProviderOptions(options?: EmbeddingRequestOptions) {
  if (!options?.dimension) {
    return undefined;
  }

  return {
    openai: {
      dimensions: options.dimension,
    },
  };
}

export function hasEmbeddingProvider() {
  return resolveOpenAICompatibleSettings() !== null;
}

export async function generateEmbedding(
  text: string,
  model: MemoryEmbeddingModel = DEFAULT_MEMORY_CONFIG.embeddingModel,
  options?: EmbeddingRequestOptions,
): Promise<Float32Array> {
  const provider = getEmbeddingProvider();
  const result = await embed({
    model: provider.embeddingModel(model),
    value: text,
    abortSignal: options?.abortSignal,
    providerOptions: buildEmbeddingProviderOptions(options),
  });

  return new Float32Array(result.embedding);
}

export async function generateEmbeddingsBatch(
  texts: string[],
  model: MemoryEmbeddingModel = DEFAULT_MEMORY_CONFIG.embeddingModel,
  options?: EmbeddingRequestOptions,
): Promise<Float32Array[]> {
  if (texts.length === 0) {
    return [];
  }

  const provider = getEmbeddingProvider();
  const result = await embedMany({
    model: provider.embeddingModel(model),
    values: texts,
    abortSignal: options?.abortSignal,
    providerOptions: buildEmbeddingProviderOptions(options),
  });

  return result.embeddings.map((embedding) => new Float32Array(embedding));
}

export function serializeEmbedding(vector: Float32Array) {
  return Buffer.from(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
}

export function deserializeEmbedding(blob: Buffer) {
  const buffer = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return new Float32Array(buffer);
}

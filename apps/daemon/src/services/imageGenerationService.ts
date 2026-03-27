import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  listProviderDefinitions,
  type ProviderKind,
  type ProviderTransportKind,
} from "@aliceloop/runtime-core";
import { getDataDir } from "../db/client";
import { getStoredProviderConfig } from "../repositories/providerRepository";

interface GenerateImageInput {
  prompt: string;
  providerId?: ProviderKind;
  model?: string;
  size?: string;
  outputPath?: string;
}

interface ImageGenerationCandidate {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
  mime_type?: string;
}

export interface GeneratedImageResult {
  providerId: ProviderKind;
  model: string;
  prompt: string;
  revisedPrompt: string | null;
  size: string;
  outputPath: string;
  mimeType: string;
  byteSize: number;
  source: "b64_json" | "url";
}

const supportedTransports = new Set<ProviderTransportKind>(["openai-compatible", "auto"]);
const defaultImageModels: Record<ProviderKind, string | null> = {
  openai: "gpt-image-1",
  openrouter: "openai/gpt-image-1",
  aihubmix: "gpt-image-1",
  gemini: null,
  moonshot: null,
  deepseek: null,
  zhipu: null,
  anthropic: null,
  minimax: null,
};

function resolveDefaultOutputPath(extension: string) {
  const safeExtension = extension.startsWith(".") ? extension : ".png";
  return join(getDataDir(), "generated-images", `aliceloop-image-${Date.now()}${safeExtension}`);
}

function resolveMimeType(candidate: ImageGenerationCandidate, response: Response | null) {
  const hinted = candidate.mime_type?.trim() || response?.headers.get("content-type")?.trim() || "";
  if (hinted) {
    return hinted.split(";")[0].trim().toLowerCase();
  }

  return "image/png";
}

function extensionForMimeType(mimeType: string) {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return ".png";
  }
}

function normalizeSize(input: string | undefined) {
  const normalized = input?.trim() || "1024x1024";
  if (!/^\d+x\d+$/i.test(normalized)) {
    throw new Error(`Invalid image size: ${normalized}. Use WIDTHxHEIGHT, for example 1024x1024.`);
  }

  return normalized.toLowerCase();
}

function resolveProvider(providerId: ProviderKind | undefined) {
  if (providerId) {
    return getStoredProviderConfig(providerId);
  }

  const supportedEnabled = listProviderDefinitions()
    .map((provider) => getStoredProviderConfig(provider.id))
    .find((provider) => provider.enabled && supportedTransports.has(provider.transport));

  if (supportedEnabled) {
    return supportedEnabled;
  }

  throw new Error(
    "No enabled image generation provider is configured. " +
    "Enable an openai-compatible provider first, or pass --provider explicitly.",
  );
}

async function fetchGeneratedBinary(candidate: ImageGenerationCandidate) {
  if (candidate.b64_json?.trim()) {
    return {
      source: "b64_json" as const,
      binary: Buffer.from(candidate.b64_json, "base64"),
      response: null,
    };
  }

  const remoteUrl = candidate.url?.trim();
  if (!remoteUrl) {
    throw new Error("Image backend returned neither b64_json nor url.");
  }

  const response = await fetch(remoteUrl, {
    headers: {
      "User-Agent": "Aliceloop/1.0 (image-gen)",
      Accept: "image/*, application/octet-stream;q=0.9, */*;q=0.1",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Failed to download generated image (${response.status} ${response.statusText}).`);
  }

  const binary = Buffer.from(await response.arrayBuffer());
  return {
    source: "url" as const,
    binary,
    response,
  };
}

export async function generateImage(input: GenerateImageInput): Promise<GeneratedImageResult> {
  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new Error("Image prompt is required.");
  }

  const provider = resolveProvider(input.providerId);
  if (!supportedTransports.has(provider.transport)) {
    throw new Error(
      `Provider ${provider.id} uses ${provider.transport} transport, which does not expose an OpenAI-compatible image API.`,
    );
  }

  const model = input.model?.trim() || defaultImageModels[provider.id];
  if (!model) {
    throw new Error(
      `Provider ${provider.id} has no default image model. Pass an explicit model name with --model.`,
    );
  }

  const size = normalizeSize(input.size);
  const response = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      prompt,
      size,
      n: 1,
      response_format: "b64_json",
    }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Image generation request failed (${response.status}): ${responseText || response.statusText}`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error("Image backend returned a non-JSON response.");
  }

  const candidate = Array.isArray((payload as { data?: unknown[] }).data)
    ? (payload as { data: ImageGenerationCandidate[] }).data[0]
    : null;
  if (!candidate) {
    throw new Error("Image backend returned no image data.");
  }

  const binaryResult = await fetchGeneratedBinary(candidate);
  const mimeType = resolveMimeType(candidate, binaryResult.response);
  const outputPath = input.outputPath?.trim()
    || resolveDefaultOutputPath(extensionForMimeType(mimeType));

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, binaryResult.binary);

  return {
    providerId: provider.id,
    model,
    prompt,
    revisedPrompt: candidate.revised_prompt?.trim() || null,
    size,
    outputPath,
    mimeType,
    byteSize: binaryResult.binary.byteLength,
    source: binaryResult.source,
  };
}

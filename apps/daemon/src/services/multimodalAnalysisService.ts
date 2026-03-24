import { readFile, rm } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { Output, experimental_transcribe as transcribe, generateText, type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { createProviderModel } from "../providers/providerModelFactory";
import { deriveModelCapabilities, type ModelCapabilities } from "../providers/modelCapabilities";
import { getDataDir } from "../db/client";
import { getActiveProviderConfig, type StoredProviderConfig } from "../repositories/providerRepository";
import { getSessionProjectBinding, listSessionAttachmentSandboxRoots } from "../repositories/sessionRepository";

const audioSummarySchema = z.object({
  summary: z.string().trim().min(1).max(1_200),
  moments: z.array(
    z.object({
      label: z.string().trim().min(1).max(80),
      text: z.string().trim().min(1).max(240),
      startSecond: z.number().min(0).nullable().optional(),
      endSecond: z.number().min(0).nullable().optional(),
    }),
  ).max(6).default([]),
});

const visualSummarySchema = z.object({
  summary: z.string().trim().min(1).max(800),
  observations: z.array(z.string().trim().min(1).max(200)).max(6).default([]),
});

const rollingVideoSummarySchema = z.object({
  rollingSummary: z.string().trim().min(1).max(1_200),
  observations: z.array(z.string().trim().min(1).max(200)).max(6).default([]),
});

const visionRefusalPattern = /cannot access|can't access|无法直接访问|无法查看|外部图片|external image|expired url|provide (?:the )?image|图片直接内嵌|请提供.*图片/i;

export interface AudioUnderstandingMoment {
  label: string;
  text: string;
  startSecond: number | null;
  endSecond: number | null;
}

export interface AudioUnderstandingResult {
  path: string;
  transcript: string | null;
  summary: string | null;
  moments: AudioUnderstandingMoment[];
  limitations: string[];
  capabilities: ModelCapabilities;
  method: "transcription" | "unsupported";
  language: string | null;
}

export interface VisualUnderstandingResult {
  summary: string | null;
  observations: string[];
  limitations: string[];
  capabilities: ModelCapabilities;
}

export interface RollingVideoSummaryInput {
  goal?: string;
  previousSummary?: string;
  currentTimeSeconds?: number | null;
  durationSeconds?: number | null;
  subtitles: string[];
  audioSummary?: string | null;
  visualSummary?: string | null;
  limitations?: string[];
}

function truncate(text: string, maxLength: number) {
  return text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}…` : text;
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

function describeAudioSupportLimitation(config: StoredProviderConfig | null) {
  if (!config?.apiKey) {
    return "当前没有可用的大模型 provider，无法理解音频内容。";
  }

  const normalizedBaseUrl = config.baseUrl.trim().toLowerCase();
  const normalizedLabel = config.label.trim().toLowerCase();
  const normalizedModel = config.model.trim().toLowerCase();

  if (
    config.transport === "anthropic"
    && (normalizedBaseUrl.includes("minimaxi.com") || normalizedLabel.includes("minimax") || normalizedModel.includes("minimax"))
  ) {
    return "当前 MiniMax Anthropic 文本链路不提供音频转写能力；网页视频会退化为字幕加画面理解。";
  }

  if (config.transport === "anthropic") {
    return "当前 provider 走的是 Anthropic 风格文本链路，没有可用的音频转写接口。";
  }

  return "当前 provider 没有可用的音频理解路径，已跳过音频转写。";
}

function resolveAllowedRoots(sessionId: string) {
  const project = getSessionProjectBinding(sessionId);
  const attachmentRoots = listSessionAttachmentSandboxRoots(sessionId);
  const internalRoots = [
    resolve(getDataDir(), "browser-screenshots"),
    resolve(getDataDir(), "browser-watch-audio"),
  ];

  return [
    ...(project?.projectPath ? [resolve(project.projectPath)] : []),
    ...attachmentRoots.readRoots.map((root) => resolve(root)),
    ...internalRoots,
  ];
}

function isPathWithinRoot(targetPath: string, rootPath: string) {
  const target = resolve(targetPath);
  const root = resolve(rootPath);
  return target === root || target.startsWith(`${root}/`);
}

function isKnownInternalArtifactPath(targetPath: string) {
  const normalized = resolve(targetPath);
  return normalized.includes("/browser-screenshots/") || normalized.includes("/browser-watch-audio/");
}

function assertReadableSessionPath(sessionId: string, targetPath: string, options?: { allowInternalDataRoot?: boolean }) {
  const internalRoot = resolve(getDataDir());
  const allowedRoots = resolveAllowedRoots(sessionId).filter((root) => {
    return options?.allowInternalDataRoot || !isPathWithinRoot(root, internalRoot);
  });

  if (options?.allowInternalDataRoot && isKnownInternalArtifactPath(targetPath)) {
    return;
  }

  if (allowedRoots.some((root) => isPathWithinRoot(targetPath, root))) {
    return;
  }

  throw new Error(`audio_understand cannot access path outside the current session roots: ${targetPath}`);
}

function resolveTranscriptionCandidates(config: StoredProviderConfig) {
  const lowerModel = config.model.trim().toLowerCase();
  if (lowerModel.includes("transcribe")) {
    return [config.model];
  }

  return ["gpt-4o-mini-transcribe", "whisper-1"];
}

function inferImageMimeType(filePath: string) {
  switch (extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

function buildOpenAIProvider(config: StoredProviderConfig) {
  return createOpenAI({
    baseURL: normalizeGatewayBaseUrl(config.baseUrl),
    apiKey: config.apiKey ?? "",
  });
}

async function summarizeTranscriptWithModel(
  config: StoredProviderConfig,
  transcript: string,
  segments: Array<{ text: string; startSecond: number; endSecond: number }>,
  instruction?: string,
) {
  const response = await generateText({
    model: createProviderModel(config),
    temperature: 0.2,
    output: Output.object({
      schema: audioSummarySchema,
      name: "audio_understanding",
      description: "Structured understanding of an audio clip or voice recording.",
    }),
    prompt: [
      "You are analyzing spoken audio.",
      "Return a concise factual summary and up to 6 key moments.",
      "Do not invent content that is not in the transcript.",
      instruction ? `User goal: ${instruction}` : "User goal: summarize the audio faithfully.",
      "",
      "Transcript:",
      truncate(transcript, 12_000),
      "",
      "Time-coded segments:",
      truncate(
        segments
          .slice(0, 24)
          .map((segment) => `${segment.startSecond.toFixed(1)}-${segment.endSecond.toFixed(1)}s: ${segment.text}`)
          .join("\n"),
        6_000,
      ) || "(no segments available)",
    ].join("\n"),
  });

  return response.output;
}

async function describeImageWithModel(
  config: StoredProviderConfig,
  imagePath: string,
  promptText: string,
) {
  const image = await readFile(imagePath);
  const message: ModelMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: promptText,
      },
      {
        type: "image",
        image,
        mediaType: inferImageMimeType(imagePath),
      },
    ],
  };

  const response = await generateText({
    model: createProviderModel(config),
    temperature: 0.2,
    output: Output.object({
      schema: visualSummarySchema,
      name: "visual_summary",
      description: "Short structured observations from a single video player screenshot.",
    }),
    messages: [
      {
        role: "system",
        content: "You are given the actual image bytes directly. Never claim you cannot access a URL, cannot open the image, or need the user to re-upload it. If the frame is unclear, say the frame itself is unclear and describe only what is visibly present.",
      },
      message,
    ],
  });

  return response.output;
}

function looksLikeVisionRefusal(result: { summary: string; observations: string[] }) {
  if (visionRefusalPattern.test(result.summary)) {
    return true;
  }

  return result.observations.some((entry) => visionRefusalPattern.test(entry));
}

export async function understandAudioFile(
  sessionId: string,
  input: {
    path: string;
    instruction?: string;
    language?: string;
    allowInternalPath?: boolean;
  },
): Promise<AudioUnderstandingResult> {
  const provider = getActiveProviderConfig();
  const capabilities = deriveModelCapabilities(provider);
  const normalizedPath = resolve(input.path);
  assertReadableSessionPath(sessionId, normalizedPath, {
    allowInternalDataRoot: input.allowInternalPath,
  });

  if (!provider?.apiKey) {
    return {
      path: normalizedPath,
      transcript: null,
      summary: null,
      moments: [],
      limitations: [describeAudioSupportLimitation(provider)],
      capabilities,
      method: "unsupported",
      language: null,
    };
  }

  if (!capabilities.audioInput) {
    return {
      path: normalizedPath,
      transcript: null,
      summary: null,
      moments: [],
      limitations: [describeAudioSupportLimitation(provider)],
      capabilities,
      method: "unsupported",
      language: null,
    };
  }

  const audioData = await readFile(normalizedPath);
  const openaiProvider = buildOpenAIProvider(provider);
  const limitations: string[] = [];
  let transcriptText: string | null = null;
  let segments: Array<{ text: string; startSecond: number; endSecond: number }> = [];
  let language: string | null = null;
  let lastError: unknown = null;

  for (const candidate of resolveTranscriptionCandidates(provider)) {
    try {
      const result = await transcribe({
        model: openaiProvider.transcription(candidate as never),
        audio: audioData,
        providerOptions: {
          openai: {
            language: input.language,
            prompt: input.instruction,
          },
        },
      });
      transcriptText = result.text.trim() || null;
      segments = result.segments;
      language = result.language ?? null;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!transcriptText) {
    return {
      path: normalizedPath,
      transcript: null,
      summary: null,
      moments: [],
      limitations: [
        "provider 音频转写调用失败，当前回合无法直接理解声音。",
        lastError instanceof Error ? truncate(lastError.message, 240) : "unknown audio transcription failure",
      ],
      capabilities,
      method: "unsupported",
      language,
    };
  }

  try {
    const structured = await summarizeTranscriptWithModel(provider, transcriptText, segments, input.instruction);
    return {
      path: normalizedPath,
      transcript: transcriptText,
      summary: structured.summary,
      moments: structured.moments.map((moment) => ({
        label: moment.label,
        text: moment.text,
        startSecond: moment.startSecond ?? null,
        endSecond: moment.endSecond ?? null,
      })),
      limitations,
      capabilities,
      method: "transcription",
      language,
    };
  } catch (error) {
    limitations.push(
      error instanceof Error
        ? `音频摘要阶段失败，已退回 transcript-only：${truncate(error.message, 200)}`
        : "音频摘要阶段失败，已退回 transcript-only。",
    );
    return {
      path: normalizedPath,
      transcript: transcriptText,
      summary: truncate(transcriptText, 600),
      moments: segments.slice(0, 6).map((segment, index) => ({
        label: `片段 ${index + 1}`,
        text: truncate(segment.text, 200),
        startSecond: segment.startSecond,
        endSecond: segment.endSecond,
      })),
      limitations,
      capabilities,
      method: "transcription",
      language,
    };
  }
}

export async function describeImageFile(
  sessionId: string,
  input: {
    path: string;
    prompt: string;
    allowInternalPath?: boolean;
  },
): Promise<VisualUnderstandingResult> {
  const provider = getActiveProviderConfig();
  const capabilities = deriveModelCapabilities(provider);
  const normalizedPath = resolve(input.path);
  assertReadableSessionPath(sessionId, normalizedPath, {
    allowInternalDataRoot: input.allowInternalPath,
  });

  if (!provider?.apiKey) {
    return {
      summary: null,
      observations: [],
      limitations: ["当前没有可用的大模型 provider，无法理解截图内容。"],
      capabilities,
    };
  }

  if (!capabilities.imageInput) {
    return {
      summary: null,
      observations: [],
      limitations: ["当前 provider 不支持图片理解，已跳过截图分析。"],
      capabilities,
    };
  }

  try {
    const structured = await describeImageWithModel(provider, normalizedPath, input.prompt);
    if (looksLikeVisionRefusal(structured)) {
      return {
        summary: null,
        observations: [],
        limitations: ["当前 provider 的图像理解结果不可用，已跳过这一帧画面分析。"],
        capabilities,
      };
    }

    return {
      summary: structured.summary,
      observations: structured.observations,
      limitations: [],
      capabilities,
    };
  } catch (error) {
    return {
      summary: null,
      observations: [],
      limitations: [
        error instanceof Error
          ? `截图理解失败：${truncate(error.message, 240)}`
          : "截图理解失败。",
      ],
      capabilities,
    };
  }
}

export async function synthesizeRollingVideoSummary(
  input: RollingVideoSummaryInput,
): Promise<{
  rollingSummary: string;
  observations: string[];
}> {
  const provider = getActiveProviderConfig();
  if (!provider?.apiKey) {
    const merged = [
      input.previousSummary?.trim(),
      input.audioSummary?.trim(),
      input.visualSummary?.trim(),
      input.subtitles.length > 0 ? `字幕：${input.subtitles.join(" / ")}` : null,
    ].filter(Boolean);
    return {
      rollingSummary: merged.join("\n") || "当前没有足够的新视频证据。",
      observations: input.limitations?.slice(0, 6) ?? [],
    };
  }

  try {
    const response = await generateText({
      model: createProviderModel(provider),
      temperature: 0.2,
      output: Output.object({
        schema: rollingVideoSummarySchema,
        name: "video_watch_update",
        description: "Rolling summary for a web video watch session.",
      }),
      prompt: [
        "Update the rolling understanding of a web video without inventing unseen details.",
        input.goal ? `User goal: ${input.goal}` : "User goal: understand what the current video is saying and showing.",
        input.previousSummary ? `Previous rolling summary:\n${truncate(input.previousSummary, 1_400)}` : "Previous rolling summary: (none)",
        `Playback position: ${input.currentTimeSeconds ?? "unknown"} / ${input.durationSeconds ?? "unknown"} seconds`,
        input.subtitles.length > 0 ? `Latest subtitles:\n${input.subtitles.join("\n")}` : "Latest subtitles: (none)",
        input.audioSummary ? `Latest audio evidence:\n${input.audioSummary}` : "Latest audio evidence: (none)",
        input.visualSummary ? `Latest visual evidence:\n${input.visualSummary}` : "Latest visual evidence: (none)",
        input.limitations?.length ? `Current limitations:\n- ${input.limitations.join("\n- ")}` : "Current limitations: (none)",
      ].join("\n\n"),
    });
    return response.output;
  } catch {
    const merged = [
      input.previousSummary?.trim(),
      input.audioSummary?.trim(),
      input.visualSummary?.trim(),
      input.subtitles.length > 0 ? `字幕：${input.subtitles.join(" / ")}` : null,
    ].filter(Boolean);
    return {
      rollingSummary: merged.join("\n") || "当前没有足够的新视频证据。",
      observations: input.limitations?.slice(0, 6) ?? [],
    };
  }
}

export async function cleanupGeneratedAnalysisFile(filePath: string | null | undefined) {
  if (!filePath) {
    return;
  }

  await rm(filePath, { force: true }).catch(() => undefined);
}

import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Output, experimental_transcribe as transcribe, generateText, type ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { createProviderModel } from "../providers/providerModelFactory";
import { deriveModelCapabilities, type ModelCapabilities } from "../providers/modelCapabilities";
import { getDataDir } from "../db/client";
import { getActiveProviderConfig, getStoredProviderConfig, type StoredProviderConfig } from "../repositories/providerRepository";
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
  actionableTargets: z.array(z.string().trim().min(1).max(200)).max(6).default([]),
  nextAction: z.string().trim().min(1).max(240).nullable().default(null),
});

const rollingVideoSummarySchema = z.object({
  rollingSummary: z.string().trim().min(1).max(1_200),
  observations: z.array(z.string().trim().min(1).max(200)).max(6).default([]),
});

const videoAnalysisSchema = z.object({
  answer: z.string().trim().min(1).max(2_000),
  highlights: z.array(z.string().trim().min(1).max(240)).max(8).default([]),
  spokenLanguage: z.string().trim().min(1).max(80).nullable().default(null),
  caveats: z.array(z.string().trim().min(1).max(240)).max(6).default([]),
});

const audioAnalysisSchema = z.object({
  answer: z.string().trim().min(1).max(2_000),
  highlights: z.array(z.string().trim().min(1).max(240)).max(8).default([]),
  caveats: z.array(z.string().trim().min(1).max(240)).max(6).default([]),
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
  actionableTargets: string[];
  nextAction: string | null;
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

export interface VideoFileAnalysisResult {
  path: string;
  providerId: "gemini";
  model: string;
  prompt: string;
  metadata: {
    durationSeconds: number | null;
    width: number | null;
    height: number | null;
    videoCodec: string | null;
    audioCodec: string | null;
    bitRate: number | null;
    container: string | null;
  };
  visualSummary: string | null;
  visualObservations: string[];
  transcript: string | null;
  answer: string | null;
  highlights: string[];
  spokenLanguage: string | null;
  limitations: string[];
  artifacts: {
    gridImagePath: string | null;
    transcriptPath: string | null;
  };
}

export interface AudioFileAnalysisResult {
  path: string;
  providerId: "gemini";
  model: string;
  prompt: string;
  metadata: {
    durationSeconds: number | null;
    sampleRate: number | null;
    channels: number | null;
    codec: string | null;
    bitRate: number | null;
    container: string | null;
  };
  spectrogramSummary: string | null;
  spectrogramObservations: string[];
  transcript: string | null;
  answer: string | null;
  highlights: string[];
  limitations: string[];
  artifacts: {
    spectrogramPath: string | null;
    transcriptPath: string | null;
  };
}

function truncate(text: string, maxLength: number) {
  return text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}…` : text;
}

function normalizeGatewayBaseUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }

  return trimmed;
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

  throw new Error(`Audio analysis cannot access path outside the current session roots: ${targetPath}`);
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

function getGeminiProviderConfig(commandName: string) {
  const config = getStoredProviderConfig("gemini");
  if (!config || !config.enabled || !config.apiKey) {
    throw new Error(`Gemini provider is not available. Enable the gemini provider with an API key before using \`${commandName}\`.`);
  }

  return config;
}

function runProcess(command: string, args: string[]) {
  return spawnSync(command, args, {
    encoding: "utf8",
  });
}

function commandExists(command: string) {
  const result = runProcess("which", [command]);
  return result.status === 0 && Boolean(result.stdout.trim());
}

function parseFfprobeMetadata(stdout: string) {
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string; bit_rate?: string; format_name?: string };
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
  };
  const videoStream = parsed.streams?.find((stream) => stream.codec_type === "video");
  const audioStream = parsed.streams?.find((stream) => stream.codec_type === "audio");
  return {
    durationSeconds: parsed.format?.duration ? Number(parsed.format.duration) : null,
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    videoCodec: videoStream?.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
    bitRate: parsed.format?.bit_rate ? Number(parsed.format.bit_rate) : null,
    container: parsed.format?.format_name ?? null,
  };
}

function parseAudioFfprobeMetadata(stdout: string) {
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string; bit_rate?: string; format_name?: string };
    streams?: Array<{ codec_type?: string; codec_name?: string; sample_rate?: string; channels?: number }>;
  };
  const audioStream = parsed.streams?.find((stream) => stream.codec_type === "audio");
  return {
    durationSeconds: parsed.format?.duration ? Number(parsed.format.duration) : null,
    sampleRate: audioStream?.sample_rate ? Number(audioStream.sample_rate) : null,
    channels: audioStream?.channels ?? null,
    codec: audioStream?.codec_name ?? null,
    bitRate: parsed.format?.bit_rate ? Number(parsed.format.bit_rate) : null,
    container: parsed.format?.format_name ?? null,
  };
}

async function transcribeWithWhisper(audioPath: string, outputDir: string) {
  if (!commandExists("whisper")) {
    return {
      transcript: null,
      transcriptPath: null,
      limitation: "本机没有安装 whisper，已跳过音频转写。",
    };
  }

  const whisper = runProcess("whisper", [
    audioPath,
    "--model",
    "turbo",
    "--output_format",
    "txt",
    "--output_dir",
    outputDir,
  ]);
  if (whisper.status !== 0) {
    return {
      transcript: null,
      transcriptPath: null,
      limitation: whisper.stderr.trim() || "whisper 转写失败。",
    };
  }

  const outputFiles = (await readdir(outputDir)).filter((fileName) => fileName.endsWith(".txt")).sort();
  const transcriptPath = outputFiles[0] ? join(outputDir, outputFiles[0]) : null;
  if (!transcriptPath) {
    return {
      transcript: null,
      transcriptPath: null,
      limitation: "whisper 没有产出 transcript 文件。",
    };
  }

  const transcript = (await readFile(transcriptPath, "utf8")).trim() || null;
  return {
    transcript,
    transcriptPath,
    limitation: transcript ? null : "whisper transcript 为空。",
  };
}

async function synthesizeVideoAnswer(
  provider: StoredProviderConfig,
  prompt: string,
  metadata: VideoFileAnalysisResult["metadata"],
  visualSummary: string | null,
  visualObservations: string[],
  transcript: string | null,
  limitations: string[],
) {
  const response = await generateText({
    model: createProviderModel(provider),
    temperature: 0.2,
    output: Output.object({
      schema: videoAnalysisSchema,
      name: "video_file_analysis",
      description: "Structured answer about a local video file based on extracted evidence.",
    }),
    prompt: [
      "You are answering questions about a local video file from extracted evidence only.",
      "Do not claim direct native video access. Base the answer on metadata, a thumbnail grid summary, and optional transcript evidence.",
      `User goal: ${prompt}`,
      "",
      "Metadata:",
      JSON.stringify(metadata, null, 2),
      "",
      `Visual summary: ${visualSummary ?? "(none)"}`,
      visualObservations.length > 0 ? `Visual observations:\n- ${visualObservations.join("\n- ")}` : "Visual observations: (none)",
      "",
      transcript ? `Transcript excerpt:\n${truncate(transcript, 8_000)}` : "Transcript excerpt: (none)",
      limitations.length > 0 ? `Known limitations:\n- ${limitations.join("\n- ")}` : "Known limitations: (none)",
    ].join("\n"),
  });

  return response.output;
}

async function synthesizeAudioAnswer(
  provider: StoredProviderConfig,
  prompt: string,
  metadata: AudioFileAnalysisResult["metadata"],
  spectrogramSummary: string | null,
  spectrogramObservations: string[],
  transcript: string | null,
  limitations: string[],
) {
  const response = await generateText({
    model: createProviderModel(provider),
    temperature: 0.2,
    output: Output.object({
      schema: audioAnalysisSchema,
      name: "audio_file_analysis",
      description: "Structured answer about a local audio or music file based on extracted evidence.",
    }),
    prompt: [
      "You are answering questions about a local audio or music file from extracted evidence only.",
      "Base the answer on metadata, a spectrogram summary, and optional transcript evidence.",
      `User goal: ${prompt}`,
      "",
      "Metadata:",
      JSON.stringify(metadata, null, 2),
      "",
      `Spectrogram summary: ${spectrogramSummary ?? "(none)"}`,
      spectrogramObservations.length > 0 ? `Spectrogram observations:\n- ${spectrogramObservations.join("\n- ")}` : "Spectrogram observations: (none)",
      "",
      transcript ? `Transcript / lyrics excerpt:\n${truncate(transcript, 8_000)}` : "Transcript / lyrics excerpt: (none)",
      limitations.length > 0 ? `Known limitations:\n- ${limitations.join("\n- ")}` : "Known limitations: (none)",
    ].join("\n"),
  });

  return response.output;
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
        actionableTargets: [],
        nextAction: null,
      capabilities,
    };
  }

  if (!capabilities.imageInput) {
    return {
      summary: null,
      observations: [],
        limitations: ["当前 provider 不支持图片理解，已跳过截图分析。"],
        actionableTargets: [],
        nextAction: null,
      capabilities,
    };
  }

  try {
    const structured = await describeImageWithModel(provider, normalizedPath, input.prompt);
    if (looksLikeVisionRefusal(structured)) {
      return {
        summary: null,
        observations: [],
        actionableTargets: [],
        nextAction: null,
        limitations: ["当前 provider 的图像理解结果不可用，已跳过这一帧画面分析。"],
        capabilities,
      };
    }

    return {
      summary: structured.summary,
      observations: structured.observations,
      actionableTargets: structured.actionableTargets,
      nextAction: structured.nextAction,
      limitations: [],
      capabilities,
    };
  } catch (error) {
    return {
      summary: null,
      observations: [],
      actionableTargets: [],
      nextAction: null,
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

export async function analyzeVideoFile(input: {
  path: string;
  prompt?: string;
  keepArtifacts?: boolean;
}): Promise<VideoFileAnalysisResult> {
  const normalizedPath = resolve(input.path);
  if (!existsSync(normalizedPath)) {
    throw new Error(`Video file not found: ${normalizedPath}`);
  }

  const provider = getGeminiProviderConfig("aliceloop video analyze");
  const prompt = input.prompt?.trim() || "Describe what's happening in this video.";
  const limitations: string[] = [];
  const metadata: VideoFileAnalysisResult["metadata"] = {
    durationSeconds: null,
    width: null,
    height: null,
    videoCodec: null,
    audioCodec: null,
    bitRate: null,
    container: null,
  };

  if (!commandExists("ffprobe")) {
    throw new Error("`aliceloop video analyze` requires ffprobe. Install ffmpeg/ffprobe first.");
  }
  if (!commandExists("ffmpeg")) {
    throw new Error("`aliceloop video analyze` requires ffmpeg. Install ffmpeg first.");
  }

  const ffprobe = runProcess("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration,bit_rate,format_name:stream=codec_type,codec_name,width,height",
    "-of",
    "json",
    normalizedPath,
  ]);
  if (ffprobe.status !== 0) {
    throw new Error(ffprobe.stderr.trim() || "ffprobe failed");
  }
  Object.assign(metadata, parseFfprobeMetadata(ffprobe.stdout));

  const tempDir = join(tmpdir(), `aliceloop-video-analyze-${randomUUID()}`);
  const gridImagePath = join(tempDir, "grid.jpg");
  const audioPath = join(tempDir, "audio.wav");
  const whisperOutputDir = join(tempDir, "whisper");

  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  const mkdir = runProcess("mkdir", ["-p", tempDir, whisperOutputDir]);
  if (mkdir.status !== 0) {
    throw new Error(mkdir.stderr.trim() || "Failed to create temp directory");
  }

  let transcript: string | null = null;
  let transcriptPath: string | null = null;
  let visualSummary: string | null = null;
  let visualObservations: string[] = [];

  try {
    const durationSeconds = metadata.durationSeconds && Number.isFinite(metadata.durationSeconds)
      ? metadata.durationSeconds
      : 9;
    const frameInterval = Math.max(durationSeconds / 9, 1);
    const grid = runProcess("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      normalizedPath,
      "-vf",
      `fps=1/${frameInterval.toFixed(2)},scale=320:-1,tile=3x3`,
      "-frames:v",
      "1",
      gridImagePath,
      "-y",
    ]);
    if (grid.status !== 0) {
      limitations.push(grid.stderr.trim() || "视频缩略图提取失败。");
    } else {
      const visual = await describeImageWithModel(
        provider,
        gridImagePath,
        [
          "You are looking at a thumbnail grid extracted from a video at multiple time points.",
          "Describe the visible progression, notable scenes, people, actions, and on-screen text if it is readable.",
          `User goal: ${prompt}`,
        ].join("\n"),
      );
      if (looksLikeVisionRefusal(visual)) {
        limitations.push("Gemini 的缩略图理解结果不可用。");
      } else {
        visualSummary = visual.summary;
        visualObservations = visual.observations;
      }
    }

    const audio = runProcess("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      normalizedPath,
      "-vn",
      "-acodec",
      "pcm_s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      audioPath,
      "-y",
    ]);
    if (audio.status !== 0) {
      limitations.push(audio.stderr.trim() || "视频音频抽取失败。");
    } else {
      const whisper = await transcribeWithWhisper(audioPath, whisperOutputDir);
      transcript = whisper.transcript;
      transcriptPath = whisper.transcriptPath;
      if (whisper.limitation) {
        limitations.push(whisper.limitation);
      }
    }

    let answer: string | null = null;
    let highlights: string[] = [];
    let spokenLanguage: string | null = null;

    if (visualSummary || transcript) {
      const synthesized = await synthesizeVideoAnswer(
        provider,
        prompt,
        metadata,
        visualSummary,
        visualObservations,
        transcript,
        limitations,
      );
      answer = synthesized.answer;
      highlights = synthesized.highlights;
      spokenLanguage = synthesized.spokenLanguage;
      limitations.push(...synthesized.caveats.filter((entry) => !limitations.includes(entry)));
    } else {
      limitations.push("没有拿到足够的画面或音频证据，无法生成可靠结论。");
    }

    return {
      path: normalizedPath,
      providerId: "gemini",
      model: provider.model,
      prompt,
      metadata,
      visualSummary,
      visualObservations,
      transcript,
      answer,
      highlights,
      spokenLanguage,
      limitations,
      artifacts: {
        gridImagePath: input.keepArtifacts ? gridImagePath : null,
        transcriptPath: input.keepArtifacts ? transcriptPath : null,
      },
    };
  } finally {
    if (!input.keepArtifacts) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function analyzeAudioFile(input: {
  path: string;
  prompt?: string;
  keepArtifacts?: boolean;
}): Promise<AudioFileAnalysisResult> {
  const normalizedPath = resolve(input.path);
  if (!existsSync(normalizedPath)) {
    throw new Error(`Audio file not found: ${normalizedPath}`);
  }

  const provider = getGeminiProviderConfig("aliceloop audio analyze");
  const prompt = input.prompt?.trim() || "Analyze this audio file.";
  const limitations: string[] = [];
  const metadata: AudioFileAnalysisResult["metadata"] = {
    durationSeconds: null,
    sampleRate: null,
    channels: null,
    codec: null,
    bitRate: null,
    container: null,
  };

  if (!commandExists("ffprobe")) {
    throw new Error("`aliceloop audio analyze` requires ffprobe. Install ffmpeg/ffprobe first.");
  }
  if (!commandExists("ffmpeg")) {
    throw new Error("`aliceloop audio analyze` requires ffmpeg. Install ffmpeg first.");
  }

  const ffprobe = runProcess("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration,bit_rate,format_name:stream=codec_type,codec_name,sample_rate,channels",
    "-of",
    "json",
    normalizedPath,
  ]);
  if (ffprobe.status !== 0) {
    throw new Error(ffprobe.stderr.trim() || "ffprobe failed");
  }
  Object.assign(metadata, parseAudioFfprobeMetadata(ffprobe.stdout));

  const tempDir = join(tmpdir(), `aliceloop-audio-analyze-${randomUUID()}`);
  const spectrogramPath = join(tempDir, "spectrogram.png");
  const wavPath = join(tempDir, "audio.wav");
  const whisperOutputDir = join(tempDir, "whisper");

  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  const mkdir = runProcess("mkdir", ["-p", tempDir, whisperOutputDir]);
  if (mkdir.status !== 0) {
    throw new Error(mkdir.stderr.trim() || "Failed to create temp directory");
  }

  let transcript: string | null = null;
  let transcriptPath: string | null = null;
  let spectrogramSummary: string | null = null;
  let spectrogramObservations: string[] = [];

  try {
    const spectrogram = runProcess("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      normalizedPath,
      "-lavfi",
      "showspectrumpic=s=800x200:mode=combined:color=intensity",
      "-frames:v",
      "1",
      spectrogramPath,
      "-y",
    ]);
    if (spectrogram.status !== 0) {
      limitations.push(spectrogram.stderr.trim() || "音频频谱图生成失败。");
    } else {
      const visual = await describeImageWithModel(
        provider,
        spectrogramPath,
        [
          "You are looking at a spectrogram generated from an audio or music file.",
          "Describe the apparent energy distribution, density, bass presence, brightness, and rhythmic texture.",
          `User goal: ${prompt}`,
        ].join("\n"),
      );
      if (looksLikeVisionRefusal(visual)) {
        limitations.push("Gemini 的频谱图理解结果不可用。");
      } else {
        spectrogramSummary = visual.summary;
        spectrogramObservations = visual.observations;
      }
    }

    const wav = runProcess("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      normalizedPath,
      "-acodec",
      "pcm_s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      wavPath,
      "-y",
    ]);
    if (wav.status !== 0) {
      limitations.push(wav.stderr.trim() || "音频 wav 转换失败。");
    } else {
      const whisper = await transcribeWithWhisper(wavPath, whisperOutputDir);
      transcript = whisper.transcript;
      transcriptPath = whisper.transcriptPath;
      if (whisper.limitation) {
        limitations.push(whisper.limitation);
      }
    }

    let answer: string | null = null;
    let highlights: string[] = [];

    if (spectrogramSummary || transcript) {
      const synthesized = await synthesizeAudioAnswer(
        provider,
        prompt,
        metadata,
        spectrogramSummary,
        spectrogramObservations,
        transcript,
        limitations,
      );
      answer = synthesized.answer;
      highlights = synthesized.highlights;
      limitations.push(...synthesized.caveats.filter((entry) => !limitations.includes(entry)));
    } else {
      limitations.push("没有拿到足够的音频证据，无法生成可靠结论。");
    }

    return {
      path: normalizedPath,
      providerId: "gemini",
      model: provider.model,
      prompt,
      metadata,
      spectrogramSummary,
      spectrogramObservations,
      transcript,
      answer,
      highlights,
      limitations,
      artifacts: {
        spectrogramPath: input.keepArtifacts ? spectrogramPath : null,
        transcriptPath: input.keepArtifacts ? transcriptPath : null,
      },
    };
  } finally {
    if (!input.keepArtifacts) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

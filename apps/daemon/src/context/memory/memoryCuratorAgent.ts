import { generateText, Output } from "ai";
import { z } from "zod";
import type { MemoryFactKind, MemoryType } from "@aliceloop/runtime-core";
import { createProviderModel } from "../../providers/providerModelFactory";
import { getToolModelConfig } from "../../providers/toolModelResolver";
import { getMemoryConfig } from "./memoryConfig";

interface MemoryCuratorInput {
  userMessages: string[];
  assistantResponse: string;
  includeSessionMemory?: boolean;
  existingMemoryManifests?: ExistingMemoryManifest[];
}

export interface CuratedMemory {
  action: "create" | "update" | "retract" | "noop";
  targetMemoryId: string | null;
  title: string | null;
  description: string | null;
  content: string;
  durability: "permanent" | "temporary";
  relatedTopics: string[];
  memoryType: MemoryType | null;
  factKind: MemoryFactKind | null;
  factKey: string | null;
}

export interface CuratedMemoryBatch {
  permanent: CuratedMemory[];
  temporary: CuratedMemory[];
}

export interface ExistingMemoryManifest {
  id: string;
  memoryType: MemoryType;
  title: string;
  description: string;
  updatedAt: string;
}

const memoryFactKindSchema = z.enum(["preference", "constraint", "decision", "profile", "account", "workflow", "other"]);
const memoryTypeSchema = z.enum(["user", "feedback", "project", "reference"]);
const curatedMemorySchema = z.object({
  action: z.enum(["create", "update", "retract", "noop"]).default("create"),
  targetMemoryId: z.string().trim().min(1).max(120).nullable().default(null),
  title: z.string().trim().min(1).max(96).nullable().default(null),
  description: z.string().trim().min(1).max(220).nullable().default(null),
  content: z.string().trim().min(1).max(500),
  durability: z.enum(["permanent", "temporary"]),
  memoryType: memoryTypeSchema.nullable().default(null),
  factKind: memoryFactKindSchema.nullable().default(null),
  factKey: z.string().trim().min(1).max(120).nullable().default(null),
  relatedTopics: z.array(z.string().trim().min(1).max(80)).max(6).default([]),
});

type CuratedMemoryCandidate = z.infer<typeof curatedMemorySchema>;

const explicitLongTermMemoryPattern =
  /remember|memory|preference|prefer|constraint|default|workflow|style|decision|project|repo|repository|记住|记得|偏好|习惯|约束|默认|风格|语气|少用|多用|以后|长期|项目|工程|仓库|决定|方案/iu;
const transientReferencePattern =
  /谁是|是什么|简介|介绍|资料|档案|最新|价格|天气|比分|播放量|粉丝|UID|space\.bilibili|新闻|新闻稿|百科|维基/iu;

function shouldCurateLongTermMemory(userMessage: string) {
  const trimmedUserMessage = userMessage.trim();
  if (!trimmedUserMessage) {
    return false;
  }

  if (transientReferencePattern.test(trimmedUserMessage)) {
    return false;
  }

  return explicitLongTermMemoryPattern.test(trimmedUserMessage);
}

function shouldCurateSessionMemory(userMessage: string) {
  return Boolean(userMessage.trim());
}

export async function planMemoryUpdatesFromConversation(
  userMessage: string,
  assistantMessage: string,
  abortSignal?: AbortSignal,
  options: {
    includeSessionMemory?: boolean;
    existingMemoryManifests?: ExistingMemoryManifest[];
  } = {},
) {
  const config = getMemoryConfig();
  if (!config.enabled || !config.autoSummarize) {
    return [] as CuratedMemoryCandidate[];
  }

  const provider = getToolModelConfig();
  if (!provider?.apiKey) {
    return [] as CuratedMemoryCandidate[];
  }

  const trimmedUserMessage = userMessage.trim();
  const trimmedAssistantMessage = assistantMessage.trim();
  if (!trimmedUserMessage || !trimmedAssistantMessage) {
    return [] as CuratedMemoryCandidate[];
  }

  const shouldCurateLongTerm = shouldCurateLongTermMemory(trimmedUserMessage);
  const shouldCurateSession = options.includeSessionMemory === true
    && shouldCurateSessionMemory(trimmedUserMessage);
  if (!shouldCurateLongTerm && !shouldCurateSession) {
    return [] as CuratedMemoryCandidate[];
  }

  const existingMemoryManifestLines = (options.existingMemoryManifests ?? []).map((memory) => [
    `- id: ${memory.id}`,
    `  type: ${memory.memoryType}`,
    `  title: ${memory.title}`,
    `  description: ${memory.description}`,
    `  updatedAt: ${memory.updatedAt}`,
  ].join("\n"));

  try {
    const response = await generateText({
      model: createProviderModel(provider),
      abortSignal,
      temperature: 0.2,
      output: Output.array({
        element: curatedMemorySchema,
        name: "memory_candidates",
        description: "High-value facts worth remembering from the conversation.",
      }),
      prompt: [
        "Extract up to 3 useful memory items from this conversation.",
        "Return both temporary session notes and permanent long-term facts when they are present.",
        "For each item, write a short title and a description that can act as a searchable memory manifest; keep content as the full fact text.",
        "For temporary items, capture the current worksite state: current phase, completed work, remaining next steps, blockers, or turn-local decisions.",
        "For permanent items, keep only durable user preferences, project constraints, stable decisions, workflow conventions, or reusable solutions that would help future work.",
        "For permanent items, fill memoryType as one of: user (stable user profile, role, identity, account info), feedback (user guidance, preferences, style, workflow expectations), project (project decisions, constraints, or non-code project context), reference (external places or materials to consult later).",
        "Use factKind and factKey as secondary labels. Use a short stable lowercase fact key such as preferred-language, reply-style, or repo-boundary.",
        "Before creating a permanent memory, compare against the existing relevant memory manifests below.",
        "For permanent items, set action=create only when no existing manifest already covers the fact.",
        "Set action=update and targetMemoryId when an existing memory should be refined or replaced.",
        "Set action=retract and targetMemoryId when the user says a remembered fact should be forgotten, removed, or is no longer true.",
        "Set action=noop when the conversation does not require any memory change.",
        "Do not store code structure, file paths, git history, temporary task state, or implementation details as long-term memory.",
        "Do not store one-off research facts, biographies, web-search results, current events, or temporary file operations unless the user explicitly asked to remember them.",
        "Do not restate the entire conversation. Skip transient chit-chat. Return an empty array when nothing is worth storing.",
        "",
        "Existing relevant memory manifests:",
        existingMemoryManifestLines.length > 0 ? existingMemoryManifestLines.join("\n") : "(none)",
        "",
        "User message:",
        trimmedUserMessage,
        "",
        "Assistant reply:",
        trimmedAssistantMessage,
      ].join("\n"),
    });

    return response.output;
  } catch (error) {
    console.warn("[memory-curator] Failed to plan structured memory updates from conversation", error);
    return [] as CuratedMemoryCandidate[];
  }
}

export async function curateMemoriesFromTurn(input: MemoryCuratorInput): Promise<CuratedMemoryBatch> {
  const latestUserMessage = input.userMessages.at(-1)?.trim();
  const assistantResponse = input.assistantResponse.trim();
  if (!latestUserMessage || !assistantResponse) {
    return {
      permanent: [],
      temporary: [],
    };
  }

  const memoryCandidates = await planMemoryUpdatesFromConversation(
    latestUserMessage,
    assistantResponse,
    undefined,
    {
      includeSessionMemory: input.includeSessionMemory,
      existingMemoryManifests: input.existingMemoryManifests,
    },
  );

  const memories = memoryCandidates.map((memory) => ({
    action: memory.action,
    targetMemoryId: memory.targetMemoryId,
    title: memory.title,
    description: memory.description,
    content: memory.content,
    durability: memory.durability,
    relatedTopics: memory.relatedTopics,
    memoryType: memory.memoryType,
    factKind: memory.factKind,
    factKey: memory.factKey,
  }));

  return {
    permanent: memories.filter((memory) => memory.durability === "permanent"),
    temporary: memories.filter((memory) => memory.durability === "temporary"),
  };
}

import { generateText, Output } from "ai";
import { z } from "zod";
import { createProviderModel } from "../../providers/providerModelFactory";
import { getActiveProviderConfig } from "../../repositories/providerRepository";
import { getMemoryConfig } from "./memoryConfig";
import { createMemory, findMemoryByExactContent } from "./memoryRepository";

interface DistillationInput {
  userMessages: string[];
  assistantResponse: string;
}

const extractedMemorySchema = z.object({
  content: z.string().trim().min(1).max(500),
  durability: z.enum(["permanent", "temporary"]),
  relatedTopics: z.array(z.string().trim().min(1).max(80)).max(6).default([]),
});

type ExtractedMemory = z.infer<typeof extractedMemorySchema>;

const explicitLongTermMemoryPattern =
  /remember|memory|preference|prefer|constraint|default|workflow|style|decision|project|repo|repository|记住|记得|偏好|习惯|约束|默认|风格|语气|少用|多用|以后|长期|项目|工程|仓库|决定|方案/iu;
const transientReferencePattern =
  /谁是|是什么|简介|介绍|资料|档案|最新|价格|天气|比分|播放量|粉丝|UID|space\.bilibili|新闻|新闻稿|百科|维基/iu;

function shouldDistillConversationToLongTermMemory(userMessage: string) {
  const trimmedUserMessage = userMessage.trim();
  if (!trimmedUserMessage) {
    return false;
  }

  if (explicitLongTermMemoryPattern.test(trimmedUserMessage)) {
    return true;
  }

  if (transientReferencePattern.test(trimmedUserMessage)) {
    return false;
  }

  return false;
}

export async function extractMemoriesFromConversation(
  userMessage: string,
  assistantMessage: string,
  abortSignal?: AbortSignal,
) {
  const config = getMemoryConfig();
  if (!config.enabled || !config.autoSummarize) {
    return [] as ExtractedMemory[];
  }

  const provider = getActiveProviderConfig();
  if (!provider?.apiKey) {
    return [] as ExtractedMemory[];
  }

  const trimmedUserMessage = userMessage.trim();
  const trimmedAssistantMessage = assistantMessage.trim();
  if (!trimmedUserMessage || !trimmedAssistantMessage) {
    return [] as ExtractedMemory[];
  }

  if (!shouldDistillConversationToLongTermMemory(trimmedUserMessage)) {
    return [] as ExtractedMemory[];
  }

  try {
    const response = await generateText({
      model: createProviderModel(provider),
      abortSignal,
      temperature: 0.2,
      output: Output.array({
        element: extractedMemorySchema,
        name: "memory_candidates",
        description: "High-value facts worth remembering from the conversation.",
      }),
      prompt: [
        "Extract up to 3 useful long-term memories from this conversation.",
        "Keep only durable user preferences, project constraints, stable decisions, workflow conventions, or reusable solutions that would help future work.",
        "Do not store one-off research facts, biographies, web-search results, current events, or temporary file operations unless the user explicitly asked to remember them.",
        "Do not restate the entire conversation. Skip transient chit-chat. Return an empty array when nothing is worth storing.",
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
    console.warn("[memory] Failed to extract structured memories from conversation", error);
    return [] as ExtractedMemory[];
  }
}

export async function reflectOnTurn(input: DistillationInput): Promise<void> {
  const latestUserMessage = input.userMessages.at(-1)?.trim();
  const assistantResponse = input.assistantResponse.trim();
  if (!latestUserMessage || !assistantResponse) {
    return;
  }

  const extractedMemories = await extractMemoriesFromConversation(
    latestUserMessage,
    assistantResponse,
  );

  for (const memory of extractedMemories) {
    if (findMemoryByExactContent(memory.content)) {
      continue;
    }

    await createMemory({
      content: memory.content,
      source: "auto",
      durability: memory.durability,
      relatedTopics: memory.relatedTopics,
    });
  }
}

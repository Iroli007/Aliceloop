import { randomUUID } from "node:crypto";
import { generateText, Output } from "ai";
import { z } from "zod";
import { createProviderModel } from "../../providers/providerModelFactory";
import { getActiveProviderConfig } from "../../repositories/providerRepository";
import { getMemoryConfig } from "./memoryConfig";
import { createMemory, findMemoryByExactContent, upsertMemoryNote } from "./memoryRepository";

interface DistillationInput {
  sessionId: string;
  userMessages: string[];
  assistantResponse: string;
  toolCalls?: Array<{ name: string; args: unknown; result: unknown }>;
}

const extractedMemorySchema = z.object({
  content: z.string().trim().min(1).max(500),
  durability: z.enum(["permanent", "temporary"]),
  relatedTopics: z.array(z.string().trim().min(1).max(80)).max(6).default([]),
});

type ExtractedMemory = z.infer<typeof extractedMemorySchema>;

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
        "Keep only durable preferences, project facts, decisions, constraints, or solutions that would help future work.",
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
  const { sessionId, toolCalls } = input;

  if (toolCalls && toolCalls.length > 0) {
    const fileOps = toolCalls.filter((tc) =>
      ["grep", "glob", "read", "write", "edit", "bash"].includes(tc.name),
    );

    if (fileOps.length > 0) {
      const paths = fileOps
        .flatMap((op) => {
          const args = op.args as Record<string, unknown>;
          if (op.name === "bash") {
            const command = args.command as string | undefined;
            if (command === "rm" || command === "rmdir") {
              const bashArgs = (args.args as string[] | undefined) ?? [];
              return bashArgs.filter((arg) => arg && !arg.startsWith("-"));
            }
            return [];
          }
          return [(args.targetPath as string) ?? (args.filePath as string) ?? null];
        })
        .filter(Boolean);

      if (paths.length > 0) {
        const now = new Date().toISOString();
        upsertMemoryNote({
          id: `distill-${randomUUID()}`,
          kind: "learning-pattern",
          title: "File operations in session",
          content: `Worked with files: ${paths.join(", ")}`,
          source: `session:${sessionId}`,
          updatedAt: now,
        });
      }
    }
  }

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

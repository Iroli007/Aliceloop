import type { ModelMessage } from "ai";
import { createMemory } from "../context/memory/memoryRepository";
import { reflectOnTurn } from "../context/memory/memoryDistiller";
import { maybeCreateArtifactFromReply } from "../services/artifactWriter";

export function schedulePostProcessing(input: {
  sessionId: string;
  messages: ModelMessage[];
  assistantText: string;
  publishRuntimeNotice: (sessionId: string, content: string) => void;
}) {
  const userMessages = input.messages
    .filter((message) => message.role === "user")
    .map((message) => (typeof message.content === "string" ? message.content : ""));
  const latestUserMessage = userMessages.at(-1) ?? null;

  if (latestUserMessage) {
    void maybeCreateArtifactFromReply(input.sessionId, latestUserMessage, input.assistantText).catch((error) => {
      const detail = error instanceof Error ? error.message : "工件写入失败";
      input.publishRuntimeNotice(input.sessionId, `工件流式写入失败：${detail}`);
    });
  }

  if (!latestUserMessage) {
    return;
  }

  void (async () => {
    const distilled = await reflectOnTurn({
      userMessages,
      assistantResponse: input.assistantText,
    });

    for (const memory of distilled.permanent) {
      try {
        await createMemory({
          content: memory.content,
          source: "auto",
          durability: "permanent",
          factKind: memory.factKind,
          factKey: memory.factKey,
          relatedTopics: memory.relatedTopics,
        });
      } catch {
        // A single fact write should not block the rest of the post-turn updates.
      }
    }
  })().catch(() => {
    // Summary refresh failure should not fail the user-visible turn.
  });
}

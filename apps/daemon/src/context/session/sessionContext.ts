import type { ModelMessage } from "ai";
import type { SessionMessage } from "@aliceloop/runtime-core";
import { getSessionSnapshot } from "../../repositories/sessionRepository";

const MAX_HISTORY_MESSAGES = 20;

function sessionMessageToCore(message: SessionMessage): ModelMessage {
  const content = serializeMessageContent(message);

  if (message.role === "user") {
    return { role: "user", content };
  }

  if (message.role === "assistant") {
    return { role: "assistant", content };
  }

  return { role: "system", content };
}

function serializeMessageContent(message: SessionMessage): string {
  if (message.attachments.length === 0) {
    return message.content;
  }

  const attachmentSummary = message.attachments
    .map((attachment) => {
      const binaryNote = attachment.mimeType.startsWith("image/")
        ? ", binary image attachment"
        : "";
      return `${attachment.fileName} (${attachment.mimeType}, path: ${attachment.storagePath}${binaryNote})`;
    })
    .join(", ");

  if (!message.content.trim()) {
    return `[User attached files: ${attachmentSummary}]`;
  }

  return `${message.content}\n\n[Attached files: ${attachmentSummary}]`;
}

export function buildSessionMessages(sessionId: string): ModelMessage[] {
  const snapshot = getSessionSnapshot(sessionId);
  const messages = snapshot.messages
    .filter((m) => m.role !== "system")
    .slice(-MAX_HISTORY_MESSAGES);

  return messages.map(sessionMessageToCore);
}

export function getLatestUserMessage(sessionId: string): string | null {
  const snapshot = getSessionSnapshot(sessionId);
  const userMessage = [...snapshot.messages]
    .reverse()
    .find((m) => m.role === "user");

  return userMessage?.content ?? null;
}

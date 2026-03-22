import type { ModelMessage } from "ai";
import type { SessionMessage } from "@aliceloop/runtime-core";
import { getSessionSnapshot } from "../../repositories/sessionRepository";

const MAX_HISTORY_MESSAGES = 20;

function getLatestUserSessionMessage(messages: SessionMessage[]): SessionMessage | null {
  return [...messages].reverse().find((message) => message.role === "user") ?? null;
}

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

export function buildActiveTurnBlock(sessionId: string): string {
  const snapshot = getSessionSnapshot(sessionId);
  const latestUserMessage = getLatestUserSessionMessage(snapshot.messages);

  if (!latestUserMessage) {
    return "";
  }

  const latestContent = serializeMessageContent(latestUserMessage).trim();
  if (!latestContent) {
    return "";
  }

  return [
    "## Active Turn",
    "- The final user message in the conversation history is the only current request for this turn.",
    "- Treat older conversation as background context. Do not claim the user just said, repeated, or confirmed something unless it appears in the latest user message below.",
    "- If a nickname, preference, or instruction appears only in older history, treat it as past context rather than a fresh instruction in this reply.",
    "- When the latest user message conflicts with, narrows, or replaces an older framing, follow the latest user message.",
    "",
    "<latest_user_message>",
    latestContent,
    "</latest_user_message>",
  ].join("\n");
}

export function getLatestUserMessage(sessionId: string): string | null {
  const snapshot = getSessionSnapshot(sessionId);
  const userMessage = getLatestUserSessionMessage(snapshot.messages);

  return userMessage?.content ?? null;
}

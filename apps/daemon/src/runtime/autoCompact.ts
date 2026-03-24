import type { ModelMessage } from "ai";

/**
 * Auto-compact message history: keep recent N messages, compress older ones into a summary
 */
export function autoCompactMessages(
  messages: ModelMessage[],
  keepRecentCount: number = 4
): ModelMessage[] {
  if (messages.length <= keepRecentCount) {
    return messages;
  }

  const recentMessages = messages.slice(-keepRecentCount);
  const oldMessages = messages.slice(0, -keepRecentCount);

  // Build compact summary
  const summaryParts: string[] = [];
  for (const msg of oldMessages) {
    const role = msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : "System";
    const content = typeof msg.content === "string" 
      ? msg.content.slice(0, 200) 
      : "[complex content]";
    summaryParts.push(`${role}: ${content}`);
  }

  const summaryMessage: ModelMessage = {
    role: "system",
    content: `[Earlier conversation summary - ${oldMessages.length} messages]:\n${summaryParts.join("\n\n")}`,
  };

  return [summaryMessage, ...recentMessages];
}

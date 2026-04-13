import type { ModelMessage } from "ai";

const MAX_VISIBLE_ASSISTANT_MESSAGE_CHARS = 1_600;
const MICRO_COMPACT_HEAD_CHARS = 360;
const MICRO_COMPACT_TAIL_CHARS = 220;
const MICRO_COMPACT_MARKER = "[Micro-compacted assistant output]";

function trimEdge(text: string) {
  return text.trim();
}

function compactAssistantText(text: string) {
  const normalized = text.trim();
  if (
    normalized.length <= MAX_VISIBLE_ASSISTANT_MESSAGE_CHARS
    || normalized.includes(MICRO_COMPACT_MARKER)
  ) {
    return null;
  }

  const head = trimEdge(normalized.slice(0, MICRO_COMPACT_HEAD_CHARS));
  const tail = trimEdge(normalized.slice(-MICRO_COMPACT_TAIL_CHARS));
  const removedChars = Math.max(
    0,
    normalized.length - (head.length + tail.length),
  );

  return [
    MICRO_COMPACT_MARKER,
    head,
    "... [middle omitted for context budget] ...",
    tail,
    `[trimmed ${removedChars} chars from an older assistant message]`,
  ].join("\n");
}

function collectProtectedIndexes(messages: ModelMessage[]) {
  const protectedIndexes = new Set<number>();
  const lastIndex = messages.length - 1;
  if (lastIndex >= 0) {
    protectedIndexes.add(lastIndex);
  }

  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex >= 0) {
    protectedIndexes.add(lastUserIndex);
    const previousIndex = lastUserIndex - 1;
    if (previousIndex >= 0 && messages[previousIndex]?.role === "assistant") {
      protectedIndexes.add(previousIndex);
    }
  }

  return protectedIndexes;
}

export function microCompactMessages(messages: ModelMessage[]) {
  const protectedIndexes = collectProtectedIndexes(messages);
  let compactedCount = 0;
  let savedChars = 0;

  const compactedMessages = messages.map((message, index) => {
    if (
      message.role !== "assistant"
      || protectedIndexes.has(index)
      || typeof message.content !== "string"
    ) {
      return message;
    }

    const compactedContent = compactAssistantText(message.content);
    if (!compactedContent) {
      return message;
    }

    compactedCount += 1;
    savedChars += Math.max(0, message.content.length - compactedContent.length);
    return {
      ...message,
      content: compactedContent,
    };
  });

  return {
    messages: compactedMessages,
    compactedCount,
    savedChars,
  };
}

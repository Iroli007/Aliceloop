import { logPerfTrace } from "../runtime/perfTrace";

const ANTHROPIC_EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" } as const;
const CLEARED_TOOL_RESULT_MESSAGE = "[Old tool result content cleared]";
const CACHE_EDITING_TRIGGER_TOOL_RESULTS = 4;
const CACHE_EDITING_KEEP_RECENT_TOOL_RESULTS = 2;
const MIN_TOOL_RESULT_CHARS_TO_CLEAR = 800;

type AnthropicCacheControl = typeof ANTHROPIC_EPHEMERAL_CACHE_CONTROL;

interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: AnthropicCacheControl;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
  cache_control?: AnthropicCacheControl;
  cache_reference?: string;
}

interface AnthropicCacheEditsBlock {
  type: "cache_edits";
  edits: Array<{
    type: "delete";
    cache_reference: string;
  }>;
}

interface AnthropicMessage {
  role: string;
  content: unknown;
}

interface AnthropicRequestBody {
  messages?: AnthropicMessage[];
}

interface ToolResultLocation {
  messageIndex: number;
  blockIndex: number;
  toolUseId: string;
  estimatedChars: number;
}

interface CreateAnthropicCacheEditingTransformInput {
  sessionId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isToolResultBlock(value: unknown): value is AnthropicToolResultBlock {
  return isRecord(value)
    && value.type === "tool_result"
    && typeof value.tool_use_id === "string";
}

function isTextBlock(value: unknown): value is AnthropicTextBlock {
  return isRecord(value)
    && value.type === "text"
    && typeof value.text === "string";
}

function getContentArray(message: AnthropicMessage): Array<Record<string, unknown>> | null {
  return Array.isArray(message.content)
    ? message.content as Array<Record<string, unknown>>
    : null;
}

function removeCacheControlFromMessageBlocks(messages: AnthropicMessage[]) {
  for (const message of messages) {
    const content = getContentArray(message);
    if (!content) {
      continue;
    }

    for (const block of content) {
      if ("cache_control" in block) {
        delete block.cache_control;
      }
    }
  }
}

function findLastUserMessageIndex(messages: AnthropicMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return index;
    }
  }

  return -1;
}

function estimateToolResultChars(block: AnthropicToolResultBlock) {
  const content = block.content;
  if (typeof content === "string") {
    return content.length;
  }

  if (Array.isArray(content)) {
    return content.reduce((sum, part) => {
      if (!isRecord(part)) {
        return sum;
      }

      if (typeof part.text === "string") {
        return sum + part.text.length;
      }

      if (part.type === "image" || part.type === "document") {
        return sum + 2000;
      }

      return sum + JSON.stringify(part).length;
    }, 0);
  }

  if (content === undefined || content === null) {
    return 0;
  }

  return JSON.stringify(content).length;
}

function shouldCompactToolResult(block: AnthropicToolResultBlock) {
  if (typeof block.content === "string") {
    return block.content !== CLEARED_TOOL_RESULT_MESSAGE
      && block.content.length >= MIN_TOOL_RESULT_CHARS_TO_CLEAR;
  }

  if (Array.isArray(block.content)) {
    return block.content.length > 0;
  }

  return estimateToolResultChars(block) >= MIN_TOOL_RESULT_CHARS_TO_CLEAR;
}

function collectCompactableToolResults(
  messages: AnthropicMessage[],
  lastUserMessageIndex: number,
): ToolResultLocation[] {
  const toolResults: ToolResultLocation[] = [];

  for (let messageIndex = 0; messageIndex < lastUserMessageIndex; messageIndex += 1) {
    const message = messages[messageIndex];
    if (message?.role !== "user") {
      continue;
    }

    const content = getContentArray(message);
    if (!content) {
      continue;
    }

    for (let blockIndex = 0; blockIndex < content.length; blockIndex += 1) {
      const block = content[blockIndex];
      if (!isToolResultBlock(block) || !shouldCompactToolResult(block)) {
        continue;
      }

      toolResults.push({
        messageIndex,
        blockIndex,
        toolUseId: block.tool_use_id,
        estimatedChars: estimateToolResultChars(block),
      });
    }
  }

  return toolResults;
}

function insertBlockAfterToolResults(content: Array<Record<string, unknown>>, block: AnthropicCacheEditsBlock) {
  let lastToolResultIndex = -1;
  for (let index = 0; index < content.length; index += 1) {
    if (isToolResultBlock(content[index])) {
      lastToolResultIndex = index;
    }
  }

  if (lastToolResultIndex >= 0) {
    const insertIndex = lastToolResultIndex + 1;
    content.splice(insertIndex, 0, block as unknown as Record<string, unknown>);
    if (insertIndex === content.length - 1) {
      content.push({ type: "text", text: "." });
    }
    return;
  }

  const insertIndex = Math.max(0, content.length - 1);
  content.splice(insertIndex, 0, block as unknown as Record<string, unknown>);
}

function ensureTrailingTextBlock(content: Array<Record<string, unknown>>) {
  const lastBlock = content.at(-1);
  if (isTextBlock(lastBlock)) {
    return;
  }

  content.push({ type: "text", text: "." });
}

function findLastCacheableBlockIndex(content: Array<Record<string, unknown>>) {
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const block = content[index];
    if (!isRecord(block) || typeof block.type !== "string") {
      continue;
    }

    if (
      block.type === "text"
      || block.type === "image"
      || block.type === "document"
      || block.type === "tool_result"
    ) {
      return index;
    }
  }

  return -1;
}

function addCacheReferences(
  messages: AnthropicMessage[],
  lastUserMessageIndex: number,
  lastUserCacheMarkerBlockIndex: number,
) {
  let referencedToolResultCount = 0;

  for (let messageIndex = 0; messageIndex <= lastUserMessageIndex; messageIndex += 1) {
    const message = messages[messageIndex];
    if (message?.role !== "user") {
      continue;
    }

    const content = getContentArray(message);
    if (!content) {
      continue;
    }

    const maxBlockIndex = messageIndex === lastUserMessageIndex
      ? lastUserCacheMarkerBlockIndex
      : content.length;

    for (let blockIndex = 0; blockIndex < maxBlockIndex; blockIndex += 1) {
      const block = content[blockIndex];
      if (!isToolResultBlock(block)) {
        continue;
      }

      block.cache_reference = block.tool_use_id;
      referencedToolResultCount += 1;
    }
  }

  return referencedToolResultCount;
}

function buildCacheEditsBlock(toolUseIds: string[]): AnthropicCacheEditsBlock | null {
  const uniqueToolUseIds = toolUseIds.filter((toolUseId, index, items) => items.indexOf(toolUseId) === index);
  if (uniqueToolUseIds.length === 0) {
    return null;
  }

  return {
    type: "cache_edits",
    edits: uniqueToolUseIds.map((toolUseId) => ({
      type: "delete" as const,
      cache_reference: toolUseId,
    })),
  };
}

function cloneRequestBody(args: Record<string, unknown>) {
  return structuredClone(args) as AnthropicRequestBody & Record<string, unknown>;
}

export function createAnthropicCacheEditingTransform(input: CreateAnthropicCacheEditingTransformInput) {
  let requestIndex = 0;

  return function transformRequestBody(args: Record<string, unknown>) {
    requestIndex += 1;

    const nextArgs = cloneRequestBody(args);
    const messages = Array.isArray(nextArgs.messages)
      ? nextArgs.messages.filter((message): message is AnthropicMessage => isRecord(message))
      : null;
    if (!messages || messages.length === 0) {
      return nextArgs;
    }

    removeCacheControlFromMessageBlocks(messages);

    const lastUserMessageIndex = findLastUserMessageIndex(messages);
    if (lastUserMessageIndex < 0) {
      return nextArgs;
    }

    const compactableToolResults = collectCompactableToolResults(messages, lastUserMessageIndex);
    const toolResultsToClear = compactableToolResults.length >= CACHE_EDITING_TRIGGER_TOOL_RESULTS
      ? compactableToolResults.slice(0, Math.max(0, compactableToolResults.length - CACHE_EDITING_KEEP_RECENT_TOOL_RESULTS))
      : [];

    for (const toolResult of toolResultsToClear) {
      const content = getContentArray(messages[toolResult.messageIndex]);
      const block = content?.[toolResult.blockIndex];
      if (!isToolResultBlock(block)) {
        continue;
      }

      block.content = CLEARED_TOOL_RESULT_MESSAGE;
    }

    const lastUserContent = getContentArray(messages[lastUserMessageIndex]);
    if (!lastUserContent || lastUserContent.length === 0) {
      return nextArgs;
    }

    const cacheEditsBlock = buildCacheEditsBlock(toolResultsToClear.map((toolResult) => toolResult.toolUseId));
    if (cacheEditsBlock) {
      insertBlockAfterToolResults(lastUserContent, cacheEditsBlock);
    }

    ensureTrailingTextBlock(lastUserContent);

    const cacheMarkerBlockIndex = findLastCacheableBlockIndex(lastUserContent);
    if (cacheMarkerBlockIndex < 0) {
      return nextArgs;
    }

    lastUserContent[cacheMarkerBlockIndex].cache_control = ANTHROPIC_EPHEMERAL_CACHE_CONTROL;
    const referencedToolResultCount = addCacheReferences(
      messages,
      lastUserMessageIndex,
      cacheMarkerBlockIndex,
    );

    logPerfTrace("prompt_cache_editing", {
      sessionId: input.sessionId ?? null,
      requestIndex,
      reanchoredMessageBreakpoint: true,
      referencedToolResultCount,
      clearedToolResultCount: toolResultsToClear.length,
      clearedToolResultIds: toolResultsToClear.map((toolResult) => toolResult.toolUseId),
      clearedToolResultChars: toolResultsToClear.reduce((sum, toolResult) => sum + toolResult.estimatedChars, 0),
    });

    return nextArgs;
  };
}

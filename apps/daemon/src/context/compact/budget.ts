import type { ModelMessage } from "ai";

const DEFAULT_STATIC_CONTEXT_OVERHEAD_TOKENS = 6_000;
const DEFAULT_COMPACT_TRIGGER_TOKENS = 28_000;
const DEFAULT_COMPACT_KEEP_RECENT_TURNS = 2;
const DEFAULT_FORCED_KEEP_RECENT_TURNS = 1;

function getNumericEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function approxTokenCountFromText(text: string) {
  if (!text) {
    return 0;
  }

  return Math.ceil(text.length / 4);
}

function messageContentToText(content: ModelMessage["content"]) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!part || typeof part !== "object" || !("type" in part)) {
        return "";
      }

      if (part.type === "text") {
        return part.text;
      }

      if ("result" in part) {
        return JSON.stringify(part.result);
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function estimateModelContextTokens(input: {
  staticOverheadTokens?: number;
  blocks: string[];
  messages: ModelMessage[];
}) {
  const blockTokens = input.blocks.reduce((sum, block) => sum + approxTokenCountFromText(block), 0);
  const messageTokens = input.messages.reduce((sum, message) => {
    return sum + approxTokenCountFromText(messageContentToText(message.content));
  }, 0);

  return blockTokens + messageTokens + (input.staticOverheadTokens ?? DEFAULT_STATIC_CONTEXT_OVERHEAD_TOKENS);
}

export function getCompactTriggerTokens() {
  return getNumericEnv("ALICELOOP_COMPACT_TRIGGER_TOKENS", DEFAULT_COMPACT_TRIGGER_TOKENS);
}

export function shouldCompactContext(input: {
  force: boolean;
  hiddenTurnCount: number;
  estimatedTokens: number;
}) {
  if (input.hiddenTurnCount <= 0) {
    return false;
  }

  if (input.force) {
    return true;
  }

  return input.estimatedTokens >= getCompactTriggerTokens();
}

export function resolveKeptRecentTurnsCount(currentRecentTurnsCount: number, force: boolean) {
  const target = force
    ? DEFAULT_FORCED_KEEP_RECENT_TURNS
    : DEFAULT_COMPACT_KEEP_RECENT_TURNS;

  return Math.max(1, Math.min(currentRecentTurnsCount, target));
}

import { createHash } from "node:crypto";
import { asSchema, type ModelMessage, type ToolSet } from "ai";
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import type { CachedSystemPromptMessage } from "../context/cacheControl";
import { hasAnthropicCacheBreakpoint } from "../context/cacheControl";

type PromptCacheStage = "system" | "tools" | "messages";

interface SerializedPromptPart {
  stage: PromptCacheStage;
  marker: string;
  content: string;
  contentChars: number;
  hasBreakpoint: boolean;
}

export interface PromptCacheBreakpointTrace {
  id: string;
  stage: PromptCacheStage;
  marker: string;
  prefixHash: string;
  prefixChars: number;
  contentChars: number;
}

export interface PromptCacheRequestTrace {
  requestHash: string;
  breakpointCount: number;
  breakpointIds: string[];
  breakpoints: PromptCacheBreakpointTrace[];
  systemPartCount: number;
  toolCount: number;
  messageCount: number;
}

export interface PromptCacheRunTrace extends PromptCacheRequestTrace {
  comparedToPreviousRun: boolean;
  stableBreakpointIdsVsPrevious: string[];
  likelyHitBreakpointIds: string[];
  likelyMissBreakpointIds: string[];
  highestStableBreakpointId: string | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  observedCacheWrite: boolean;
  observedCacheRead: boolean;
  comparisonBasis: "previous-run-prefix-hash" | "unavailable";
}

interface BuildPromptCacheRequestTraceInput {
  systemPrompt: string | CachedSystemPromptMessage[];
  tools: ToolSet;
  messages: ModelMessage[];
}

interface FinalizePromptCacheRunTraceInput {
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

const lastPromptCacheTraceBySession = new Map<string, PromptCacheRequestTrace>();
const PART_SEPARATOR = "\n<cache-part>\n";

function shortHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizeProviderOptionsForTelemetry(providerOptions: SharedV3ProviderOptions | undefined) {
  if (!hasAnthropicCacheBreakpoint(providerOptions)) {
    return null;
  }

  return {
    anthropic: {
      cacheControl: {
        type: "ephemeral",
      },
    },
  };
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(normalizeForTelemetry(value));
}

function normalizeForTelemetry(value: unknown, seen = new WeakSet<object>()): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "undefined") {
    return null;
  }

  if (typeof value === "function") {
    return "[function]";
  }

  if (typeof value === "symbol") {
    return `[symbol:${value.description ?? ""}]`;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeForTelemetry(item, seen));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof RegExp) {
    return value.toString();
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[circular]";
    }

    seen.add(value);
    const normalized: Record<string, unknown> = {};

    for (const [key, entryValue] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en"))) {
      normalized[key] = normalizeForTelemetry(entryValue, seen);
    }

    seen.delete(value);
    return normalized;
  }

  return String(value);
}

function buildSystemPromptParts(systemPrompt: string | CachedSystemPromptMessage[]): SerializedPromptPart[] {
  if (typeof systemPrompt === "string") {
    return [
      {
        stage: "system",
        marker: "system[0]",
        content: stableSerialize({
          role: "system",
          content: systemPrompt,
          providerOptions: null,
        }),
        contentChars: systemPrompt.length,
        hasBreakpoint: false,
      },
    ];
  }

  return systemPrompt.map((message, index) => ({
    stage: "system",
    marker: `system[${index}]`,
    content: stableSerialize({
      role: message.role,
      content: message.content,
      providerOptions: normalizeProviderOptionsForTelemetry(message.providerOptions),
    }),
    contentChars: message.content.length,
    hasBreakpoint: hasAnthropicCacheBreakpoint(message.providerOptions),
  }));
}

async function buildToolParts(tools: ToolSet): Promise<SerializedPromptPart[]> {
  return Promise.all(
    Object.entries(tools).map(async ([toolName, toolDefinition]) => {
      let inputSchema: unknown = null;
      try {
        inputSchema = await asSchema(toolDefinition.inputSchema).jsonSchema;
      } catch {
        inputSchema = { unavailable: true };
      }

      const providerOptions = normalizeProviderOptionsForTelemetry(
        toolDefinition.providerOptions as SharedV3ProviderOptions | undefined,
      );
      const content = stableSerialize({
        name: toolName,
        description: toolDefinition.description ?? null,
        inputSchema,
        providerOptions,
      });

      return {
        stage: "tools" as const,
        marker: toolName,
        content,
        contentChars: content.length,
        hasBreakpoint: hasAnthropicCacheBreakpoint(
          toolDefinition.providerOptions as SharedV3ProviderOptions | undefined,
        ),
      };
    }),
  );
}

function buildMessageParts(messages: ModelMessage[]): SerializedPromptPart[] {
  return messages.map((message, index) => ({
    stage: "messages",
    marker: `messages[${index}]:${message.role}`,
    content: stableSerialize({
      role: message.role,
      content: message.content,
      providerOptions: normalizeProviderOptionsForTelemetry(
        message.providerOptions as SharedV3ProviderOptions | undefined,
      ),
    }),
    contentChars: typeof message.content === "string"
      ? message.content.length
      : stableSerialize(message.content).length,
    hasBreakpoint: hasAnthropicCacheBreakpoint(
      message.providerOptions as SharedV3ProviderOptions | undefined,
    ),
  }));
}

function getBreakpointId(stage: PromptCacheStage, occurrence: number) {
  if (stage === "system" && occurrence === 0) {
    return "persona_static";
  }

  if (stage === "system" && occurrence === 1) {
    return "stable_execution_prefix";
  }

  if (stage === "tools" && occurrence === 0) {
    return "stable_tool_prefix";
  }

  if (stage === "messages" && occurrence === 0) {
    return "history_tail";
  }

  return `${stage}_${occurrence + 1}`;
}

export async function buildPromptCacheRequestTrace(
  input: BuildPromptCacheRequestTraceInput,
): Promise<PromptCacheRequestTrace> {
  const parts = [
    ...buildSystemPromptParts(input.systemPrompt),
    ...await buildToolParts(input.tools),
    ...buildMessageParts(input.messages),
  ];

  const prefixParts: string[] = [];
  const breakpointOccurrences = {
    system: 0,
    tools: 0,
    messages: 0,
  };
  const breakpoints: PromptCacheBreakpointTrace[] = [];

  for (const part of parts) {
    prefixParts.push(part.content);
    if (!part.hasBreakpoint) {
      continue;
    }

    const occurrence = breakpointOccurrences[part.stage];
    breakpointOccurrences[part.stage] += 1;
    const prefix = prefixParts.join(PART_SEPARATOR);
    breakpoints.push({
      id: getBreakpointId(part.stage, occurrence),
      stage: part.stage,
      marker: part.marker,
      prefixHash: shortHash(prefix),
      prefixChars: prefix.length,
      contentChars: part.contentChars,
    });
  }

  const requestHash = shortHash(prefixParts.join(PART_SEPARATOR));
  return {
    requestHash,
    breakpointCount: breakpoints.length,
    breakpointIds: breakpoints.map((breakpoint) => breakpoint.id),
    breakpoints,
    systemPartCount: typeof input.systemPrompt === "string" ? 1 : input.systemPrompt.length,
    toolCount: Object.keys(input.tools).length,
    messageCount: input.messages.length,
  };
}

export function finalizePromptCacheRunTrace(
  sessionId: string,
  requestTrace: PromptCacheRequestTrace,
  input: FinalizePromptCacheRunTraceInput,
): PromptCacheRunTrace {
  const previous = lastPromptCacheTraceBySession.get(sessionId);
  const stableBreakpointIdsVsPrevious: string[] = [];

  if (previous) {
    for (let index = 0; index < requestTrace.breakpoints.length; index += 1) {
      const current = requestTrace.breakpoints[index];
      const prior = previous.breakpoints[index];
      if (!prior || prior.id !== current.id || prior.prefixHash !== current.prefixHash) {
        break;
      }

      stableBreakpointIdsVsPrevious.push(current.id);
    }
  }

  const observedCacheRead = (input.cacheReadInputTokens ?? 0) > 0;
  const likelyHitBreakpointIds = observedCacheRead
    ? stableBreakpointIdsVsPrevious
    : [];
  const likelyMissBreakpointIds = requestTrace.breakpointIds.filter((id) => !likelyHitBreakpointIds.includes(id));
  const highestStableBreakpointId = stableBreakpointIdsVsPrevious.at(-1) ?? null;

  const trace: PromptCacheRunTrace = {
    ...requestTrace,
    comparedToPreviousRun: Boolean(previous),
    stableBreakpointIdsVsPrevious,
    likelyHitBreakpointIds,
    likelyMissBreakpointIds,
    highestStableBreakpointId,
    cacheCreationInputTokens: input.cacheCreationInputTokens,
    cacheReadInputTokens: input.cacheReadInputTokens,
    observedCacheWrite: (input.cacheCreationInputTokens ?? 0) > 0,
    observedCacheRead,
    comparisonBasis: previous ? "previous-run-prefix-hash" : "unavailable",
  };

  lastPromptCacheTraceBySession.set(sessionId, requestTrace);
  return trace;
}

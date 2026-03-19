import type { ModelMessage, ToolSet } from "ai";
import { buildIdentityPrompt } from "./prompts/identityPrompt";
import { buildMemoryBlock } from "./memory/memoryContext";
import { buildSessionMessages, getLatestUserMessage } from "./session/sessionContext";
import { buildSkillContextBlock } from "./skills/skillLoader";
import { buildToolSet } from "./tools/toolRegistry";
import { createPermissionSandboxExecutor } from "../services/sandboxExecutor";

export interface SafetyConfig {
  maxIterations: number;
  maxDurationMs: number;
  abortSignal: AbortSignal;
}

export interface AgentContext {
  systemPrompt: string;
  messages: ModelMessage[];
  tools: ToolSet;
  safetyConfig: SafetyConfig;
}

const DEFAULT_SAFETY: Omit<SafetyConfig, "abortSignal"> = {
  maxIterations: 25,
  maxDurationMs: 15 * 60 * 1000, // 15 minutes
};

export function loadContext(
  sessionId: string,
  abortSignal: AbortSignal,
): AgentContext {
  const identity = buildIdentityPrompt();
  const userQuery = getLatestUserMessage(sessionId);
  const memory = buildMemoryBlock(sessionId, userQuery ?? undefined);
  const skills = buildSkillContextBlock();
  const messages = buildSessionMessages(sessionId);

  const sandbox = createPermissionSandboxExecutor({
    label: `agent:${sessionId}`,
  });
  const tools = buildToolSet(sandbox);

  const systemPrompt = [identity, memory, skills].filter(Boolean).join("\n\n");

  return {
    systemPrompt,
    messages,
    tools,
    safetyConfig: {
      ...DEFAULT_SAFETY,
      abortSignal,
    },
  };
}

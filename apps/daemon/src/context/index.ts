import type { ModelMessage, ToolSet } from "ai";
import { buildIdentityPrompt } from "./prompts/identityPrompt";
import { buildMemoryBlock } from "./memory/memoryContext";
import { buildSessionMessages, getLatestUserMessage } from "./session/sessionContext";
import { buildSkillContextBlock } from "./skills/skillLoader";
import { buildToolSet } from "./tools/toolRegistry";
import { getRuntimeSettings } from "../repositories/runtimeSettingsRepository";
import { listSessionAttachmentSandboxRoots } from "../repositories/sessionRepository";
import { createPermissionSandboxExecutor } from "../services/sandboxExecutor";
import { requestSessionBashApproval } from "../services/sessionToolApprovalService";

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
  const runtimeSettings = getRuntimeSettings();
  const attachmentRoots = listSessionAttachmentSandboxRoots(sessionId);

  const sandbox = createPermissionSandboxExecutor({
    label: `agent:${sessionId}`,
    permissionProfile: runtimeSettings.sandboxProfile,
    extraReadRoots: attachmentRoots.readRoots,
    extraWriteRoots: attachmentRoots.writeRoots,
    extraCwdRoots: attachmentRoots.cwdRoots,
    requestBashApproval: ({ command, args, cwd }) =>
      requestSessionBashApproval({
        sessionId,
        command,
        args,
        cwd,
        abortSignal,
      }),
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

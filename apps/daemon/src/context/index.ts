import type { ModelMessage, ToolSet } from "ai";
import { buildPersonaPrompt } from "./prompts/identityPrompt";
import { buildMemoryBlock } from "./memory/memoryContext";
import { buildSessionMessages, getLatestUserMessage } from "./session/sessionContext";
import { buildSkillContextBlock } from "./skills/skillLoader";
import { buildToolSet } from "./tools/toolRegistry";
import { getRuntimeSettings } from "../repositories/runtimeSettingsRepository";
import {
  isAliceloopGeneratedFile,
  markGeneratedFileDeleted,
  markSessionGeneratedFile,
} from "../repositories/sessionGeneratedFileRepository";
import { listSessionAttachmentSandboxRoots } from "../repositories/sessionRepository";
import { createPermissionSandboxExecutor } from "../services/sandboxExecutor";
import { requestSessionBashApproval, requestSessionToolApproval } from "../services/sessionToolApprovalService";

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
  const persona = buildPersonaPrompt();
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
    requestBashApproval: runtimeSettings.sandboxProfile === "development"
      ? ({ command, args, cwd }) =>
          requestSessionBashApproval({
            sessionId,
            command,
            args,
            cwd,
            abortSignal,
          })
      : undefined,
    requestElevatedApproval: (input) =>
      requestSessionToolApproval({
        sessionId,
        abortSignal,
        ...input,
      }),
    noteCreatedFile: (targetPath) => {
      markSessionGeneratedFile(sessionId, targetPath);
    },
    canDeleteFile: (targetPath) => isAliceloopGeneratedFile(targetPath),
    noteDeletedFile: (targetPath) => {
      markGeneratedFileDeleted(targetPath);
    },
  });
  const tools = buildToolSet(sandbox);

  const systemPrompt = [persona, memory, skills].filter(Boolean).join("\n\n");

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

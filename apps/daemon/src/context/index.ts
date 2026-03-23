import type { ModelMessage, ToolSet } from "ai";
import { logPerfTrace, nowMs, roundMs } from "../runtime/perfTrace";
import { buildPersonaPrompt } from "./prompts/identityPrompt";
import { buildFastMemoryBlock, startAsyncSemanticSearch, type AsyncSemanticSearchHandle } from "./memory/memoryContext";
import { planMemoryRoute, type MemoryRoutePlan } from "./memory/memoryRouter";
import { buildActiveTurnBlock, buildSessionMessages, getLatestUserMessage } from "./session/sessionContext";
import { buildHistoricalContextBlock } from "./session/historyContext";
import { buildSkillContextBlock, listActiveSkillDefinitions } from "./skills/skillLoader";
import { buildToolSet } from "./tools/toolRegistry";
import { getRuntimeSettings } from "../repositories/runtimeSettingsRepository";
import {
  isAliceloopGeneratedFile,
  markGeneratedFileDeleted,
  markSessionGeneratedFile,
} from "../repositories/sessionGeneratedFileRepository";
import { getSessionProjectBinding, listSessionAttachmentSandboxRoots } from "../repositories/sessionRepository";
import { createPermissionSandboxExecutor } from "../services/sandboxExecutor";
import { requestSessionBashApproval, requestSessionToolApproval } from "../services/sessionToolApprovalService";

export interface SafetyConfig {
  maxIterations: number;
  maxDurationMs: number;
  abortSignal: AbortSignal;
}

export interface AgentContext {
  systemPrompt: string | Array<{ role: "system"; content: string; providerOptions?: { anthropic?: { cacheControl?: { type: "ephemeral" } } } }>;
  messages: ModelMessage[];
  tools: ToolSet;
  safetyConfig: SafetyConfig;
  timings: Record<string, number | string | null>;
  memoryRoute: MemoryRoutePlan;
  /**
   * Async handle for semantic (vector) memory search.
   * Fire-and-forget: starts immediately and resolves in the background.
   * Caller should consume it during post-processing to enrich durable summary memory
   * without blocking first-token delivery.
   */
  asyncSemanticSearch?: AsyncSemanticSearchHandle;
}

const DEFAULT_SAFETY: Omit<SafetyConfig, "abortSignal"> = {
  maxIterations: 25,
  maxDurationMs: 15 * 60 * 1000, // 15 minutes
};

export async function loadContext(
  sessionId: string,
  abortSignal: AbortSignal,
): Promise<AgentContext> {
  const timings: Record<string, number | string | null> = {};

  const personaStartedAt = nowMs();
  const persona = buildPersonaPrompt();
  timings.personaMs = roundMs(nowMs() - personaStartedAt);

  const latestUserStartedAt = nowMs();
  const userQuery = getLatestUserMessage(sessionId);
  timings.latestUserMs = roundMs(nowMs() - latestUserStartedAt);

  const routeStartedAt = nowMs();
  const memoryRoute = planMemoryRoute(userQuery);
  timings.memoryRouteMs = roundMs(nowMs() - routeStartedAt);
  timings.memoryRoute = JSON.stringify(memoryRoute.timings);
  timings.memoryRouteReasons = memoryRoute.reasons.join(",");
  timings.sessionArchiveMode = memoryRoute.sessionArchiveMode;
  timings.atomicRecallMode = memoryRoute.atomicRecallMode;

  const projectBindingStartedAt = nowMs();
  const projectBinding = getSessionProjectBinding(sessionId);
  timings.projectBindingMs = roundMs(nowMs() - projectBindingStartedAt);

  const activeTurnStartedAt = nowMs();
  const activeTurn = buildActiveTurnBlock(sessionId);
  timings.activeTurnMs = roundMs(nowMs() - activeTurnStartedAt);

  const historyStartedAt = nowMs();
  const history = memoryRoute.useSessionArchive
    ? buildHistoricalContextBlock(sessionId, memoryRoute.query ?? undefined)
    : { content: "", timings: { skipReason: "router_skipped", totalMs: 0 } };
  timings.historyMs = roundMs(nowMs() - historyStartedAt);
  timings.history = JSON.stringify(history.timings);

  // Fast memory block: attention + high-level summary only.
  // Semantic recall is started separately as fire-and-forget so first token is not blocked.
  const memoryStartedAt = nowMs();
  const memory = buildFastMemoryBlock(sessionId);
  timings.memoryMs = roundMs(nowMs() - memoryStartedAt);

  // Start async semantic search (fire-and-forget, won't block first token)
  const asyncSemanticSearch = memoryRoute.atomicRecallMode === "async" && memoryRoute.query
    ? startAsyncSemanticSearch(sessionId, memoryRoute.query, abortSignal)
    : undefined;
  asyncSemanticSearch?.start();
  timings.asyncSemanticStarted = asyncSemanticSearch ? 1 : 0;

  const skillsStartedAt = nowMs();
  const skills = buildSkillContextBlock();
  timings.skillsMs = roundMs(nowMs() - skillsStartedAt);

  const messagesStartedAt = nowMs();
  const messages = buildSessionMessages(sessionId);
  timings.messagesMs = roundMs(nowMs() - messagesStartedAt);
  timings.messageCount = messages.length;
  timings.messageChars = roundMs(messages.reduce((sum, message) => {
    if (typeof message.content === "string") {
      return sum + message.content.length;
    }

    return sum + JSON.stringify(message.content).length;
  }, 0));

  const runtimeSettingsStartedAt = nowMs();
  const runtimeSettings = getRuntimeSettings();
  timings.runtimeSettingsMs = roundMs(nowMs() - runtimeSettingsStartedAt);

  const attachmentRootsStartedAt = nowMs();
  const attachmentRoots = listSessionAttachmentSandboxRoots(sessionId);
  timings.attachmentRootsMs = roundMs(nowMs() - attachmentRootsStartedAt);

  const sandboxStartedAt = nowMs();
  const sandbox = createPermissionSandboxExecutor({
    label: `agent:${sessionId}`,
    permissionProfile: runtimeSettings.sandboxProfile,
    defaultCwd: attachmentRoots.defaultCwd ?? undefined,
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
  timings.sandboxMs = roundMs(nowMs() - sandboxStartedAt);

  const activeSkillsStartedAt = nowMs();
  const activeSkills = listActiveSkillDefinitions();
  timings.activeSkillsMs = roundMs(nowMs() - activeSkillsStartedAt);

  const toolsStartedAt = nowMs();
  const tools = buildToolSet(sandbox, activeSkills, sessionId);
  timings.toolsMs = roundMs(nowMs() - toolsStartedAt);

  const projectContext = projectBinding?.projectPath
    ? [
        "Current session workspace:",
        `- Project: ${projectBinding.projectName ?? projectBinding.projectId}`,
        `- Path: ${projectBinding.projectPath}`,
        "- Use this as the default working directory unless the user explicitly asks for another location.",
      ].join("\n")
    : "";

  const dynamicBlocks = [activeTurn, projectContext, history.content, memory.content, skills].filter(Boolean);

  const promptAssemblyStartedAt = nowMs();
  let systemPrompt: AgentContext["systemPrompt"];
  if (Array.isArray(persona)) {
    // persona is already system messages with cache control
    systemPrompt = [...persona];
    if (dynamicBlocks.length > 0) {
      systemPrompt.push({
        role: "system",
        content: dynamicBlocks.join("\n\n"),
      });
    }
  } else {
    // fallback: persona is a string
    systemPrompt = [persona, ...dynamicBlocks].filter(Boolean).join("\n\n");
  }
  timings.promptAssemblyMs = roundMs(nowMs() - promptAssemblyStartedAt);
  if (Array.isArray(systemPrompt)) {
    timings.systemPromptParts = systemPrompt.length;
    timings.systemPromptChars = roundMs(systemPrompt.reduce((sum, message) => sum + message.content.length, 0));
  } else {
    timings.systemPromptParts = 1;
    timings.systemPromptChars = roundMs(systemPrompt.length);
  }
  timings.dynamicBlockCount = dynamicBlocks.length;
  timings.dynamicPromptChars = roundMs(dynamicBlocks.reduce((sum, block) => sum + block.length, 0));
  timings.totalMs = roundMs(Object.values({
    personaMs: timings.personaMs,
    latestUserMs: timings.latestUserMs,
    memoryRouteMs: timings.memoryRouteMs,
    activeTurnMs: timings.activeTurnMs,
    historyMs: timings.historyMs,
    memoryMs: timings.memoryMs,
    skillsMs: timings.skillsMs,
    messagesMs: timings.messagesMs,
    runtimeSettingsMs: timings.runtimeSettingsMs,
    attachmentRootsMs: timings.attachmentRootsMs,
    sandboxMs: timings.sandboxMs,
    activeSkillsMs: timings.activeSkillsMs,
    toolsMs: timings.toolsMs,
    promptAssemblyMs: timings.promptAssemblyMs,
  }).reduce((sum, value) => sum + (typeof value === "number" ? value : 0), 0));
  timings.memory = JSON.stringify(memory.timings);

  logPerfTrace("load_context", {
    sessionId,
    ...timings,
  });

  return {
    systemPrompt,
    messages,
    tools,
    safetyConfig: {
      ...DEFAULT_SAFETY,
      abortSignal,
    },
    timings,
    memoryRoute,
    asyncSemanticSearch,
  };
}

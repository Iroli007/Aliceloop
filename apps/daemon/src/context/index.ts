import type { ModelMessage, ToolChoice, ToolSet } from "ai";
import { logPerfTrace, nowMs, roundMs } from "../runtime/perfTrace";
import { buildPersonaPrompt } from "./prompts/identityPrompt";
import { buildFastMemoryBlock, startAsyncSemanticSearch, type AsyncSemanticSearchHandle } from "./memory/memoryContext";
import { planMemoryRoute, type MemoryRoutePlan } from "./memory/memoryRouter";
import {
  buildSessionContextFragments,
} from "./session/sessionContext";
import { buildHistoricalContextBlock } from "./session/historyContext";
import { buildSkillContextBlock, selectRelevantSkillDefinitions } from "./skills/skillLoader";
import {
  advanceSessionSkillCacheTurn,
  getSessionSkillCacheHints,
  inspectSessionSkillCache,
  rememberSessionSkillRoute,
} from "./skills/sessionSkillCache";
import { getSkillGroupIdsForSkill, mergeSkillRouteHints, needsBrowserAutomation, needsCodingAgent, needsWebResearch } from "./skills/skillRouting";
import { buildToolSet } from "./tools/toolRegistry";
import { hasHealthyDesktopRelay } from "./tools/desktopRelayResearch";
import { getRuntimeSettings } from "../repositories/runtimeSettingsRepository";
import { getDefaultProjectDirectory } from "../repositories/projectRepository";
import {
  isAliceloopGeneratedFile,
  markGeneratedFileDeleted,
  markSessionGeneratedFile,
} from "../repositories/sessionGeneratedFileRepository";
import { createPermissionSandboxExecutor } from "../services/sandboxExecutor";
import { requestSessionToolApproval } from "../services/sessionToolApprovalService";

export interface SafetyConfig {
  maxIterations: number;
  maxDurationMs: number;
  abortSignal: AbortSignal;
}

export interface AgentContext {
  systemPrompt: string | Array<{ role: "system"; content: string; providerOptions?: { anthropic?: { cacheControl?: { type: "ephemeral" } } } }>;
  messages: ModelMessage[];
  tools: ToolSet;
  firstStepToolChoice?: ToolChoice<ToolSet>;
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
  maxIterations: 150,
  maxDurationMs: 20 * 60 * 1000, // 20 minutes
};

export async function loadContext(
  sessionId: string,
  abortSignal: AbortSignal,
): Promise<AgentContext> {
  const timings: Record<string, number | string | null> = {};

  const personaStartedAt = nowMs();
  const persona = buildPersonaPrompt();
  timings.personaMs = roundMs(nowMs() - personaStartedAt);

  const sessionContextStartedAt = nowMs();
  const sessionContext = buildSessionContextFragments(sessionId);
  timings.sessionContextMs = roundMs(nowMs() - sessionContextStartedAt);
  timings.sessionContextAggregated = 1;
  timings.sessionSnapshotReads = sessionContext.timings.snapshotReads;
  timings.sessionSnapshotMs = sessionContext.timings.snapshotMs;
  timings.latestUserMs = sessionContext.timings.latestUserMs;
  timings.projectBindingMs = sessionContext.timings.projectBindingMs;
  timings.attachmentRootsMs = sessionContext.timings.attachmentRootsMs;
  timings.recentToolTraceMs = sessionContext.timings.recentToolTraceMs;
  timings.recentConversationFocusMs = sessionContext.timings.recentConversationFocusMs;
  timings.recentResearchMemoryMs = sessionContext.timings.recentResearchMemoryMs;
  timings.activeTurnMs = sessionContext.timings.activeTurnMs;
  timings.recentToolActivityMs = sessionContext.timings.recentToolActivityMs;
  timings.messagesMs = sessionContext.timings.messagesMs;

  const latestUserQuery = sessionContext.latestUserQuery;
  const recentConversationFocus = sessionContext.recentConversationFocus;

  const userQuery = recentConversationFocus.effectiveUserQuery ?? latestUserQuery;
  timings.effectiveUserQueryChars = typeof userQuery === "string" ? userQuery.length : 0;

  advanceSessionSkillCacheTurn(sessionId);
  const shouldUseSkillCache = recentConversationFocus.continuationLike
    || recentConversationFocus.researchContinuation
    || recentConversationFocus.routeHints.stickySkillIds.length > 0
    || recentConversationFocus.routeHints.stickyGroupIds.length > 0;
  const cachedRouteHints = getSessionSkillCacheHints(sessionId, {
    includeSticky: shouldUseSkillCache,
  });
  const routeHints = mergeSkillRouteHints(recentConversationFocus.routeHints, cachedRouteHints);
  const cachedSkillSnapshot = inspectSessionSkillCache(sessionId);
  timings.cachedSkillCount = cachedSkillSnapshot.stickySkillIds.length;
  timings.cachedSkillGroupCount = cachedSkillSnapshot.stickyGroupIds.length;
  timings.skillCacheUsed = shouldUseSkillCache && (
    cachedRouteHints.stickySkillIds.length > 0 || cachedRouteHints.stickyGroupIds.length > 0
  )
    ? 1
    : 0;

  const routeStartedAt = nowMs();
  const memoryRoute = planMemoryRoute(userQuery);
  timings.memoryRouteMs = roundMs(nowMs() - routeStartedAt);
  timings.memoryRoute = JSON.stringify(memoryRoute.timings);
  timings.memoryRouteReasons = memoryRoute.reasons.join(",");
  timings.sessionArchiveMode = memoryRoute.sessionArchiveMode;
  timings.atomicRecallMode = memoryRoute.atomicRecallMode;

  const projectBinding = sessionContext.projectBinding;
  timings.projectBindingAggregated = 1;

  const activeTurn = sessionContext.activeTurn;
  const recentResearchMemory = sessionContext.recentResearchMemory;
  const recentToolActivity = sessionContext.recentToolActivity;

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
  const routedSkills = selectRelevantSkillDefinitions(userQuery, routeHints);
  const routedSkillGroupIds = [...new Set(routedSkills.flatMap((skill) => getSkillGroupIdsForSkill(skill.id)))];
  rememberSessionSkillRoute(sessionId, {
    skillIds: routedSkills.map((skill) => skill.id),
    groupIds: routedSkillGroupIds,
  });
  const browserRelayAvailable = hasHealthyDesktopRelay();
  const skills = buildSkillContextBlock(routedSkills, {
    browserRelayAvailable,
    routeHints,
  });
  timings.skillsMs = roundMs(nowMs() - skillsStartedAt);
  timings.routedSkillCount = routedSkills.length;
  timings.routedSkills = routedSkills.map((skill) => skill.id).join(",");
  timings.routedSkillGroups = routedSkillGroupIds.join(",");
  timings.browserRelayAvailable = browserRelayAvailable ? 1 : 0;

  const messages = sessionContext.messages;
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
  const autoApproveToolRequests = runtimeSettings.autoApproveToolRequests;
  const workspaceProject = getDefaultProjectDirectory();

  const sandboxStartedAt = nowMs();
  const sandbox = createPermissionSandboxExecutor({
    label: `agent:${sessionId}`,
    permissionProfile: "full-access",
    autoApproveToolRequests,
    workspaceRoot: workspaceProject.path,
    defaultCwd: workspaceProject.path,
    requestBashApproval: undefined,
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
  const activeSkills = routedSkills;
  timings.activeSkillsMs = roundMs(nowMs() - activeSkillsStartedAt);

  const toolsStartedAt = nowMs();
  const tools = buildToolSet(sandbox, activeSkills, {
    sessionId,
    query: userQuery,
    routeHints,
  });
  timings.toolsMs = roundMs(nowMs() - toolsStartedAt);
  timings.toolQueryChars = typeof userQuery === "string" ? userQuery.length : 0;

  const initialToolChoice = (() => {
    const toolNames = new Set(Object.keys(tools));
    const queryText = userQuery ?? "";

    if ((recentConversationFocus.researchContinuation || needsWebResearch(queryText)) && toolNames.has("web_search")) {
      return { type: "tool", toolName: "web_search" } as const;
    }

    if (needsBrowserAutomation(queryText)) {
      if (toolNames.has("browser_snapshot")) {
        return { type: "tool", toolName: "browser_snapshot" } as const;
      }

      if (toolNames.has("browser_navigate")) {
        return { type: "tool", toolName: "browser_navigate" } as const;
      }
    }

    if (needsCodingAgent(queryText)) {
      if (/[文件目录路径查找搜索查看列出定位]/u.test(queryText) && toolNames.has("glob")) {
        return { type: "tool", toolName: "glob" } as const;
      }

      if (toolNames.has("grep")) {
        return { type: "tool", toolName: "grep" } as const;
      }
    }

    return undefined;
  })();

  const projectContext = [
    "Current session workspace:",
    `- Project: ${workspaceProject.name}`,
    `- Path: ${workspaceProject.path}`,
    "- Treat this as the workspace boundary for all file operations.",
  ].join("\n");

  const dynamicBlocks = [
    activeTurn,
    recentConversationFocus.content,
    recentResearchMemory,
    recentToolActivity,
    projectContext,
    history.content,
    memory.content,
    skills,
  ].filter(Boolean);

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
    sessionContextMs: timings.sessionContextMs,
    memoryRouteMs: timings.memoryRouteMs,
    historyMs: timings.historyMs,
    memoryMs: timings.memoryMs,
    skillsMs: timings.skillsMs,
    runtimeSettingsMs: timings.runtimeSettingsMs,
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
    firstStepToolChoice: initialToolChoice,
    safetyConfig: {
      ...DEFAULT_SAFETY,
      abortSignal,
    },
    timings,
    memoryRoute,
    asyncSemanticSearch,
  };
}

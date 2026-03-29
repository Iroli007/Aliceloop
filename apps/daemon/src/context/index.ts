import type { ModelMessage, ToolChoice, ToolSet } from "ai";
import { logPerfTrace, nowMs, roundMs } from "../runtime/perfTrace";
import { buildPersonaPrompt } from "./prompts/identityPrompt";
import { buildProfileFactMemoryBlock } from "./memory/memoryContext";
import {
  buildSessionContextFragments,
} from "./session/sessionContext";
import { buildHistoricalContextBlock } from "./session/historyContext";
import { buildSkillContextBlock, selectRelevantSkillDefinitions } from "./skills/skillLoader";
import { mergeSkillRouteHints, needsBrowserAutomation, needsCameraCapture, needsEpisodicHistoryRecall, needsFileManagement, needsImageAnalysis, needsWebFetch, needsWebResearch } from "./skills/skillRouting";
import { buildToolSet } from "./tools/toolRegistry";
import { hasHealthyDesktopRelay } from "./tools/desktopRelayResearch";
import { getRuntimeSettings } from "../repositories/runtimeSettingsRepository";
import { getDefaultProjectDirectory } from "../repositories/projectRepository";
import { getDataDir } from "../db/client";
import {
  isAliceloopGeneratedFile,
  markGeneratedFileDeleted,
  markSessionGeneratedFile,
} from "../repositories/sessionGeneratedFileRepository";
import { createPermissionSandboxExecutor } from "../services/sandboxExecutor";
import { requestSessionToolApproval } from "../services/sessionToolApprovalService";
import { getSandboxProjectRoot } from "../runtime/sandbox/toolPolicy";

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
  routedSkillIds: string[];
}

const DEFAULT_SAFETY: Omit<SafetyConfig, "abortSignal"> = {
  maxIterations: 150,
  maxDurationMs: 20 * 60 * 1000, // 20 minutes
};

interface LoadContextOptions {
  additionalStickySkillIds?: string[];
  additionalToolNames?: string[];
}

function prefersDeepResearchFetch(query: string) {
  return /深度研究|深入研究|深挖|深扒|别偷懒|别只看摘要|别看摘要|去读|读一下|看原文|看正文|看全文|看来源|看帖子|看词条|看页面|补完|补全|继续深挖|继续深查|继续研究|现在什么情况|现在咋样|现在怎么样|最新情况|有进展吗|进展如何|怎么样了|情况怎么样|还有进展吗/u.test(query.trim());
}

export async function loadContext(
  sessionId: string,
  abortSignal: AbortSignal,
  options?: LoadContextOptions,
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
  timings.taskWorkingMemoryMs = sessionContext.timings.taskWorkingMemoryMs;
  timings.messagesMs = sessionContext.timings.messagesMs;

  const latestUserQuery = sessionContext.latestUserQuery;
  const recentConversationFocus = sessionContext.recentConversationFocus;
  const latestUserHasImageAttachment = recentConversationFocus.latestUserHasImageAttachment;

  const userQuery = recentConversationFocus.effectiveUserQuery ?? latestUserQuery;
  timings.effectiveUserQueryChars = typeof userQuery === "string" ? userQuery.length : 0;

  const routeHints = mergeSkillRouteHints(
    recentConversationFocus.routeHints,
    (options?.additionalStickySkillIds?.length ?? 0) > 0
      ? {
          stickySkillIds: options?.additionalStickySkillIds ?? [],
          reasons: ["runtime-capability-recovery"],
        }
      : null,
  );
  timings.cachedSkillCount = 0;
  timings.cachedSkillGroupCount = 0;
  timings.skillCacheUsed = 0;

  timings.projectBindingAggregated = 1;
  timings.attachmentRootsAggregated = 1;

  const skillRoutingStartedAt = nowMs();
  const routedSkills = selectRelevantSkillDefinitions(userQuery, routeHints);
  timings.skillRoutingMs = roundMs(nowMs() - skillRoutingStartedAt);
  timings.skillRouteSource = "metadata";
  timings.ruleSkillCount = routedSkills.length;
  timings.fallbackSkillCount = 0;
  const browserRelayAvailable = hasHealthyDesktopRelay();
  const skillsStartedAt = nowMs();
  const skills = buildSkillContextBlock(routedSkills, {
    browserRelayAvailable,
    routeHints,
  });
  timings.skillsMs = roundMs(nowMs() - skillsStartedAt);
  timings.routedSkillCount = routedSkills.length;
  timings.routedSkills = routedSkills.map((skill) => skill.id).join(",");
  timings.routedSkillGroups = "";
  timings.browserRelayAvailable = browserRelayAvailable ? 1 : 0;

  const routedSkillIds = new Set(routedSkills.map((skill) => skill.id));

  const profileFactMemoryStartedAt = nowMs();
  const profileFactMemory = routedSkillIds.has("memory-management") && userQuery
    ? await buildProfileFactMemoryBlock(userQuery)
    : { content: "", timings: { skipReason: "skill_not_routed" } };
  timings.profileFactMemoryMs = roundMs(nowMs() - profileFactMemoryStartedAt);
  timings.profileFactMemoryChars = profileFactMemory.content.length;
  timings.profileFactMemoryCount = profileFactMemory.timings.memoryCount ?? null;
  timings.profileFactMemorySkipReason = typeof profileFactMemory.timings.skipReason === "string"
    ? profileFactMemory.timings.skipReason
    : null;

  const historicalContextStartedAt = nowMs();
  const historicalContext = routedSkillIds.has("memory-management") && userQuery && needsEpisodicHistoryRecall(userQuery)
    ? buildHistoricalContextBlock(sessionId, userQuery)
    : { content: "", timings: { skipReason: "skill_not_routed" } };
  timings.historicalContextMs = roundMs(nowMs() - historicalContextStartedAt);
  timings.historicalContextChars = historicalContext.content.length;
  timings.historicalContextSkipReason = typeof historicalContext.timings.skipReason === "string"
    ? historicalContext.timings.skipReason
    : null;

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
    extraReadRoots: [getSandboxProjectRoot(), getDataDir()],
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
  timings.activeSkillsMs = roundMs(nowMs() - activeSkillsStartedAt);

  const toolsStartedAt = nowMs();
  const tools = buildToolSet(sandbox, routedSkills, {
    sessionId,
    query: userQuery,
    routeHints,
    hasImageAttachment: latestUserHasImageAttachment,
    browserRelayAvailable,
    additionalToolNames: options?.additionalToolNames,
  });
  timings.toolsMs = roundMs(nowMs() - toolsStartedAt);
  timings.toolQueryChars = typeof userQuery === "string" ? userQuery.length : 0;

  const initialToolChoice = (() => {
    const toolNames = new Set(Object.keys(tools));
    const queryText = userQuery ?? "";

    if (toolNames.has("view_image") && (latestUserHasImageAttachment || needsImageAnalysis(queryText))) {
      return { type: "tool", toolName: "view_image" } as const;
    }

    if (toolNames.has("web_fetch") && (needsWebFetch(queryText) || prefersDeepResearchFetch(queryText))) {
      return { type: "tool", toolName: "web_fetch" } as const;
    }

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

    if (
      toolNames.has("bash")
      && (
        routedSkillIds.has("skill-hub")
        || routedSkillIds.has("skill-search")
        || routedSkillIds.has("memory-management")
        || routedSkillIds.has("thread-management")
        || routedSkillIds.has("tasks")
        || routedSkillIds.has("plan-mode")
        || routedSkillIds.has("scheduler")
        || routedSkillIds.has("system-info")
        || routedSkillIds.has("file-manager")
        || needsCameraCapture(queryText)
        || needsFileManagement(queryText)
      )
    ) {
      return { type: "tool", toolName: "bash" } as const;
    }

    return undefined;
  })();

  const dynamicBlocks = [
    recentConversationFocus.content,
    sessionContext.activeTurn,
    sessionContext.recentToolActivity,
    sessionContext.recentResearchMemory,
    profileFactMemory.content,
    historicalContext.content,
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
    skillRoutingMs: timings.skillRoutingMs,
    skillsMs: timings.skillsMs,
    runtimeSettingsMs: timings.runtimeSettingsMs,
    sandboxMs: timings.sandboxMs,
    activeSkillsMs: timings.activeSkillsMs,
    toolsMs: timings.toolsMs,
    promptAssemblyMs: timings.promptAssemblyMs,
  }).reduce((sum, value) => sum + (typeof value === "number" ? value : 0), 0));

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
    routedSkillIds: routedSkills.map((skill) => skill.id),
  };
}

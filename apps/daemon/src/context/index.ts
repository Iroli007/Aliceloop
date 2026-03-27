import type { ModelMessage, ToolChoice, ToolSet } from "ai";
import { logPerfTrace, nowMs, roundMs } from "../runtime/perfTrace";
import { buildPersonaPrompt } from "./prompts/identityPrompt";
import {
  buildSessionContextFragments,
} from "./session/sessionContext";
import { buildSkillContextBlock } from "./skills/skillLoader";
import { resolveRelevantSkillRouting } from "./skills/skillRouter";
import {
  advanceSessionSkillCacheTurn,
  getSessionSkillCacheHints,
  inspectSessionSkillCache,
  rememberSessionSkillRoute,
} from "./skills/sessionSkillCache";
import { getSkillGroupIdsForSkill, mergeSkillRouteHints, needsBrowserAutomation, needsImageAnalysis, needsWebFetch, needsWebResearch } from "./skills/skillRouting";
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
  routedSkillIds: string[];
}

const DEFAULT_SAFETY: Omit<SafetyConfig, "abortSignal"> = {
  maxIterations: 150,
  maxDurationMs: 20 * 60 * 1000, // 20 minutes
};

function prefersDeepResearchFetch(query: string) {
  return /深度研究|深入研究|深挖|深扒|别偷懒|别只看摘要|别看摘要|去读|读一下|看原文|看正文|看全文|看来源|看帖子|看词条|看页面|补完|补全|继续深挖|继续深查|继续研究|现在什么情况|现在咋样|现在怎么样|最新情况|有进展吗|进展如何|怎么样了|情况怎么样|还有进展吗/u.test(query.trim());
}

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
  timings.taskWorkingMemoryMs = sessionContext.timings.taskWorkingMemoryMs;
  timings.messagesMs = sessionContext.timings.messagesMs;

  const latestUserQuery = sessionContext.latestUserQuery;
  const recentConversationFocus = sessionContext.recentConversationFocus;
  const latestUserHasImageAttachment = recentConversationFocus.latestUserHasImageAttachment;

  const userQuery = recentConversationFocus.effectiveUserQuery ?? latestUserQuery;
  timings.effectiveUserQueryChars = typeof userQuery === "string" ? userQuery.length : 0;

  advanceSessionSkillCacheTurn(sessionId);
  const shouldUseSkillCache = recentConversationFocus.continuationLike
    || recentConversationFocus.researchContinuation;
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

  timings.projectBindingAggregated = 1;
  timings.attachmentRootsAggregated = 1;

  const skillRoutingStartedAt = nowMs();
  const routedSkillDecision = await resolveRelevantSkillRouting(userQuery, routeHints, {
    abortSignal,
  });
  const routedSkills = routedSkillDecision.skills;
  const routedSkillGroupIds = [...new Set(routedSkills.flatMap((skill) => getSkillGroupIdsForSkill(skill.id)))];
  rememberSessionSkillRoute(sessionId, {
    skillIds: routedSkills.map((skill) => skill.id),
    groupIds: routedSkillGroupIds,
  });
  timings.skillRoutingMs = roundMs(nowMs() - skillRoutingStartedAt);
  timings.skillRouteSource = routedSkillDecision.routeSource;
  timings.ruleSkillCount = routedSkillDecision.ruleSkillIds.length;
  timings.fallbackSkillCount = routedSkillDecision.fallbackSkillIds.length;
  const browserRelayAvailable = hasHealthyDesktopRelay();
  const skillsStartedAt = nowMs();
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
  timings.activeSkillsMs = roundMs(nowMs() - activeSkillsStartedAt);

  const toolsStartedAt = nowMs();
  const tools = buildToolSet(sandbox, routedSkills, {
    sessionId,
    query: userQuery,
    routeHints,
    hasImageAttachment: latestUserHasImageAttachment,
  });
  timings.toolsMs = roundMs(nowMs() - toolsStartedAt);
  timings.toolQueryChars = typeof userQuery === "string" ? userQuery.length : 0;

  const initialToolChoice = (() => {
    const toolNames = new Set(Object.keys(tools));
    const queryText = userQuery ?? "";
    const routedSkillIds = new Set(routedSkills.map((skill) => skill.id));

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
        routedSkillIds.has("skill-discovery")
        || routedSkillIds.has("skills-search")
        || routedSkillIds.has("memory-management")
        || routedSkillIds.has("thread-management")
        || routedSkillIds.has("self-reflection")
        || routedSkillIds.has("tasks")
        || routedSkillIds.has("plan-mode")
        || routedSkillIds.has("scheduler")
        || routedSkillIds.has("system-info")
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

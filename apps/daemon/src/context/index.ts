import type { ModelMessage, ToolChoice, ToolSet } from "ai";
import { logPerfTrace, nowMs, roundMs } from "../runtime/perfTrace";
import {
  buildPromptCacheRequestTrace,
  type PromptCacheRequestTrace,
} from "../runtime/promptCacheTelemetry";
import { buildPersonaPrompt } from "./prompts/identityPrompt";
import { buildProfileFactMemoryBlock } from "./memory/memoryContext";
import {
  buildActiveTurnPromptSectionsFromFocus,
  buildSessionContextFragments,
} from "./session/sessionContext";
import { buildHistoricalContextBlock } from "./session/historyContext";
import { buildSkillContextSections, selectRelevantSkillDefinitions } from "./skills/skillLoader";
import { buildTurnIntentDecision, mergeSkillRouteHints, needsEpisodicHistoryRecall } from "./skills/skillRouting";
import { buildToolSet, getToolSchemaLifecycle } from "./tools/toolRegistry";
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
import { type CachedSystemPromptMessage } from "./cacheControl";
import {
  buildSystemPromptFromSections,
  cachedSystemPromptSection,
  uncachedSystemPromptSection,
} from "./systemPromptSections";

export interface SafetyConfig {
  maxIterations: number;
  maxDurationMs: number;
  abortSignal: AbortSignal;
}

export interface AgentContext {
  systemPrompt: string | CachedSystemPromptMessage[];
  messages: ModelMessage[];
  tools: ToolSet;
  promptCacheTrace: PromptCacheRequestTrace;
  firstStepToolChoice?: ToolChoice<ToolSet>;
  safetyConfig: SafetyConfig;
  timings: Record<string, number | string | null>;
  displaySkillIds: string[];
}

const DEFAULT_SAFETY: Omit<SafetyConfig, "abortSignal"> = {
  maxIterations: 150,
  maxDurationMs: 20 * 60 * 1000, // 20 minutes
};

interface LoadContextOptions {
  additionalStickySkillIds?: string[];
  additionalToolNames?: string[];
  enableAnthropicToolSearch?: boolean;
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
  const intentDecision = buildTurnIntentDecision(userQuery, {
    hints: routeHints,
    hasImageAttachment: latestUserHasImageAttachment,
    researchContinuation: recentConversationFocus.researchContinuation,
    continuationLike: recentConversationFocus.continuationLike,
  });
  const turnRouteHints = intentDecision.routeHints;
  timings.cachedSkillCount = 0;
  timings.cachedSkillGroupCount = 0;
  timings.skillCacheUsed = 0;

  timings.projectBindingAggregated = 1;
  timings.attachmentRootsAggregated = 1;

  const skillRoutingStartedAt = nowMs();
  const routedSkills = selectRelevantSkillDefinitions(userQuery, turnRouteHints);
  timings.skillRoutingMs = roundMs(nowMs() - skillRoutingStartedAt);
  timings.skillRouteSource = "metadata";
  timings.ruleSkillCount = routedSkills.length;
  timings.fallbackSkillCount = 0;
  const browserRelayAvailable = hasHealthyDesktopRelay();
  const skillsStartedAt = nowMs();
  const skillContext = buildSkillContextSections(routedSkills, {
    browserRelayAvailable,
    routeHints: turnRouteHints,
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
    routeHints: turnRouteHints,
    hasImageAttachment: latestUserHasImageAttachment,
    browserRelayAvailable,
    additionalToolNames: options?.additionalToolNames ?? [],
    enableAnthropicToolSearch: options?.enableAnthropicToolSearch === true,
  });
  timings.toolsMs = roundMs(nowMs() - toolsStartedAt);
  timings.toolQueryChars = typeof userQuery === "string" ? userQuery.length : 0;
  timings.anthropicToolSearchEnabled = "tool_search_tool_bm25" in tools ? 1 : 0;
  timings.deferredToolCount = Object.values(tools).filter((toolDefinition) => {
    const providerOptions = toolDefinition.providerOptions;
    const anthropic = providerOptions && typeof providerOptions === "object" && "anthropic" in providerOptions
      ? providerOptions.anthropic
      : null;
    return Boolean(anthropic && typeof anthropic === "object" && "deferLoading" in anthropic);
  }).length;

  const initialToolChoice = (() => {
    const toolNames = new Set(Object.keys(tools));

    if (toolNames.has("view_image") && (latestUserHasImageAttachment || intentDecision.needs.imageAnalysis)) {
      return { type: "tool", toolName: "view_image" } as const;
    }

    if (intentDecision.needs.toolDiscovery) {
      if (toolNames.has("tool_search")) {
        return { type: "tool", toolName: "tool_search" } as const;
      }

      if (toolNames.has("tool_search_tool_bm25")) {
        return { type: "tool", toolName: "tool_search_tool_bm25" } as const;
      }
    }

    if (toolNames.has("web_fetch") && (intentDecision.needs.webFetch || intentDecision.needs.deepResearchFetch)) {
      return { type: "tool", toolName: "web_fetch" } as const;
    }

    if ((recentConversationFocus.researchContinuation || intentDecision.needs.webResearch) && toolNames.has("web_search")) {
      return { type: "tool", toolName: "web_search" } as const;
    }

    if (intentDecision.needs.browserAutomation) {
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
        || intentDecision.needs.cameraCapture
        || intentDecision.needs.fileManagement
      )
    ) {
      return { type: "tool", toolName: "bash" } as const;
    }

    return undefined;
  })();

  const activeTurnSections = buildActiveTurnPromptSectionsFromFocus(recentConversationFocus);

  const promptAssemblyStartedAt = nowMs();
  const {
    systemPrompt,
    cachedSectionIds,
    uncachedSectionIds,
  } = buildSystemPromptFromSections(persona, [
    cachedSystemPromptSection(
      "tool_search_guidance",
      "tool_search_tool_bm25" in tools
        ? [
            "## Deferred Tool Discovery",
            "- A BM25 tool search tool is available for this turn: use `tool_search_tool_bm25` when you need a more specialized tool that is not currently visible in the loaded tool set.",
            "- Many less-common tools are intentionally deferred to preserve context and prompt caching. Search with natural language, then use the discovered tool references instead of assuming the capability is missing.",
            "- Keep using already loaded core tools directly for common work: file editing, bash, web search/fetch, image viewing, and the basic browser entry tools.",
          ].join("\n")
        : "",
    ),
    uncachedSystemPromptSection("recent_conversation_focus", recentConversationFocus.content),
    cachedSystemPromptSection("active_turn_prefix", activeTurnSections.prefix),
    cachedSystemPromptSection("skill_context_prefix", skillContext.prefix),
    cachedSystemPromptSection("task_working_memory_prefix", sessionContext.taskWorkingMemorySections.prefix),
    uncachedSystemPromptSection("active_turn_tail", activeTurnSections.tail),
    uncachedSystemPromptSection("task_working_memory_tail", sessionContext.taskWorkingMemorySections.tail),
    uncachedSystemPromptSection("recent_tool_activity", sessionContext.recentToolActivity),
    uncachedSystemPromptSection("recent_research_memory", sessionContext.recentResearchMemory),
    uncachedSystemPromptSection("profile_fact_memory", profileFactMemory.content),
    uncachedSystemPromptSection("historical_context", historicalContext.content),
    uncachedSystemPromptSection("skill_context_tail", skillContext.tail),
  ]);
  timings.promptAssemblyMs = roundMs(nowMs() - promptAssemblyStartedAt);
  if (Array.isArray(systemPrompt)) {
    timings.systemPromptParts = systemPrompt.length;
    timings.systemPromptChars = roundMs(systemPrompt.reduce((sum, message) => sum + message.content.length, 0));
  } else {
    timings.systemPromptParts = 1;
    timings.systemPromptChars = roundMs(systemPrompt.length);
  }
  timings.systemPromptCachedSectionCount = cachedSectionIds.length;
  timings.systemPromptCachedSectionIds = cachedSectionIds.join(",");
  timings.systemPromptUncachedSectionCount = uncachedSectionIds.length;
  timings.systemPromptUncachedSectionIds = uncachedSectionIds.join(",");
  timings.dynamicBlockCount = uncachedSectionIds.length;
  const uncachedSectionCharCount = [
    recentConversationFocus.content,
    activeTurnSections.tail,
    sessionContext.taskWorkingMemorySections.tail,
    sessionContext.recentToolActivity,
    sessionContext.recentResearchMemory,
    profileFactMemory.content,
    historicalContext.content,
    skillContext.tail,
  ].filter(Boolean).reduce((sum, block) => sum + block.length, 0);
  timings.dynamicPromptChars = roundMs(uncachedSectionCharCount);
  const toolNames = Object.keys(tools);
  timings.toolSchemaBaseCount = toolNames.filter((toolName) => getToolSchemaLifecycle(toolName) === "base").length;
  timings.toolSchemaSessionStableCount = toolNames.filter((toolName) => getToolSchemaLifecycle(toolName) === "session-stable").length;
  timings.toolSchemaDynamicCount = toolNames.filter((toolName) => getToolSchemaLifecycle(toolName) === "dynamic").length;
  timings.toolSchemaVolatileCount = toolNames.filter((toolName) => getToolSchemaLifecycle(toolName) === "volatile").length;
  const promptCacheTelemetryStartedAt = nowMs();
  const promptCacheTrace = await buildPromptCacheRequestTrace({
    systemPrompt,
    tools,
    messages,
  });
  timings.promptCacheTelemetryMs = roundMs(nowMs() - promptCacheTelemetryStartedAt);
  timings.promptCacheBreakpointCount = promptCacheTrace.breakpointCount;
  timings.promptCacheBreakpointIds = promptCacheTrace.breakpointIds.join(",");
  timings.promptCacheRequestHash = promptCacheTrace.requestHash;
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
    promptCacheTelemetryMs: timings.promptCacheTelemetryMs,
  }).reduce((sum, value) => sum + (typeof value === "number" ? value : 0), 0));

  logPerfTrace("load_context", {
    sessionId,
    ...timings,
  });

  return {
    systemPrompt,
    messages,
    tools,
    promptCacheTrace,
    firstStepToolChoice: initialToolChoice,
    safetyConfig: {
      ...DEFAULT_SAFETY,
      abortSignal,
    },
    timings,
    displaySkillIds: routedSkills.map((skill) => skill.id),
  };
}

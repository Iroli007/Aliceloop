import type { ModelMessage, ToolChoice, ToolSet } from "ai";
import { logPerfTrace, nowMs, roundMs } from "../runtime/perfTrace";
import {
  buildPromptCacheRequestTrace,
  type PromptCacheRequestTrace,
} from "../runtime/promptCacheTelemetry";
import { buildPersonaPrompt } from "./prompts/identityPrompt";
import { buildProfileFactMemoryBlock, type MemoryBlockResult } from "./memory/memoryContext";
import {
  buildActiveTurnPromptSectionsFromFocus,
  buildSessionContextFragments,
} from "./session/sessionContext";
import { buildHistoricalContextBlock } from "./session/historyContext";
import { buildSkillContextSections, selectRelevantSkillDefinitions } from "./skills/skillLoader";
import { buildTurnIntentDecision, mergeSkillRouteHints, needsEpisodicHistoryRecall, shouldStartAgentForTurn } from "./skills/skillRouting";
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
  displayMemories: string[];
  displaySkillIds: string[];
}

const DEFAULT_SAFETY: Omit<SafetyConfig, "abortSignal"> = {
  maxIterations: 150,
  maxDurationMs: 20 * 60 * 1000, // 20 minutes
};
const RETRIEVED_MEMORY_LIMIT = 5;
const RETRIEVED_MEMORY_TIMEOUT_MS = 900;

interface LoadContextOptions {
  additionalStickySkillIds?: string[];
  additionalToolNames?: string[];
  enableAnthropicToolSearch?: boolean;
}

function skippedMemoryBlock(skipReason: string, startedAt: number): MemoryBlockResult {
  return {
    content: "",
    displayMemories: [],
    timings: {
      skipReason,
      totalMs: roundMs(nowMs() - startedAt),
    },
  };
}

function prefetchProfileFactMemory(queryText: string | null | undefined, abortSignal: AbortSignal) {
  const startedAt = nowMs();
  const trimmedQuery = queryText?.trim();
  if (!trimmedQuery) {
    return Promise.resolve(skippedMemoryBlock("no_query", startedAt));
  }

  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<MemoryBlockResult>((resolve) => {
    timeout = setTimeout(() => {
      resolve(skippedMemoryBlock("memory_prefetch_timeout", startedAt));
    }, RETRIEVED_MEMORY_TIMEOUT_MS);
  });

  const memoryPromise = buildProfileFactMemoryBlock(trimmedQuery, {
    limit: RETRIEVED_MEMORY_LIMIT,
    abortSignal,
  }).catch(() => skippedMemoryBlock("memory_prefetch_failed", startedAt));

  return Promise.race([memoryPromise, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
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
  timings.openTaskMs = sessionContext.timings.openTaskMs;
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
  const profileFactMemoryPromise = prefetchProfileFactMemory(userQuery, abortSignal);
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
    fileManagementContinuation: recentConversationFocus.fileManagementContinuation,
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
    sessionId,
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

  const profileFactMemoryStartedAt = nowMs();
  const profileFactMemory = await profileFactMemoryPromise;
  timings.profileFactMemoryMs = typeof profileFactMemory.timings.totalMs === "number"
    ? profileFactMemory.timings.totalMs
    : roundMs(nowMs() - profileFactMemoryStartedAt);
  timings.profileFactMemoryChars = profileFactMemory.content.length;
  timings.profileFactMemoryCount = profileFactMemory.timings.memoryCount ?? null;
  timings.profileFactMemorySkipReason = typeof profileFactMemory.timings.skipReason === "string"
    ? profileFactMemory.timings.skipReason
    : null;

  const additionalToolNames = [
    ...(options?.additionalToolNames ?? []),
    ...(profileFactMemory.displayMemories.length > 0 ? ["memory_get"] : []),
    ...(recentConversationFocus.ownerToolContinuation ? [recentConversationFocus.ownerToolContinuation] : []),
    ...(recentConversationFocus.agentContinuation ? ["agent"] : []),
  ];

  const toolsStartedAt = nowMs();
  const tools = buildToolSet(sandbox, routedSkills, {
    sessionId,
    query: userQuery,
    routeHints: turnRouteHints,
    hasImageAttachment: latestUserHasImageAttachment,
    browserRelayAvailable,
    additionalToolNames,
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

    if (
      recentConversationFocus.ownerToolContinuation
      && toolNames.has(recentConversationFocus.ownerToolContinuation)
    ) {
      return {
        type: "tool",
        toolName: recentConversationFocus.ownerToolContinuation,
      } as const;
    }

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

    if (toolNames.has("agent") && (shouldStartAgentForTurn(userQuery) || recentConversationFocus.agentContinuation)) {
      return { type: "tool", toolName: "agent" } as const;
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
        intentDecision.needs.cameraCapture
        || intentDecision.needs.fileManagement
        || routedSkillIds.has("skill-hub")
        || routedSkillIds.has("skill-search")
        || routedSkillIds.has("memory-management")
        || routedSkillIds.has("thread-management")
        || routedSkillIds.has("tasks")
        || routedSkillIds.has("plan-mode")
        || routedSkillIds.has("scheduler")
        || routedSkillIds.has("system-info")
        || routedSkillIds.has("file-manager")
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
    uncachedSystemPromptSection("retrieved_memories", profileFactMemory.content),
    cachedSystemPromptSection(
      "agent_delegation_guidance",
      "agent" in tools
        ? [
            "## Child Agents",
            "- The `agent` tool is available this turn for delegated work.",
            "- Use `subagent_type` to select the execution template: general-purpose, coder, Plan, Explore, alma-guide, alma-operator, statusline-setup.",
            "- Use `persona` for the expert perspective: developer, designer, researcher, product-manager, operator, planner, evaluator.",
            "- Use `execution_mode: \"ephemeral\"` for one-off expert critique, planning, memory curation, or structured synthesis that does not need tools, a transcript, background execution, or later resume.",
            "- Use the default session execution mode for child-agent work that needs tool access, long-running execution, visible transcript, `read_output`, or resume.",
            "- `agent_id` is not an input selector; it appears in the tool result as the runtime id of the spawned child agent.",
            "- The stable child agent key is `subagent_type` plus optional `persona`; reuse the same pair when checking or continuing that expert.",
            "- When the user asks a named expert such as designer/planner/evaluator to inspect, plan, review, or execute something, call `agent` instead of answering as that expert yourself.",
            "- Useful defaults: UI/design review uses `Explore` + `designer`; implementation uses `coder` + `developer`; planning uses `Plan` + `planner`; evaluation/review uses `Explore` + `evaluator`.",
            "- Prefer `run_in_background: true` for broad or slow child-agent work. If a synchronous child run exceeds its wait window, the tool returns `async_launched` and the child continues in the background.",
            "- To check a background child agent, prefer `resume` with the returned `agent_id` plus `read_output: true`; otherwise use the same `subagent_type` and `persona`.",
          ].join("\n")
        : "",
    ),
    cachedSystemPromptSection(
      "tool_search_guidance",
      "tool_search" in tools || "tool_search_tool_bm25" in tools
        ? [
            "## Tool Discovery",
            "- `tool_search` is a discovery/orchestration utility. When you explain the tool stack to the user, group it with agent/skill/task-style capabilities rather than the core file-editing base tools.",
            "- For broad inventory requests such as \"what tools do you have\", run tool search across multiple capability areas and then summarize the combined coverage by category.",
            ...("tool_search_tool_bm25" in tools
              ? [
                  "- A BM25 tool search tool is also available for this turn: use `tool_search_tool_bm25` when you need a more specialized tool that is not currently visible in the loaded tool set.",
                ]
              : []),
            "- Runtime tools are attached by default for a stable tool surface. Search with natural language when you need to inspect the catalog or find the right specialized tool name.",
            "- Keep using visible core tools directly for common work: file editing, bash, web search/fetch, image viewing, and browser operations.",
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
    profileFactMemory.content,
    recentConversationFocus.content,
    activeTurnSections.tail,
    sessionContext.taskWorkingMemorySections.tail,
    sessionContext.recentToolActivity,
    sessionContext.recentResearchMemory,
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
  timings.contextTokenEstimate = promptCacheTrace.estimatedInputTokens;
  timings.contextSerializedRequestChars = promptCacheTrace.serializedRequestChars;
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
    displayMemories: profileFactMemory.displayMemories,
    displaySkillIds: routedSkills.map((skill) => skill.id),
  };
}

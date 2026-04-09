import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ModelMessage, ToolChoice, ToolSet } from "ai";
import { logPerfTrace, nowMs, roundMs } from "../runtime/perfTrace";
import { buildPersonaPrompt } from "./prompts/identityPrompt";
import { buildProfileFactMemoryBlock } from "./memory/memoryContext";
import {
  buildSessionContextFragments,
} from "./session/sessionContext";
import { buildHistoricalContextBlock } from "./session/historyContext";
import {
  buildSelectedSkillBodyBlock,
  buildSkillContextBlock,
  buildSkillDynamicOverlay,
  buildStaticSkillCatalogBlock,
  computeSkillBlockKey,
  getSkillDefinition,
  getStaticSkillCatalogKey,
  selectRelevantSkillDefinitions,
} from "./skills/skillLoader";
import { inferStickySkillIdsFromContext, mergeSkillRouteHints, needsBrowserAutomation, needsCameraCapture, needsEpisodicHistoryRecall, needsFileManagement, needsImageAnalysis, needsSystemInfo, needsWebFetch, needsWebResearch } from "./skills/skillRouting";
import { BASE_TOOL_SCHEMA_KEY, buildToolSet, computeToolSurfaceKey, DEFAULT_ATTACHED_TOOL_NAMES, STATIC_BASE_TOOL_BLOCK } from "./tools/toolRegistry";
import { hasHealthyDesktopRelay } from "./tools/desktopRelayResearch";
import { getRuntimeSettings } from "../repositories/runtimeSettingsRepository";
import { getDefaultProjectDirectory } from "../repositories/projectRepository";
import { getDataDir } from "../db/client";
import { getSessionWorksetState } from "../repositories/sessionRepository";
import { getSessionPlanModeState } from "../repositories/sessionPlanModeRepository";
import { getLatestPlan, getPlan } from "../repositories/planRepository";
import {
  markGeneratedFileDeleted,
  markSessionGeneratedFile,
} from "../repositories/sessionGeneratedFileRepository";
import { createPermissionSandboxExecutor } from "../services/sandboxExecutor";
import {
  createAgentPermissionFrontdesk,
  createDefaultAgentPermissionContext,
} from "../services/agentPermissionFrontdesk";
import { getSandboxProjectRoot } from "../runtime/sandbox/toolPolicy";
import { parseShellScriptCommandsForPolicy } from "../runtime/sandbox/toolPolicy";
import {
  getActiveWorksetSkillIds,
  getActiveWorksetToolNames,
} from "./workset/worksetState";
import { ENTER_PLAN_MODE_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME, WRITE_PLAN_ARTIFACT_TOOL_NAME } from "./tools/planModeTools";
import type { PermissionSandboxExecutor } from "../runtime/sandbox/types";
import { decideAgentBashExecutionMode } from "./tools/bashSandboxDecision";

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
  planModeActive: boolean;
  activePlanId: string | null;
}

const DEFAULT_SAFETY: Omit<SafetyConfig, "abortSignal"> = {
  maxIterations: 150,
  maxDurationMs: 20 * 60 * 1000, // 20 minutes
};

interface LoadContextOptions {
  additionalStickySkillIds?: string[];
  additionalToolNames?: string[];
  additionalSelectedSkillIds?: string[];
}

const PLAN_MODE_BLOCKED_BASH_COMMANDS = new Set([
  "chmod",
  "chown",
  "cp",
  "dd",
  "install",
  "ln",
  "mkdir",
  "mv",
  "rm",
  "rmdir",
  "tee",
  "touch",
]);

const PLAN_MODE_ALLOWED_ALICELOOP_PLAN_ACTIONS = new Set([
  "list",
  "show",
]);

const PLAN_MODE_ALLOWED_GIT_SUBCOMMANDS = new Set([
  "branch",
  "diff",
  "grep",
  "log",
  "ls-files",
  "rev-parse",
  "show",
  "status",
]);

function assertPlanModeParsedCommand(
  parsedCommand: { command: string; args?: string[] },
): { command: string; args: string[] } {
  const command = parsedCommand.command.trim();
  const args = [...(parsedCommand.args ?? [])];

  if (!command || command === ":") {
    return {
      command: ":",
      args: [],
    };
  }

  if (PLAN_MODE_BLOCKED_BASH_COMMANDS.has(command)) {
    throw new Error(`Plan mode blocked write-oriented bash command: ${command}`);
  }

  if (command === "sed" && args.some((arg) => arg === "-i" || arg === "--in-place" || arg.startsWith("-i"))) {
    throw new Error("Plan mode blocked in-place sed edits.");
  }

  if (command === "npm") {
    const subcommand = args.find((arg) => arg && !arg.startsWith("-"));
    if (subcommand && !["help", "root", "prefix", "bin", "version", "view", "query", "search", "ls", "outdated", "explain", "pkg"].includes(subcommand)) {
      throw new Error(`Plan mode blocked npm ${subcommand}; use read-only npm inspection commands only.`);
    }
  }

  if (command === "git") {
    const subcommand = args[0]?.trim() ?? "";
    if (!PLAN_MODE_ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
      throw new Error(`Plan mode blocked git ${subcommand || "<missing>"}; use read-only git inspection commands only.`);
    }
  }

  if (command === "aliceloop") {
    const subcommand = args[0]?.trim();
    if (subcommand !== "plan") {
      if (subcommand && PLAN_MODE_ALLOWED_ALICELOOP_PLAN_ACTIONS.has(subcommand)) {
        return {
          command,
          args: ["plan", ...args],
        };
      }
      throw new Error("Plan mode only allows `aliceloop plan ...` commands. Use the plan mode tools to enter or exit planning.");
    }
  }

  return {
    command,
    args,
  };
}

function prefersDeepResearchFetch(query: string) {
  return /深度研究|深入研究|深挖|深扒|别偷懒|别只看摘要|别看摘要|去读|读一下|看原文|看正文|看全文|看来源|看帖子|看词条|看页面|补完|补全|继续深挖|继续深查|继续研究|现在什么情况|现在咋样|现在怎么样|最新情况|有进展吗|进展如何|怎么样了|情况怎么样|还有进展吗/u.test(query.trim());
}

function buildPlanModeReminder(sessionId: string, activePlanId: string | null) {
  const planRef = activePlanId ? `Plan #${activePlanId.slice(0, 8)}` : "当前绑定计划";
  return [
    "Plan mode is active for this thread.",
    `Current planning artifact: ${planRef}.`,
    "While plan mode is active, stay in planning: inspect code, analyze structure, clarify requirements, and update the bound plan record only.",
    "Read/search tools are available during planning: bash, read, glob, grep, web_search, web_fetch, view_image, and read-only browser/Chrome Relay inspection tools.",
    "Writable atomic tools and browser click/type actions are temporarily withheld for this turn.",
    "Do not implement changes, edit repository files, or execute write-oriented bash commands until plan mode is explicitly exited.",
    "Use `ask_user_question` only when progress is genuinely blocked by a concrete user decision that you cannot safely infer.",
    "Ask one structured clarification at a time. Do not dump multiple categories of questions into one assistant reply.",
    "Keep the options short, concrete, and mutually exclusive; never turn speculative related-topic guesses into a multiple-choice prompt.",
    "When requirements are still ambiguous and you are blocked, end the turn with `ask_user_question` and wait for the user's answer before continuing.",
    "Keep clarifying requirements until the solution scope is concrete enough to execute confidently.",
    `When the plan is ready, call \`${WRITE_PLAN_ARTIFACT_TOOL_NAME}\` with a clear title, a short summary/goal, and at least two ordered implementation steps.`,
    `Keep using \`${WRITE_PLAN_ARTIFACT_TOOL_NAME}\` whenever the user asks to revise the plan. The plan artifact is the source of truth, not your freeform assistant prose.`,
    `When planning is complete, call \`${EXIT_PLAN_MODE_TOOL_NAME}\` before moving into implementation. Do not call it until the active plan artifact is actually filled in.`,
    `If the user says to start building now, exit planning first with \`${EXIT_PLAN_MODE_TOOL_NAME}\`, then continue in the reloaded implementation pass.`,
    "Do not use `aliceloop plan create`, `aliceloop plan update`, `aliceloop plan approve`, or `aliceloop plan archive` from bash while planning.",
    "Do not load or rely on task/todo-style skills while planning. Plan mode is its own workflow.",
    `The current thread id is ${sessionId}. In plan mode, prefer bash command+args form, but simple read-only shell chains like \`which python3 && python3 --version\` are allowed.`,
  ].join("\n");
}

function buildPlanArtifactBlock(sessionId: string, activePlanId: string | null, planModeActive: boolean) {
  const plan = planModeActive
    ? (activePlanId ? getPlan(activePlanId) : null)
    : getLatestPlan(sessionId, "approved");
  if (!plan) {
    return "";
  }

  const steps = plan.steps.length > 0
    ? plan.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")
    : "1. Fill in concrete implementation steps.";

  return [
    planModeActive ? "Current plan artifact:" : "Most recent approved plan for this thread:",
    `Plan ID: ${plan.id}`,
    `Title: ${plan.title || "Untitled plan"}`,
    `Goal: ${plan.goal || "(no goal recorded yet)"}`,
    "Steps:",
    steps,
    planModeActive
      ? "Keep this plan record updated while clarifying requirements."
      : "Use this plan as the execution guide unless the user changes direction. Execute the steps in order and prefer finishing the work in the current thread unless the user explicitly asks for delegated parallel work.",
  ].join("\n");
}

function createPlanModeSandboxExecutor(
  sandbox: PermissionSandboxExecutor,
) {
  return {
    ...sandbox,
    async writeBinaryFile(_input: Parameters<typeof sandbox.writeBinaryFile>[0]) {
      throw new Error("Plan mode only allows read-only exploration and plan record updates.");
    },
    async writeTextFile(_input: Parameters<typeof sandbox.writeTextFile>[0]) {
      throw new Error("Plan mode only allows read-only exploration and plan record updates.");
    },
    async editTextFile(_input: Parameters<typeof sandbox.editTextFile>[0]) {
      throw new Error("Plan mode only allows read-only exploration and plan record updates.");
    },
    async deletePath(_input: Parameters<typeof sandbox.deletePath>[0]) {
      throw new Error("Plan mode does not allow deleting files.");
    },
    async runBash(input: Parameters<typeof sandbox.runBash>[0]) {
      if (input.script?.trim()) {
        const parsedCommands = parseShellScriptCommandsForPolicy(input.script);
        if (parsedCommands.length === 0) {
          return {
            stdout: "",
            stderr: "",
          };
        }

        for (const parsedCommand of parsedCommands) {
          assertPlanModeParsedCommand(parsedCommand);
        }

        return sandbox.runBash(input);
      }

      const normalizedInput = assertPlanModeParsedCommand({
        command: input.command,
        args: input.args,
      });
      if (normalizedInput.command === ":") {
        return {
          stdout: "",
          stderr: "",
        };
      }

      return sandbox.runBash({
        ...input,
        command: normalizedInput.command,
        args: normalizedInput.args,
      });
    },
  };
}

type PermissionPolicySnapshot = ReturnType<PermissionSandboxExecutor["describePolicy"]>;

function createDirectFileExecutor(input: {
  noteCreatedFile?: (targetPath: string) => Promise<void> | void;
  noteDeletedFile?: (targetPath: string) => Promise<void> | void;
}) {
  return {
    async readTextFile(options: Parameters<PermissionSandboxExecutor["readTextFile"]>[0]) {
      return readFile(resolve(options.targetPath), "utf8");
    },

    async writeBinaryFile(options: Parameters<PermissionSandboxExecutor["writeBinaryFile"]>[0]) {
      const targetPath = resolve(options.targetPath);
      let createdNew = false;
      try {
        await lstat(targetPath);
      } catch {
        createdNew = true;
      }
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, options.content);
      if (createdNew) {
        await input.noteCreatedFile?.(targetPath);
      }
      return targetPath;
    },

    async writeTextFile(options: Parameters<PermissionSandboxExecutor["writeTextFile"]>[0]) {
      const targetPath = resolve(options.targetPath);
      let createdNew = false;
      try {
        await lstat(targetPath);
      } catch {
        createdNew = true;
      }
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, options.content, "utf8");
      if (createdNew) {
        await input.noteCreatedFile?.(targetPath);
      }
      return targetPath;
    },

    async editTextFile(options: Parameters<PermissionSandboxExecutor["editTextFile"]>[0]) {
      const targetPath = resolve(options.targetPath);
      const before = await readFile(targetPath, "utf8");
      const after = options.transform(before);
      await writeFile(targetPath, after, "utf8");
      return after;
    },

    async deletePath(options: Parameters<PermissionSandboxExecutor["deletePath"]>[0]) {
      const targetPath = resolve(options.targetPath);
      const stats = await lstat(targetPath);
      await rm(targetPath, {
        force: false,
        recursive: stats.isDirectory(),
      });
      if (!stats.isDirectory()) {
        await input.noteDeletedFile?.(targetPath);
      }
      return targetPath;
    },
  };
}

function createAgentExecutionExecutor(input: {
  label: string;
  workspaceRoot: string;
  defaultCwd: string;
  noteCreatedFile?: (targetPath: string) => Promise<void> | void;
  noteDeletedFile?: (targetPath: string) => Promise<void> | void;
}): PermissionSandboxExecutor {
  const fileExecutor = createDirectFileExecutor({
    noteCreatedFile: input.noteCreatedFile,
    noteDeletedFile: input.noteDeletedFile,
  });
  const bashSandbox = createPermissionSandboxExecutor({
    label: `${input.label}:bash`,
    permissionProfile: "full-access",
    autoApproveToolRequests: true,
    workspaceRoot: input.workspaceRoot,
    keepFilesystemBoundaryInFullAccess: true,
    supportsElevatedActionsInFullAccess: true,
    extraReadRoots: [getSandboxProjectRoot(), getDataDir()],
    defaultCwd: input.defaultCwd,
    noteDeletedFile: input.noteDeletedFile,
  });
  const bashHost = createPermissionSandboxExecutor({
    label: `${input.label}:bash-host`,
    permissionProfile: "full-access",
    autoApproveToolRequests: true,
    defaultCwd: input.defaultCwd,
    noteDeletedFile: input.noteDeletedFile,
  });
  const bashPolicy = bashSandbox.describePolicy();
  const policy: PermissionPolicySnapshot = {
    ...bashPolicy,
    label: input.label,
    allowedReadRoots: ["<all>"],
    allowedWriteRoots: ["<all>"],
    allowedCwdRoots: ["<all>"],
    allowedCommands: ["<all>"],
    runtimeReason: "Main agent files execute directly after frontdesk approval; bash is explicitly routed to a workspace sandbox or host execution based on workspace path usage.",
    warnings: [
      "main-agent file tools execute directly on the host after frontdesk approval",
      "main-agent bash uses an explicit execution decision layer: workspace-local commands stay sandboxed, workspace-escaping commands run on the host",
      "complex bash syntax still stays on the sandbox path first and can retry unsandboxed once when that sandbox blocks it",
    ],
  };

  return {
    ...fileExecutor,
    async runBash(inputOptions) {
      const executionMode = decideAgentBashExecutionMode(inputOptions, {
        workspaceRoot: input.workspaceRoot,
        defaultCwd: input.defaultCwd,
      });
      return executionMode === "host"
        ? bashHost.runBash(inputOptions)
        : bashSandbox.runBash(inputOptions);
    },
    describePolicy() {
      return policy;
    },
  };
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
  timings.sessionFocusMs = sessionContext.timings.sessionFocusMs;
  timings.rollingSummaryMs = sessionContext.timings.rollingSummaryMs;
  timings.recentToolTraceMs = sessionContext.timings.recentToolTraceMs;
  timings.recentConversationFocusMs = sessionContext.timings.recentConversationFocusMs;
  timings.recentResearchMemoryMs = sessionContext.timings.recentResearchMemoryMs;
  timings.activeTurnMs = sessionContext.timings.activeTurnMs;
  timings.latestTurnMs = sessionContext.timings.latestTurnMs;
  timings.recentToolActivityMs = sessionContext.timings.recentToolActivityMs;
  timings.messagesMs = sessionContext.timings.messagesMs;

  const latestUserQuery = sessionContext.latestUserQuery;
  const recentConversationFocus = sessionContext.recentConversationFocus;
  const latestUserHasImageAttachment = recentConversationFocus.latestUserHasImageAttachment;
  const planModeStateStartedAt = nowMs();
  const planModeState = getSessionPlanModeState(sessionId);
  timings.planModeStateMs = roundMs(nowMs() - planModeStateStartedAt);
  timings.planModeActive = planModeState.active ? 1 : 0;
  timings.planModePlanId = planModeState.activePlanId;
  const planModeReminder = planModeState.active
    ? buildPlanModeReminder(sessionId, planModeState.activePlanId)
    : "";
  const planArtifactBlock = buildPlanArtifactBlock(sessionId, planModeState.activePlanId, planModeState.active);
  timings.planArtifactChars = planArtifactBlock.length;

  const userQuery = recentConversationFocus.effectiveUserQuery ?? latestUserQuery;
  timings.effectiveUserQueryChars = typeof userQuery === "string" ? userQuery.length : 0;
  const sessionWorksetStateStartedAt = nowMs();
  const sessionWorksetState = getSessionWorksetState(sessionId);
  timings.sessionWorksetStateMs = roundMs(nowMs() - sessionWorksetStateStartedAt);
  const shouldCarryForwardWorkset = Boolean(
    recentConversationFocus.continuationLike || recentConversationFocus.researchContinuation,
  );
  const activeWorksetSkillIds = shouldCarryForwardWorkset ? getActiveWorksetSkillIds(sessionWorksetState) : [];
  const activeWorksetToolNames = shouldCarryForwardWorkset ? getActiveWorksetToolNames(sessionWorksetState) : [];
  timings.sessionWorksetActiveSkillCount = activeWorksetSkillIds.length;
  timings.sessionWorksetActiveToolCount = activeWorksetToolNames.length;

  const queryIntentStickySkillIds = userQuery ? inferStickySkillIdsFromContext(userQuery) : [];
  const routeHints = mergeSkillRouteHints(
    recentConversationFocus.routeHints,
    userQuery
      ? {
          stickySkillIds: queryIntentStickySkillIds,
          reasons: ["query-intent"],
        }
      : null,
    activeWorksetSkillIds.length > 0
      ? {
          stickySkillIds: activeWorksetSkillIds,
          reasons: ["session-workset"],
        }
      : null,
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
  const additionallySelectedSkillIds = planModeState.active
    ? []
    : [...new Set(options?.additionalSelectedSkillIds ?? [])];
  const routedSkills = planModeState.active
    ? []
    : (() => {
        const routedSkillMap = new Map(
          selectRelevantSkillDefinitions(userQuery, routeHints).map((skill) => [skill.id, skill] as const),
        );
        for (const skillId of additionallySelectedSkillIds) {
          const skill = getSkillDefinition(skillId);
          if (skill?.status === "available") {
            routedSkillMap.set(skill.id, skill);
          }
        }
        return [...routedSkillMap.values()].sort((a, b) => a.id.localeCompare(b.id));
      })();
  timings.skillRoutingMs = roundMs(nowMs() - skillRoutingStartedAt);
  timings.skillRouteSource = planModeState.active ? "suppressed:plan-mode" : "metadata";
  timings.ruleSkillCount = routedSkills.length;
  timings.fallbackSkillCount = 0;
  timings.forcedSkillCount = additionallySelectedSkillIds.length;
  timings.forcedSkills = additionallySelectedSkillIds.join(",");
  const browserRelayAvailable = hasHealthyDesktopRelay();
  const skillsStartedAt = nowMs();
  const staticSkillCatalogBlock = planModeState.active ? "" : buildStaticSkillCatalogBlock();
  const selectedSkillBodies = planModeState.active
    ? { content: "", keys: [] as string[] }
    : buildSelectedSkillBodyBlock(routedSkills);
  const skillDynamicOverlay = planModeState.active
    ? ""
    : buildSkillDynamicOverlay(routedSkills, {
        browserRelayAvailable,
        routeHints,
      });
  const skills = planModeState.active
    ? ""
    : buildSkillContextBlock(routedSkills, {
        browserRelayAvailable,
        routeHints,
      });
  timings.skillsMs = roundMs(nowMs() - skillsStartedAt);
  timings.skillBlockChars = skills.length;
  timings.skillBlockKey = computeSkillBlockKey(skills);
  timings.staticSkillCatalogChars = staticSkillCatalogBlock.length;
  timings.staticSkillCatalogKey = getStaticSkillCatalogKey();
  timings.skillBodyChars = selectedSkillBodies.content.length;
  timings.skillBodyKeys = selectedSkillBodies.keys.join(",");
  timings.skillDynamicOverlayChars = skillDynamicOverlay.length;
  timings.skillDynamicOverlayKey = skillDynamicOverlay ? computeSkillBlockKey(skillDynamicOverlay) : null;
  timings.routedSkillCount = routedSkills.length;
  timings.routedSkills = routedSkills.map((skill) => skill.id).join(",");
  timings.routedSkillGroups = "";
  timings.browserRelayAvailable = browserRelayAvailable ? 1 : 0;

  const routedSkillIds = new Set(routedSkills.map((skill) => skill.id));

  const profileFactMemoryStartedAt = nowMs();
  const profileFactMemory = routedSkillIds.has("memory-management") && userQuery
    ? await buildProfileFactMemoryBlock({
        queryText: userQuery,
        projectId: sessionContext.projectBinding?.projectId ?? null,
        sessionId,
      })
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
  const workspaceProject = getDefaultProjectDirectory();

  const sandboxStartedAt = nowMs();
  const baseSandbox = createAgentExecutionExecutor({
    label: `agent:${sessionId}`,
    workspaceRoot: workspaceProject.path,
    defaultCwd: workspaceProject.path,
    noteCreatedFile: (targetPath) => {
      markSessionGeneratedFile(sessionId, targetPath);
    },
    noteDeletedFile: (targetPath) => {
      markGeneratedFileDeleted(targetPath);
    },
  });
  const frontdeskSandbox = createAgentPermissionFrontdesk(baseSandbox, {
    sessionId,
    abortSignal,
    permissionContext: createDefaultAgentPermissionContext({
      mode: planModeState.active
        ? "plan"
        : runtimeSettings.autoApproveToolRequests
          ? "bypassPermissions"
          : "auto",
      rules: runtimeSettings.toolPermissionRules,
      workspaceRoots: [workspaceProject.path],
    }),
  });
  const sandbox = planModeState.active ? createPlanModeSandboxExecutor(frontdeskSandbox) : frontdeskSandbox;
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
    additionalToolNames: options?.additionalToolNames ?? [],
    planModeActive: planModeState.active,
  });
  timings.toolsMs = roundMs(nowMs() - toolsStartedAt);
  timings.toolQueryChars = typeof userQuery === "string" ? userQuery.length : 0;
  const attachedToolNames = Object.keys(tools);
  const attachedToolNameSet = new Set(attachedToolNames);
  const missingAllowedToolsBySkill = planModeState.active
    ? []
    : routedSkills
    .map((skill) => ({
      skillId: skill.id,
      missingTools: skill.allowedTools.filter((toolName) => !attachedToolNameSet.has(toolName)),
    }))
    .filter((entry) => entry.missingTools.length > 0);
  timings.toolSurfaceCount = attachedToolNames.length;
  timings.toolSurfaceKey = computeToolSurfaceKey(attachedToolNames);
  timings.toolSurfaceNames = attachedToolNames.join(",");
  timings.toolSurfaceStablePrefix = attachedToolNames
    .slice(0, DEFAULT_ATTACHED_TOOL_NAMES.length)
    .every((toolName, index) => toolName === DEFAULT_ATTACHED_TOOL_NAMES[index])
    ? 1
    : 0;
  timings.baseToolSchemaKey = BASE_TOOL_SCHEMA_KEY;
  timings.baseToolSchemaCount = DEFAULT_ATTACHED_TOOL_NAMES.length;
  timings.baseToolPromptChars = STATIC_BASE_TOOL_BLOCK.length;
  timings.baseToolPromptKey = computeSkillBlockKey(STATIC_BASE_TOOL_BLOCK);
  timings.skillAllowedToolCoverageOk = missingAllowedToolsBySkill.length === 0 ? 1 : 0;
  timings.skillAllowedToolMissingCount = missingAllowedToolsBySkill.reduce((sum, entry) => {
    return sum + entry.missingTools.length;
  }, 0);
  timings.skillAllowedToolMissingBySkill = missingAllowedToolsBySkill
    .map((entry) => `${entry.skillId}:${entry.missingTools.join(",")}`)
    .join("|");

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

    if (
      toolNames.has("bash")
      && (
        needsBrowserAutomation(queryText)
        || needsCameraCapture(queryText)
        || needsFileManagement(queryText)
        || needsSystemInfo(queryText)
      )
    ) {
      return { type: "tool", toolName: "bash" } as const;
    }

    return undefined;
  })();

  const dynamicBlocks = [
    planModeReminder,
    planArtifactBlock,
    sessionContext.activeTurn,
    sessionContext.latestTurn,
    sessionContext.sessionFocus,
    sessionContext.rollingSummary,
    sessionContext.recentToolActivity,
    sessionContext.recentResearchMemory,
    profileFactMemory.content,
    historicalContext.content,
    skillDynamicOverlay,
  ].filter(Boolean);

  const promptAssemblyStartedAt = nowMs();
let systemPrompt: AgentContext["systemPrompt"];
  if (Array.isArray(persona)) {
    // persona is already system messages with cache control
    systemPrompt = [...persona];
    systemPrompt.push({
      role: "system",
      content: STATIC_BASE_TOOL_BLOCK,
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral" } }
      }
    });
    if (staticSkillCatalogBlock) {
      systemPrompt.push({
        role: "system",
        content: staticSkillCatalogBlock,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } }
        }
      });
    }
    if (selectedSkillBodies.content) {
      systemPrompt.push({
        role: "system",
        content: selectedSkillBodies.content,
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } }
        }
      });
    }
    if (dynamicBlocks.length > 0) {
      systemPrompt.push({
        role: "system",
        content: dynamicBlocks.join("\n\n"),
      });
    }
  } else {
    // fallback: persona is a string
    systemPrompt = [persona, STATIC_BASE_TOOL_BLOCK, staticSkillCatalogBlock, selectedSkillBodies.content, ...dynamicBlocks].filter(Boolean).join("\n\n");
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
    planModeActive: planModeState.active,
    activePlanId: planModeState.activePlanId,
  };
}

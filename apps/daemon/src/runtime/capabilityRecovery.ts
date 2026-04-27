import { buildTurnIntentDecision } from "../context/skills/skillRouting";
import { repairTextToolCall } from "./toolCallRepair";

export interface CapabilityRecoveryRequest {
  additionalStickySkillIds: string[];
  additionalToolNames: string[];
  reason: string;
}

export const MAX_CAPABILITY_RECOVERY_ATTEMPTS = 3;

function buildCapabilityRecoveryRequest(
  reason: string,
  input: {
    skillIds?: string[];
    toolNames?: string[];
  },
): CapabilityRecoveryRequest {
  return {
    additionalStickySkillIds: [...new Set([...(input.skillIds ?? []), "skill-search", "skill-hub"])],
    additionalToolNames: [...new Set(input.toolNames ?? [])],
    reason,
  };
}

function isRecoverableToolName(toolName: string) {
  return toolName === "tool_search"
    || toolName === "agent"
    || toolName === "bash"
    || toolName === "web_search"
    || toolName === "web_fetch"
    || toolName.startsWith("browser_")
    || toolName.startsWith("chrome_relay_");
}

function inferStickySkillsForToolName(toolName: string) {
  if (toolName === "tool_search") {
    return ["skill-hub", "skill-search"];
  }

  if (toolName === "agent") {
    return ["skill-hub", "skill-search"];
  }

  if (toolName === "web_search") {
    return ["web-search"];
  }

  if (toolName === "web_fetch") {
    return ["web-fetch"];
  }

  if (toolName.startsWith("browser_") || toolName.startsWith("chrome_relay_")) {
    return ["browser"];
  }

  return [];
}

function extractReferencedToolNameFromAssistantText(text: string) {
  const toolMatch = text.match(/\b(agent|tool_search|bash|web_search|web_fetch|browser_[a-z_]+|chrome_relay_[a-z_]+)\b/u);
  return toolMatch?.[1] ?? null;
}

function inferIntentDrivenRecoveryRequest(
  userMessage: string | null,
  attachedToolNames: string[],
): CapabilityRecoveryRequest | null {
  if (!userMessage) {
    return null;
  }

  const attached = new Set(attachedToolNames);
  const intentDecision = buildTurnIntentDecision(userMessage);

  if (intentDecision.needs.toolDiscovery && !attached.has("tool_search")) {
    return buildCapabilityRecoveryRequest("user_intent:tool_discovery", {
      skillIds: ["skill-hub", "skill-search"],
      toolNames: ["tool_search"],
    });
  }

  if (intentDecision.needs.agentDelegation && !attached.has("agent")) {
    return buildCapabilityRecoveryRequest("user_intent:agent_delegation", {
      skillIds: ["skill-hub", "skill-search"],
      toolNames: ["agent"],
    });
  }

  if (intentDecision.needs.webResearch || intentDecision.needs.webFetch || intentDecision.needs.deepResearchFetch) {
    const missingToolNames = [
      !attached.has("web_search") ? "web_search" : null,
      (intentDecision.needs.webFetch || intentDecision.needs.deepResearchFetch) && !attached.has("web_fetch")
        ? "web_fetch"
        : null,
    ].filter((toolName): toolName is string => Boolean(toolName));
    if (missingToolNames.length === 0) {
      return null;
    }
    return buildCapabilityRecoveryRequest("user_intent:research", {
      skillIds: ["web-search", "web-fetch"],
      toolNames: missingToolNames,
    });
  }

  if (
    intentDecision.needs.browserAutomation
    && !attachedToolNames.some((toolName) => toolName.startsWith("browser_") || toolName.startsWith("chrome_relay_"))
  ) {
    return buildCapabilityRecoveryRequest("user_intent:browser", {
      skillIds: ["browser"],
    });
  }

  if (
    (intentDecision.needs.fileManagement || intentDecision.needs.systemInfo || intentDecision.needs.cameraCapture)
    && !attached.has("bash")
  ) {
    return buildCapabilityRecoveryRequest("user_intent:bash", {
      skillIds: [
        intentDecision.needs.fileManagement ? "file-manager" : null,
        intentDecision.needs.systemInfo ? "system-info" : null,
        intentDecision.needs.cameraCapture ? "selfie" : null,
      ].filter((skillId): skillId is string => Boolean(skillId)),
      toolNames: ["bash"],
    });
  }

  return null;
}

export function looksLikeCapabilitySeekingReply(text: string) {
  return /我需要先(?:查看|查询|看看|搜索)|让我先(?:查看|查询|看看|搜索)|可用的 skill|需要通过 skill 路由|不是直接挂载的基座工具|工具集|没加载|未挂载|unavailable|not available/u.test(text);
}

export function buildCapabilityFailureReply(
  userMessage: string | null,
  attachedToolNames: string[],
) {
  const intentDecision = userMessage ? buildTurnIntentDecision(userMessage) : null;

  if (intentDecision?.needs.toolDiscovery) {
    return "我这轮还没真正去查当前可用的工具或 skills，所以先不假装已经列出来。你可以继续让我直接走工具发现链路。";
  }

  if (intentDecision && (intentDecision.needs.webResearch || intentDecision.needs.webFetch || intentDecision.needs.deepResearchFetch)) {
    return "我这轮还没真正执行到搜索或网页读取，所以不能假装已经查过。你可以给我一个具体链接，我继续直接读；或者我下一轮继续按搜索链路重试。";
  }

  if (intentDecision?.needs.browserAutomation) {
    return "我这轮还没真正打开或操作页面，所以现在给不出可靠结果。你可以给我目标页面或账号链接，我下一轮直接走浏览器链路。";
  }

  if (attachedToolNames.includes("bash")) {
    return "我这轮还没真正执行到需要的命令，所以先不假装已经做完。你可以继续让我重试，或者把目标路径和操作说得更具体一点。";
  }

  return "我这轮还没真正执行到需要的能力，所以先不假装已经完成。你可以继续让我重试，或者给我更具体的链接、页面或路径。";
}

export function inferCapabilityRecoveryRequest(
  userMessage: string | null,
  assistantText: string,
  attachedToolNames: string[],
  resolvedToolCallCount: number,
): CapabilityRecoveryRequest | null {
  if (resolvedToolCallCount > 0) {
    return null;
  }

  const attached = new Set(attachedToolNames);
  const repairedToolCall = repairTextToolCall(assistantText);
  if (
    repairedToolCall
    && isRecoverableToolName(repairedToolCall.toolName)
    && !attached.has(repairedToolCall.toolName)
  ) {
    return buildCapabilityRecoveryRequest(`missing_tool:${repairedToolCall.toolName}`, {
      skillIds: inferStickySkillsForToolName(repairedToolCall.toolName),
      toolNames: [repairedToolCall.toolName],
    });
  }

  const referencedToolName = extractReferencedToolNameFromAssistantText(assistantText);
  if (
    referencedToolName
    && isRecoverableToolName(referencedToolName)
    && !attached.has(referencedToolName)
    && /未挂载|没加载|不可用|unavailable|not available|skill 路由|通过 skill/u.test(assistantText)
  ) {
    return buildCapabilityRecoveryRequest(`referenced_missing_tool:${referencedToolName}`, {
      skillIds: inferStickySkillsForToolName(referencedToolName),
      toolNames: [referencedToolName],
    });
  }

  if (
    /我需要先(?:查看|查询|看看|搜索).*(?:skill|技能|工具)|让我先(?:查看|查询|看看|搜索).*(?:skill|技能|工具)|不是直接挂载的基座工具|需要通过 skill 路由|可用的 skill/u.test(assistantText)
  ) {
    const intentDrivenRecovery = inferIntentDrivenRecoveryRequest(userMessage, attachedToolNames);
    if (intentDrivenRecovery) {
      return intentDrivenRecovery;
    }

    return buildCapabilityRecoveryRequest("skill_discovery_needed", {
      toolNames: attached.has("tool_search") ? [] : ["tool_search"],
    });
  }

  return inferIntentDrivenRecoveryRequest(userMessage, attachedToolNames);
}

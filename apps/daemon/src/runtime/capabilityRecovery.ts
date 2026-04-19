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
  return toolName === "bash"
    || toolName === "web_search"
    || toolName === "web_fetch"
    || toolName.startsWith("browser_")
    || toolName.startsWith("chrome_relay_");
}

function inferStickySkillsForToolName(toolName: string) {
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
  const toolMatch = text.match(/\b(bash|web_search|web_fetch|browser_[a-z_]+|chrome_relay_[a-z_]+)\b/u);
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

  if (
    /https?:\/\/|查一下|搜一下|搜索|查查|最新|今天|今日|news|latest|today|发布了什么|发了什么|fact-check|research/iu.test(userMessage)
    && (!attached.has("web_search") || !attached.has("web_fetch"))
  ) {
    const missingToolNames = ["web_search", "web_fetch"].filter((toolName) => !attached.has(toolName));
    return buildCapabilityRecoveryRequest("user_intent:research", {
      skillIds: ["web-search", "web-fetch"],
      toolNames: missingToolNames,
    });
  }

  if (
    /浏览器|browser|网页|页面|网站|打开|登录|扫码|截图|click|tab|chrome|b站|bilibili|x\.com|twitter|小红书/iu.test(userMessage)
    && !attachedToolNames.some((toolName) => toolName.startsWith("browser_") || toolName.startsWith("chrome_relay_"))
  ) {
    return buildCapabilityRecoveryRequest("user_intent:browser", {
      skillIds: ["browser"],
    });
  }

  if (
    /文件|文件夹|目录|回收站|缓存|cache|trash|workspace|ls\b|du\b|find\b|rm\b/iu.test(userMessage)
    && !attached.has("bash")
  ) {
    return buildCapabilityRecoveryRequest("user_intent:bash", {
      skillIds: ["file-manager"],
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
  if (userMessage && /https?:\/\/|查一下|搜一下|搜索|查查|最新|今天|今日|news|latest|today|发布了什么|发了什么|fact-check|research/iu.test(userMessage)) {
    return "我这轮还没真正执行到搜索或网页读取，所以不能假装已经查过。你可以给我一个具体链接，我继续直接读；或者我下一轮继续按搜索链路重试。";
  }

  if (userMessage && /浏览器|browser|网页|页面|网站|打开|登录|扫码|截图|click|tab|chrome|b站|bilibili|x\.com|twitter|小红书/iu.test(userMessage)) {
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
    return buildCapabilityRecoveryRequest("skill_discovery_needed", {
      toolNames: attached.has("bash") ? [] : ["bash"],
    });
  }

  return inferIntentDrivenRecoveryRequest(userMessage, attachedToolNames);
}

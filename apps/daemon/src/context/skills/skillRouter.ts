import { generateText, Output } from "ai";
import { z } from "zod";
import type { SkillDefinition } from "@aliceloop/runtime-core";
import { createProviderModel } from "../../providers/providerModelFactory";
import { getToolModelConfig } from "../../providers/toolModelResolver";
import { expandRoutedSkillIds, getSkillGroupIdsForSkill, getSkillGroupLabel, type SkillRouteHints } from "./skillRouting";
import {
  listActiveSkillDefinitions,
  selectRelevantSkillIds,
} from "./skillLoader";

const fallbackSkillSelectionSchema = z.object({
  skillIds: z.array(z.string().trim().min(1).max(80)).max(8).default([]),
});

export interface SkillRoutingDecision {
  skills: SkillDefinition[];
  ruleSkillIds: string[];
  fallbackSkillIds: string[];
  routeSource: "rules" | "rules+llm";
}

export interface SkillRoutingFallbackResolverInput {
  query: string;
  routeHints?: SkillRouteHints;
  ruleSkillIds: string[];
  activeSkills: SkillDefinition[];
  abortSignal?: AbortSignal;
}

export type SkillRoutingFallbackResolver = (input: SkillRoutingFallbackResolverInput) => Promise<string[]>;

export interface ResolveRelevantSkillRoutingOptions {
  abortSignal?: AbortSignal;
  fallbackResolver?: SkillRoutingFallbackResolver;
}

function buildSkillCatalogLine(skill: SkillDefinition) {
  const groupLabels = getSkillGroupIdsForSkill(skill.id)
    .map((groupId) => getSkillGroupLabel(groupId));
  const groupSuffix = groupLabels.length > 0 ? ` [${groupLabels.join(" / ")}]` : "";

  return `- ${skill.id}${skill.label !== skill.id ? ` (${skill.label})` : ""}${groupSuffix}: ${skill.description}`;
}

function buildRouteHintLines(routeHints?: SkillRouteHints) {
  if (!routeHints) {
    return [] as string[];
  }

  const lines: string[] = [];
  if (routeHints.stickySkillIds.length > 0) {
    lines.push(`Sticky skills: ${routeHints.stickySkillIds.join(", ")}`);
  }
  if (routeHints.stickyGroupIds.length > 0) {
    lines.push(`Sticky groups: ${routeHints.stickyGroupIds.map((groupId) => getSkillGroupLabel(groupId)).join(", ")}`);
  }
  if (routeHints.reasons.length > 0) {
    lines.push(`Routing hints: ${routeHints.reasons.join("; ")}`);
  }
  return lines;
}

function shouldAttemptFallback(query: string, ruleSkillIds: string[]) {
  if (ruleSkillIds.length > 0) {
    return false;
  }

  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return false;
  }

  if (/^(?:嗯+|哦+|啊+|哇+|好的+|谢谢+|感谢+|行+|可以+|对+|是的+|没错+|明白+|了解+|哈哈+|hello|hi|hey|在吗|你是谁|你就是|是什么|咋样|怎么样|普通回复)$/iu.test(normalizedQuery)) {
    return false;
  }

  const capabilityIntent = /(?:任务|计划|待办|排期|schedule|scheduler|cron|提醒|步骤|进度|blocker|blocked|长期工作|继续|接着|恢复|总结|摘要|复盘|回顾|本轮|这轮|临时偏好|session summary|rolling summary|recap|reflection|当前话题|话题摘要|记忆|memory|记住|忘掉|forget|偏好|事实|稳定|长期|profile|account|fact|线程|thread|会话|session|聊天记录|历史会话|之前的对话|上次对话|conversation history|episodic history|技能|skill|能力|工具|browser|网页|页面|网站|浏览器|代码|仓库|repo|project|项目|文件|修复|bug|报错|重构|实现|开发|build|测试|test|脚本修改|源码|查|搜|搜索|阅读|抓取|打开|登录|点击|截图|分析|处理|解决|搞定|安排|优化|整理|改一下|调整|验证|确认|解释|看看|帮我|请帮|调研|review|回怼|互动|发帖|评论|私信|关注|点赞|转发|音频|audio|视频|video|voice|语音|音乐|music|图片|image|发文件|send file)/iu;
  if (capabilityIntent.test(normalizedQuery)) {
    return true;
  }

  return false;
}

async function defaultFallbackResolver(input: SkillRoutingFallbackResolverInput) {
  const provider = getToolModelConfig();
  if (!provider?.apiKey) {
    return [] as string[];
  }

  const activeSkillIds = new Set(input.activeSkills.map((skill) => skill.id));
  const skillCatalog = input.activeSkills
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(buildSkillCatalogLine)
    .join("\n");

  try {
    const response = await generateText({
      model: createProviderModel(provider),
      abortSignal: input.abortSignal,
      temperature: 0,
      output: Output.object({
        schema: fallbackSkillSelectionSchema,
        name: "skill_router_fallback",
        description: "Select additional installed skills that should be attached for the current turn.",
      }),
      prompt: [
        "You are the fallback skill router for Aliceloop.",
        "The rule-based router has already selected the baseline skills for this turn.",
        "Your job is to add only the missing installed skills whose workflow guidance is still needed.",
        "Prefer execution skills over catalog/discovery skills.",
        "Only choose from the provided installed skill ids.",
        "If the rule-selected skills already cover the turn, return an empty array.",
        "Return JSON only.",
        "",
        `Current query: ${input.query}`,
        input.ruleSkillIds.length > 0
          ? `Rule-selected skills: ${input.ruleSkillIds.join(", ")}`
          : "Rule-selected skills: (none)",
        ...buildRouteHintLines(input.routeHints),
        "",
        "Installed skill catalog:",
        skillCatalog,
      ].join("\n"),
    });

    return response.output.skillIds
      .map((skillId) => skillId.trim())
      .filter((skillId) => activeSkillIds.has(skillId))
      .filter((skillId, index, items) => items.indexOf(skillId) === index)
      .filter((skillId) => !input.ruleSkillIds.includes(skillId));
  } catch {
    return [] as string[];
  }
}

export async function resolveRelevantSkillRouting(
  query: string | null | undefined,
  hints?: SkillRouteHints,
  options?: ResolveRelevantSkillRoutingOptions,
): Promise<SkillRoutingDecision> {
  const normalizedQuery = query?.trim() ?? "";
  const activeSkills = listActiveSkillDefinitions();
  if (
    !normalizedQuery
    && (hints?.stickySkillIds.length ?? 0) === 0
    && (hints?.stickyGroupIds.length ?? 0) === 0
  ) {
    return {
      skills: [],
      ruleSkillIds: [],
      fallbackSkillIds: [],
      routeSource: "rules",
    };
  }

  const ruleSkillIds = selectRelevantSkillIds(normalizedQuery, hints);
  const fallbackResolver = options?.fallbackResolver ?? defaultFallbackResolver;
  let fallbackSkillIds: string[] = [];

  if (shouldAttemptFallback(normalizedQuery, ruleSkillIds)) {
    try {
      const resolvedFallbackSkillIds = await fallbackResolver({
        query: normalizedQuery,
        routeHints: hints,
        ruleSkillIds,
        activeSkills,
        abortSignal: options?.abortSignal,
      });
      fallbackSkillIds = Array.isArray(resolvedFallbackSkillIds)
        ? resolvedFallbackSkillIds.map((skillId) => skillId.trim()).filter(Boolean)
        : [];
    } catch {
      fallbackSkillIds = [];
    }
  }

  const routedSkillIds = expandRoutedSkillIds(
    [...new Set([...ruleSkillIds, ...fallbackSkillIds])],
    normalizedQuery,
    hints,
  ).routedSkillIds;
  const routedSkillIdSet = new Set(routedSkillIds);
  const skills = activeSkills.filter((skill) => routedSkillIdSet.has(skill.id));

  return {
    skills,
    ruleSkillIds,
    fallbackSkillIds,
    routeSource: fallbackSkillIds.length > 0 ? "rules+llm" : "rules",
  };
}

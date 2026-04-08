export interface StructuredPlanDraft {
  title: string;
  planId: string | null;
  status: string | null;
  bodyContent: string;
}

const proposedPlanOpenTagRegex = /^\s*<proposed_plan>\s*/i;
const proposedPlanCloseTagRegex = /\s*<\/proposed_plan>\s*$/i;
const markdownTitleRegex = /^\s*#{1,3}\s+(.+?)\s*$/m;
const planSectionHeadingRegex = /^(?:#{2,3}\s+)?(?:Summary|Key Changes|Test Plan|Assumptions|摘要|关键改动|测试计划|前提假设|技术栈|核心模块|文件结构|开发步骤|交互方式|功能范围|动画状态|第一阶段交付|交付内容|实施步骤|里程碑)\s*$/im;
const structuredLabelLineRegex = /^\s*(?:[-*•]|\d+[.)、])?\s*[A-Za-z0-9\u4E00-\u9FFF _./+-]{2,24}\s*[：:]\s*\S.+$/u;
const planIdRegex = /\*\*计划 ID:\*\*\s*`?([a-z0-9-]{8,})`?/i;
const statusRegex = /\*\*状态:\*\*\s*([^\n]+)/i;

function stripProposedPlanTags(content: string) {
  return content
    .replace(proposedPlanOpenTagRegex, "")
    .replace(proposedPlanCloseTagRegex, "")
    .trim();
}

function extractFallbackTitle(bodyContent: string) {
  const firstLine = bodyContent
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ?? null;
}

function normalizeFallbackTitle(title: string | null) {
  if (!title) {
    return null;
  }

  const normalized = title
    .replace(/[：:]\s*$/u, "")
    .replace(/\s+/gu, " ")
    .trim();

  return normalized || null;
}

export function extractStructuredPlanDraft(content: string): StructuredPlanDraft | null {
  const hasProposedPlanTag = proposedPlanOpenTagRegex.test(content) || proposedPlanCloseTagRegex.test(content);
  const normalized = stripProposedPlanTags(content);
  if (!normalized) {
    return null;
  }

  const titleMatch = normalized.match(markdownTitleRegex);
  const hasStructuredSections = planSectionHeadingRegex.test(normalized);
  const structuredLabelLineCount = normalized
    .split(/\r?\n/u)
    .filter((line) => structuredLabelLineRegex.test(line))
    .length;
  const planIdMatch = normalized.match(planIdRegex);
  const statusMatch = normalized.match(statusRegex);
  const hasStructuredPlanSignals = hasProposedPlanTag
    || hasStructuredSections
    || structuredLabelLineCount >= 2
    || Boolean(planIdMatch)
    || Boolean(statusMatch);
  const fallbackTitle = normalizeFallbackTitle(extractFallbackTitle(normalized));
  const title = titleMatch?.[1]?.trim() ?? (hasStructuredPlanSignals ? fallbackTitle : null);

  if (!title) {
    return null;
  }

  if (!hasStructuredPlanSignals) {
    return null;
  }

  let bodyContent = normalized;
  if (titleMatch) {
    bodyContent = normalized.replace(/^\s*#{1,3}\s+.+?\s*(?:\r?\n)+/u, "").trim();
  } else if (fallbackTitle) {
    const lines = normalized.split(/\r?\n/u);
    const firstNonEmptyIndex = lines.findIndex((line) => line.trim().length > 0);
    if (firstNonEmptyIndex >= 0) {
      bodyContent = lines.slice(firstNonEmptyIndex + 1).join("\n").trim();
    }
  }

  return {
    title,
    planId: planIdMatch?.[1]?.trim() ?? null,
    status: statusMatch?.[1]?.trim() ?? null,
    bodyContent,
  };
}

export function isStructuredPlanDraft(content: string) {
  return extractStructuredPlanDraft(content) !== null;
}

import type { SessionThreadSummary } from "@aliceloop/runtime-core";
import {
  getSessionProjectBinding,
  listHistoricalSessionCandidates,
  listSessionConversationMessages,
  type SessionConversationMessage,
} from "../../repositories/sessionRepository";
import { nowMs, roundMs } from "../../runtime/perfTrace";

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const HISTORY_CANDIDATE_LIMIT = parsePositiveInt(process.env.ALICELOOP_HISTORY_CANDIDATE_LIMIT, 40);
const HISTORY_SESSION_LIMIT = parsePositiveInt(process.env.ALICELOOP_HISTORY_SESSION_LIMIT, 2);
const HISTORY_SUMMARY_MESSAGE_LIMIT = parsePositiveInt(process.env.ALICELOOP_HISTORY_SUMMARY_MESSAGE_LIMIT, 4);
const HISTORY_FULL_CONTEXT_MESSAGE_LIMIT = parsePositiveInt(process.env.ALICELOOP_HISTORY_FULL_CONTEXT_MESSAGE_LIMIT, 10);
const HISTORY_SUMMARY_CHAR_BUDGET = parsePositiveInt(process.env.ALICELOOP_HISTORY_SUMMARY_CHAR_BUDGET, 2200);
const HISTORY_FULL_CONTEXT_CHAR_BUDGET = parsePositiveInt(process.env.ALICELOOP_HISTORY_FULL_CONTEXT_CHAR_BUDGET, 4200);

const historyIntentPattern =
  /上次|之前|那次|那天|历史|会话|聊天记录|我们聊过|你还记得|还记得吗|以前说过|之前说过|full\s*context|完整上下文|完整会话|历史原文|原话/iu;
const projectHistoryIntentPattern =
  /这个项目|这项目|这个工程|这个仓库|这个\s*repo|刚才那个项目|之前那个项目|我们定的|之前怎么定的|前面怎么定的/iu;
const fullContextIntentPattern =
  /full\s*context|完整上下文|完整会话|历史原文|原话|完整历史|全部聊天|全部会话|完整记录/iu;

const historyStopWords = new Set([
  "上次",
  "之前",
  "那次",
  "那天",
  "记得",
  "还记得",
  "会话",
  "历史",
  "聊天",
  "我们",
  "这个",
  "那个",
  "刚才",
  "之前说过",
  "聊过",
  "说过",
  "什么",
  "怎么",
  "一下",
  "full",
  "context",
]);

export interface HistoricalContextBlockResult {
  content: string;
  timings: Record<string, number | string | boolean | null>;
}

interface RankedHistoryCandidate {
  candidate: SessionThreadSummary;
  score: number;
  reasons: string[];
}

interface LoadedHistoryCandidate extends RankedHistoryCandidate {
  messages: SessionConversationMessage[];
  messageScore: number;
}

function hasExplicitHistoryIntent(queryText: string) {
  return historyIntentPattern.test(queryText);
}

function hasProjectHistoryIntent(queryText: string) {
  return projectHistoryIntentPattern.test(queryText);
}

function wantsFullHistoryContext(queryText: string) {
  return fullContextIntentPattern.test(queryText);
}

function normalizeText(input: string | null | undefined) {
  return (input ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function collectHanTerms(sequence: string, terms: Set<string>) {
  if (sequence.length <= 6) {
    if (!historyStopWords.has(sequence)) {
      terms.add(sequence);
    }
    return;
  }

  for (let size = 4; size >= 2; size -= 1) {
    for (let index = 0; index <= sequence.length - size; index += 1) {
      if (terms.size >= 16) {
        return;
      }

      const token = sequence.slice(index, index + size);
      if (!historyStopWords.has(token)) {
        terms.add(token);
      }
    }
  }
}

function extractHistoryTerms(queryText: string) {
  const stripped = queryText
    .toLowerCase()
    .replace(historyIntentPattern, " ")
    .replace(projectHistoryIntentPattern, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ");

  const terms = new Set<string>();
  const asciiTerms = stripped.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [];
  for (const term of asciiTerms) {
    if (!historyStopWords.has(term)) {
      terms.add(term);
    }
  }

  const hanSequences = stripped.match(/[\p{Script=Han}]{2,}/gu) ?? [];
  for (const sequence of hanSequences) {
    collectHanTerms(sequence, terms);
    if (terms.size >= 16) {
      break;
    }
  }

  return [...terms].slice(0, 16);
}

function scoreTextMatch(text: string | null | undefined, rawQuery: string, terms: string[]) {
  const haystack = normalizeText(text);
  if (!haystack) {
    return 0;
  }

  let score = 0;
  const normalizedRawQuery = normalizeText(rawQuery);
  if (normalizedRawQuery.length >= 2 && haystack.includes(normalizedRawQuery)) {
    score += 6;
  }

  for (const term of terms) {
    if (term.length >= 2 && haystack.includes(term)) {
      score += Math.min(4, term.length);
    }
  }

  return score;
}

function scoreRecency(updatedAt: string) {
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return 0;
  }

  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  if (ageDays <= 1) return 3;
  if (ageDays <= 7) return 2;
  if (ageDays <= 30) return 1;
  return 0;
}

function formatConversationTimestamp(timestamp: string) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function trimMessageContent(content: string, maxChars: number) {
  const normalized = content.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars).trimEnd()}…`;
}

function scoreMessage(message: SessionConversationMessage, rawQuery: string, terms: string[], index: number) {
  const textScore = scoreTextMatch(message.content, rawQuery, terms);
  if (textScore <= 0) {
    return 0;
  }

  const roleScore = message.role === "user" ? 1 : 0.5;
  const recencyScore = index / 10;
  return textScore + roleScore + recencyScore;
}

function selectMessageIndexes(
  messages: SessionConversationMessage[],
  rawQuery: string,
  terms: string[],
  fullContext: boolean,
) {
  if (messages.length === 0) {
    return [] as number[];
  }

  const scored = messages
    .map((message, index) => ({
      index,
      score: scoreMessage(message, rawQuery, terms, index),
    }))
    .sort((left, right) => right.score - left.score);

  const matched = scored[0] && scored[0].score > 0 ? scored[0] : null;
  const windowRadius = fullContext ? 4 : 1;
  const fallbackCount = fullContext ? HISTORY_FULL_CONTEXT_MESSAGE_LIMIT : HISTORY_SUMMARY_MESSAGE_LIMIT;

  if (!matched) {
    return messages
      .slice(-fallbackCount)
      .map((_, index) => messages.length - fallbackCount + index)
      .filter((index) => index >= 0);
  }

  const start = Math.max(0, matched.index - windowRadius);
  const end = Math.min(messages.length - 1, matched.index + windowRadius);
  const indexes = new Set<number>();
  for (let index = start; index <= end; index += 1) {
    indexes.add(index);
  }

  if (fullContext && indexes.size < fallbackCount) {
    for (let index = Math.max(0, messages.length - fallbackCount); index < messages.length; index += 1) {
      indexes.add(index);
    }
  }

  return [...indexes].sort((left, right) => left - right);
}

function rankHistoryCandidates(
  candidates: SessionThreadSummary[],
  rawQuery: string,
  terms: string[],
  currentProjectId: string | null,
  explicitHistoryIntent: boolean,
) {
  return candidates
    .map((candidate) => {
      const reasons: string[] = [];
      let score = 0;

      if (currentProjectId && candidate.projectId === currentProjectId) {
        score += explicitHistoryIntent ? 12 : 6;
        reasons.push("same_project");
      }

      const titleScore = scoreTextMatch(candidate.title, rawQuery, terms);
      if (titleScore > 0) {
        score += titleScore * 1.5;
        reasons.push("title_match");
      }

      const projectScore = scoreTextMatch(candidate.projectName ?? "", rawQuery, terms);
      if (projectScore > 0) {
        score += projectScore;
        reasons.push("project_match");
      }

      const previewScore = scoreTextMatch(candidate.latestMessagePreview, rawQuery, terms);
      if (previewScore > 0) {
        score += previewScore * 0.75;
        reasons.push("preview_match");
      }

      const recencyScore = scoreRecency(candidate.updatedAt);
      if (recencyScore > 0) {
        score += recencyScore;
        reasons.push("recent");
      }

      if (explicitHistoryIntent && reasons.length === 1 && reasons[0] === "recent") {
        score += 1;
      }

      return {
        candidate,
        score,
        reasons: [...new Set(reasons)],
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || right.candidate.updatedAt.localeCompare(left.candidate.updatedAt));
}

function buildHistorySection(
  entry: RankedHistoryCandidate,
  messages: SessionConversationMessage[],
  fullContext: boolean,
  rawQuery: string,
  terms: string[],
) {
  const messageIndexes = selectMessageIndexes(messages, rawQuery, terms, fullContext);
  const excerptMessages = messageIndexes.map((index) => messages[index]).filter(Boolean);
  if (excerptMessages.length === 0) {
    return "";
  }

  const lines = [
    `### ${entry.candidate.title}`,
    `- sessionId: ${entry.candidate.id}`,
    `- updatedAt: ${formatConversationTimestamp(entry.candidate.updatedAt)}`,
    `- messageCount: ${entry.candidate.messageCount}`,
    `- route: ${entry.reasons.join(", ") || "recent"}`,
    "",
    fullContext ? "#### Routed Transcript" : "#### Routed Excerpt",
    "",
  ];

  const perMessageLimit = fullContext ? 320 : 180;
  for (const message of excerptMessages) {
    lines.push(
      `${message.role === "user" ? "User" : "Assistant"} (${formatConversationTimestamp(message.createdAt)}): ${
        trimMessageContent(message.content, perMessageLimit)
      }`,
    );
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function computeCandidateMessageScore(
  messages: SessionConversationMessage[],
  rawQuery: string,
  terms: string[],
) {
  const scoredMessages = messages
    .map((message, index) => scoreMessage(message, rawQuery, terms, index))
    .filter((score) => score > 0)
    .sort((left, right) => right - left);

  if (scoredMessages.length === 0) {
    return 0;
  }

  return scoredMessages.slice(0, 3).reduce((sum, score) => sum + score, 0);
}

export function buildHistoricalContextBlock(
  sessionId: string,
  userQuery?: string,
): HistoricalContextBlockResult {
  const startedAt = nowMs();
  const timings: Record<string, number | string | boolean | null> = {};
  const trimmedQuery = userQuery?.trim();

  if (!trimmedQuery) {
    timings.skipReason = "no_query";
    timings.totalMs = roundMs(nowMs() - startedAt);
    return {
      content: "",
      timings,
    };
  }

  const explicitHistoryIntent = hasExplicitHistoryIntent(trimmedQuery);
  const fullContext = wantsFullHistoryContext(trimmedQuery);
  const projectHistoryIntent = hasProjectHistoryIntent(trimmedQuery);

  timings.explicitHistoryIntent = explicitHistoryIntent;
  timings.fullContext = fullContext;
  timings.projectHistoryIntent = projectHistoryIntent;

  if (!explicitHistoryIntent && !projectHistoryIntent && !fullContext) {
    timings.skipReason = "history_not_requested";
    timings.totalMs = roundMs(nowMs() - startedAt);
    return {
      content: "",
      timings,
    };
  }

  const bindingStartedAt = nowMs();
  const currentProject = getSessionProjectBinding(sessionId);
  timings.bindingLookupMs = roundMs(nowMs() - bindingStartedAt);

  const candidateStartedAt = nowMs();
  const candidates = listHistoricalSessionCandidates(sessionId, {
    projectId: currentProject?.projectId ?? null,
    limit: HISTORY_CANDIDATE_LIMIT,
  });
  timings.candidateLookupMs = roundMs(nowMs() - candidateStartedAt);
  timings.candidateCount = candidates.length;

  const terms = extractHistoryTerms(trimmedQuery);
  timings.termCount = terms.length;

  const rankingStartedAt = nowMs();
  const rankedCandidates = rankHistoryCandidates(
    candidates,
    trimmedQuery,
    terms,
    currentProject?.projectId ?? null,
    explicitHistoryIntent || projectHistoryIntent,
  ).slice(0, HISTORY_SESSION_LIMIT * 3);
  timings.rankingMs = roundMs(nowMs() - rankingStartedAt);
  timings.rankedCount = rankedCandidates.length;

  if (rankedCandidates.length === 0) {
    timings.skipReason = "no_history_match";
    timings.totalMs = roundMs(nowMs() - startedAt);
    return {
      content: "",
      timings,
    };
  }

  const messageLookupStartedAt = nowMs();
  const loadedCandidates: LoadedHistoryCandidate[] = rankedCandidates
    .slice(0, Math.max(HISTORY_SESSION_LIMIT * 4, 8))
    .map((entry) => {
      const messages = listSessionConversationMessages(
        entry.candidate.id,
        fullContext ? HISTORY_FULL_CONTEXT_MESSAGE_LIMIT + 8 : HISTORY_SUMMARY_MESSAGE_LIMIT + 6,
      );
      const messageScore = computeCandidateMessageScore(messages, trimmedQuery, terms);
      return {
        ...entry,
        score: entry.score + messageScore * 2,
        reasons: messageScore > 0 ? [...new Set([...entry.reasons, "message_match"])] : entry.reasons,
        messages,
        messageScore,
      };
    })
    .sort((left, right) => right.score - left.score || right.candidate.updatedAt.localeCompare(left.candidate.updatedAt));
  timings.messageLookupMs = roundMs(nowMs() - messageLookupStartedAt);
  timings.loadedCandidateCount = loadedCandidates.length;

  const sectionBudget = fullContext ? HISTORY_FULL_CONTEXT_CHAR_BUDGET : HISTORY_SUMMARY_CHAR_BUDGET;
  const sectionBlocks: string[] = [];
  const selectedSessionIds: string[] = [];
  let usedChars = 0;

  for (const entry of loadedCandidates) {
    if (selectedSessionIds.length >= HISTORY_SESSION_LIMIT || usedChars >= sectionBudget) {
      break;
    }

    const block = buildHistorySection(entry, entry.messages, fullContext, trimmedQuery, terms);
    if (!block) {
      continue;
    }

    if (usedChars > 0 && usedChars + block.length > sectionBudget) {
      continue;
    }

    sectionBlocks.push(block);
    selectedSessionIds.push(entry.candidate.id);
    usedChars += block.length;
  }
  timings.selectedSessionCount = selectedSessionIds.length;
  timings.selectedSessionIds = selectedSessionIds.join(",");
  timings.historyChars = usedChars;

  if (sectionBlocks.length === 0) {
    timings.skipReason = "history_budget_exhausted";
    timings.totalMs = roundMs(nowMs() - startedAt);
    return {
      content: "",
      timings,
    };
  }

  timings.totalMs = roundMs(nowMs() - startedAt);

  return {
    content: [
      "## Episodic History",
      "以下内容来自按会话路由命中的历史对话，仅作历史参考；如果和用户这一轮的新要求冲突，以这一轮为准。",
      "",
      ...sectionBlocks,
    ].join("\n"),
    timings,
  };
}

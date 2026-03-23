import { nowMs, roundMs } from "../../runtime/perfTrace";

const historyIntentPattern =
  /上次|之前|那次|那天|历史|会话|聊天记录|我们聊过|你还记得|还记得吗|以前说过|之前说过|full\s*context|完整上下文|完整会话|历史原文|原话/iu;
const projectHistoryIntentPattern =
  /这个项目|这项目|这个工程|这个仓库|这个\s*repo|刚才那个项目|之前那个项目|我们定的|之前怎么定的|前面怎么定的/iu;
const fullContextIntentPattern =
  /full\s*context|完整上下文|完整会话|历史原文|原话|完整历史|全部聊天|全部会话|完整记录/iu;
const explicitMemoryIntentPattern =
  /remember|memory|preference|constraint|note|long[- ]?term|记住|记得|偏好|约束|长期记忆/iu;
const durableRecallIntentPattern =
  /偏好|约束|决定|工作流|默认|风格|语气|策略|方案|总结|记忆链路|怎么定的|之前定的|当前工作集|最近决定|长期/iu;

export interface MemoryRoutePlan {
  query: string | null;
  useSummaryMemory: boolean;
  useSessionArchive: boolean;
  sessionArchiveMode: "off" | "excerpt" | "full";
  useAtomicMemory: boolean;
  atomicRecallMode: "off" | "async";
  reasons: string[];
  timings: Record<string, number | string | boolean | null>;
}

function hasExplicitHistoryIntent(queryText: string) {
  return historyIntentPattern.test(queryText);
}

function hasProjectHistoryIntent(queryText: string) {
  return projectHistoryIntentPattern.test(queryText);
}

function wantsFullContext(queryText: string) {
  return fullContextIntentPattern.test(queryText);
}

function hasExplicitMemoryIntent(queryText: string) {
  return explicitMemoryIntentPattern.test(queryText);
}

function hasDurableRecallIntent(queryText: string) {
  return durableRecallIntentPattern.test(queryText);
}

export function planMemoryRoute(userQuery?: string | null): MemoryRoutePlan {
  const startedAt = nowMs();
  const trimmedQuery = userQuery?.trim() || "";
  const reasons: string[] = [];
  const timings: Record<string, number | string | boolean | null> = {};

  if (!trimmedQuery) {
    timings.skipReason = "no_query";
    timings.totalMs = roundMs(nowMs() - startedAt);
    return {
      query: null,
      useSummaryMemory: true,
      useSessionArchive: false,
      sessionArchiveMode: "off",
      useAtomicMemory: false,
      atomicRecallMode: "off",
      reasons: ["summary_only"],
      timings,
    };
  }

  const explicitHistoryIntent = hasExplicitHistoryIntent(trimmedQuery);
  const projectHistoryIntent = hasProjectHistoryIntent(trimmedQuery);
  const fullContextIntent = wantsFullContext(trimmedQuery);
  const explicitMemoryIntent = hasExplicitMemoryIntent(trimmedQuery);
  const durableRecallIntent = hasDurableRecallIntent(trimmedQuery);

  if (explicitHistoryIntent) reasons.push("explicit_history_intent");
  if (projectHistoryIntent) reasons.push("project_history_intent");
  if (fullContextIntent) reasons.push("full_context_intent");
  if (explicitMemoryIntent) reasons.push("explicit_memory_intent");
  if (durableRecallIntent) reasons.push("durable_recall_intent");

  const useSessionArchive = explicitHistoryIntent || projectHistoryIntent || fullContextIntent;
  const useAtomicMemory = explicitMemoryIntent || durableRecallIntent || fullContextIntent;
  const sessionArchiveMode = useSessionArchive
    ? (fullContextIntent ? "full" : "excerpt")
    : "off";

  if (!useSessionArchive && !useAtomicMemory) {
    reasons.push("summary_only");
  }

  timings.explicitHistoryIntent = explicitHistoryIntent;
  timings.projectHistoryIntent = projectHistoryIntent;
  timings.fullContextIntent = fullContextIntent;
  timings.explicitMemoryIntent = explicitMemoryIntent;
  timings.durableRecallIntent = durableRecallIntent;
  timings.totalMs = roundMs(nowMs() - startedAt);

  return {
    query: trimmedQuery,
    useSummaryMemory: true,
    useSessionArchive,
    sessionArchiveMode,
    useAtomicMemory,
    atomicRecallMode: useAtomicMemory ? "async" : "off",
    reasons,
    timings,
  };
}

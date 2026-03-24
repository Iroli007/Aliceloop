import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

function round(value: number) {
  return Math.round(value * 10) / 10;
}

function stats(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const sum = values.reduce((total, value) => total + value, 0);
  const avg = values.length > 0 ? sum / values.length : 0;
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;

  return {
    count: values.length,
    minMs: round(sorted[0] ?? 0),
    medianMs: round(median),
    avgMs: round(avg),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
  };
}

function metricStats(values: Array<number | null | undefined>) {
  const numbers = values.filter((value): value is number => typeof value === "number");
  return stats(numbers);
}

async function measureLoadContext(
  loadContext: (sessionId: string, abortSignal: AbortSignal) => Promise<{ timings: Record<string, number | string | null> }>,
  sessionId: string,
) {
  const controller = new AbortController();
  const startedAt = performance.now();
  const context = await loadContext(sessionId, controller.signal);
  return {
    wallMs: round(performance.now() - startedAt),
    timings: context.timings,
  };
}

async function runScenarioBenchmark(input: {
  name: string;
  sessionId: string;
  loadContext: (sessionId: string, abortSignal: AbortSignal) => Promise<{ timings: Record<string, number | string | null> }>;
  resetCaches: () => void;
  warmRuns?: number;
}) {
  input.resetCaches();
  const coldRun = await measureLoadContext(input.loadContext, input.sessionId);
  const warmRuns = input.warmRuns ?? 5;
  const warmResults = [];

  for (let index = 0; index < warmRuns; index += 1) {
    warmResults.push(await measureLoadContext(input.loadContext, input.sessionId));
  }

  return {
    cold: {
      wallMs: coldRun.wallMs,
      totalMs: coldRun.timings.totalMs,
      sessionContextMs: coldRun.timings.sessionContextMs,
      skillsMs: coldRun.timings.skillsMs,
      toolsMs: coldRun.timings.toolsMs,
      runtimeSettingsMs: coldRun.timings.runtimeSettingsMs,
      sandboxMs: coldRun.timings.sandboxMs,
    },
    warm: {
      wallMs: stats(warmResults.map((result) => result.wallMs)),
      totalMs: metricStats(warmResults.map((result) => result.timings.totalMs as number | null | undefined)),
      sessionContextMs: metricStats(warmResults.map((result) => result.timings.sessionContextMs as number | null | undefined)),
      skillsMs: metricStats(warmResults.map((result) => result.timings.skillsMs as number | null | undefined)),
      toolsMs: metricStats(warmResults.map((result) => result.timings.toolsMs as number | null | undefined)),
      runtimeSettingsMs: metricStats(warmResults.map((result) => result.timings.runtimeSettingsMs as number | null | undefined)),
      sandboxMs: metricStats(warmResults.map((result) => result.timings.sandboxMs as number | null | undefined)),
    },
  };
}

async function main() {
  const tempDataDir = mkdtempSync(join(tmpdir(), "aliceloop-load-context-bench-"));
  process.env.ALICELOOP_DATA_DIR = tempDataDir;
  process.env.ALICELOOP_TRACE_TIMINGS = "0";

  const [
    { loadContext },
    { createSession, createSessionMessage, appendSessionEvent },
    { clearSessionSkillCache },
    { resetSkillCatalogCache },
    { resetSkillToolCache },
    { resetRuntimeSettingsCache },
  ] = await Promise.all([
    import("../src/context/index.ts"),
    import("../src/repositories/sessionRepository.ts"),
    import("../src/context/skills/sessionSkillCache.ts"),
    import("../src/context/skills/skillLoader.ts"),
    import("../src/context/tools/skillToolFactories.ts"),
    import("../src/repositories/runtimeSettingsRepository.ts"),
  ]);

  const resetCaches = () => {
    resetSkillCatalogCache();
    resetSkillToolCache();
    resetRuntimeSettingsCache();
  };

  const genericSession = createSession("loadContext benchmark generic");
  clearSessionSkillCache(genericSession.id);
  createSessionMessage({
    sessionId: genericSession.id,
    clientMessageId: "bench-generic-user-1",
    deviceId: "desktop-bench",
    role: "user",
    content: "普通聊聊今天的安排。",
    attachmentIds: [],
  });

  const researchSession = createSession("loadContext benchmark research");
  clearSessionSkillCache(researchSession.id);
  createSessionMessage({
    sessionId: researchSession.id,
    clientMessageId: "bench-research-user-1",
    deviceId: "desktop-bench",
    role: "user",
    content: "帮我查一下东莞今天天气，给我最新结果。",
    attachmentIds: [],
  });

  const continuationSession = createSession("loadContext benchmark continuation");
  clearSessionSkillCache(continuationSession.id);
  createSessionMessage({
    sessionId: continuationSession.id,
    clientMessageId: "bench-continuation-user-1",
    deviceId: "desktop-bench",
    role: "user",
    content: "帮我调查摩的司机徐师傅，站粉丝数量搞错了。",
    attachmentIds: [],
  });
  createSessionMessage({
    sessionId: continuationSession.id,
    clientMessageId: "bench-continuation-assistant-1",
    deviceId: "desktop-bench",
    role: "assistant",
    content: "我先按 B 站和时间点继续查。",
    attachmentIds: [],
  });
  createSessionMessage({
    sessionId: continuationSession.id,
    clientMessageId: "bench-continuation-user-2",
    deviceId: "desktop-bench",
    role: "user",
    content: "你查",
    attachmentIds: [],
  });
  appendSessionEvent(continuationSession.id, "tool.call.started", {
    toolCallId: "bench-continuation-search-1",
    toolName: "web_search",
    inputPreview: "{\"query\":\"摩的司机徐师傅 B站 3月22日\"}",
    backend: "desktop_chrome",
  });
  appendSessionEvent(continuationSession.id, "tool.call.completed", {
    toolCallId: "bench-continuation-search-1",
    toolName: "web_search",
    success: true,
    resultPreview: "{\"results\":[{\"url\":\"https://space.bilibili.com/3493117728656046\"}]}",
    durationMs: 122,
    backend: "desktop_chrome",
  });
  appendSessionEvent(continuationSession.id, "tool.call.started", {
    toolCallId: "bench-continuation-fetch-1",
    toolName: "web_fetch",
    inputPreview: "{\"url\":\"https://space.bilibili.com/3493117728656046\"}",
    backend: "desktop_chrome",
  });
  appendSessionEvent(continuationSession.id, "tool.call.completed", {
    toolCallId: "bench-continuation-fetch-1",
    toolName: "web_fetch",
    success: true,
    resultPreview: "B站主页，粉丝与视频列表实时展示。",
    durationMs: 84,
    backend: "desktop_chrome",
  });

  const scenarios = {
    generic: await runScenarioBenchmark({
      name: "generic",
      sessionId: genericSession.id,
      loadContext,
      resetCaches,
    }),
    research: await runScenarioBenchmark({
      name: "research",
      sessionId: researchSession.id,
      loadContext,
      resetCaches,
    }),
    continuation: await runScenarioBenchmark({
      name: "continuation",
      sessionId: continuationSession.id,
      loadContext,
      resetCaches,
    }),
  };

  assert.equal(scenarios.generic.cold.totalMs !== null, true);
  assert.equal(scenarios.research.cold.skillsMs !== null, true);
  assert.equal(scenarios.continuation.cold.sessionContextMs !== null, true);

  console.info(JSON.stringify({
    ok: true,
    tempDataDir,
    scenarios,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

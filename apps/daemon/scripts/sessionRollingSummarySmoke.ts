import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function flattenSystemPrompt(
  systemPrompt: string | Array<{ role: "system"; content: string }>,
) {
  return Array.isArray(systemPrompt)
    ? systemPrompt.map((message) => message.content).join("\n\n")
    : systemPrompt;
}

async function main() {
  const tempDataDir = mkdtempSync(join(tmpdir(), "aliceloop-session-summary-"));
  process.env.ALICELOOP_DATA_DIR = tempDataDir;

  try {
    const [
      { loadContext },
      { refreshSessionMemory },
      { updateRuntimeSettings },
      { appendSessionEvent, createSession, createSessionMessage, getSessionSnapshot, updateSessionFocusState },
    ] = await Promise.all([
      import("../src/context/index.ts"),
      import("../src/context/session/sessionMemory.ts"),
      import("../src/repositories/runtimeSettingsRepository.ts"),
      import("../src/repositories/sessionRepository.ts"),
    ]);

    updateRuntimeSettings({
      recentTurnsCount: 1,
    });

    const session = createSession("session rolling summary smoke");
    updateSessionFocusState(session.id, {
      goal: "把线程记忆和上下文压缩主链路收清楚。",
      priorities: ["别丢当前任务", "别把摘要当成新用户消息"],
      nextStep: "补清楚边界和压缩层次。",
    });

    createSessionMessage({
      sessionId: session.id,
      clientMessageId: "user-1",
      deviceId: "desktop",
      role: "user",
      content: "先把记忆系统拆成长期记忆和线程记忆两层。",
      attachmentIds: [],
    });
    createSessionMessage({
      sessionId: session.id,
      clientMessageId: "assistant-1",
      deviceId: "runtime-agent",
      role: "assistant",
      content: "已经先按长期记忆和线程记忆两层收口，并保留后续再细分的空间。",
      attachmentIds: [],
    });
    createSessionMessage({
      sessionId: session.id,
      clientMessageId: "user-2",
      deviceId: "desktop",
      role: "user",
      content: "再把没接进主链路的 memory_notes 摘掉。",
      attachmentIds: [],
    });
    createSessionMessage({
      sessionId: session.id,
      clientMessageId: "assistant-2",
      deviceId: "runtime-agent",
      role: "assistant",
      content: "memory_notes 相关入口已经从主链路摘掉，只剩线程记忆和 semantic memory。",
      attachmentIds: [],
    });
    createSessionMessage({
      sessionId: session.id,
      clientMessageId: "user-3",
      deviceId: "desktop",
      role: "user",
      content: "继续把 rolling summary 和 recent turns 也收一下。",
      attachmentIds: [],
    });
    appendSessionEvent(session.id, "tool.call.started", {
      toolCallId: "tool-call-web-fetch-old-1",
      toolName: "web_fetch",
      inputPreview: "https://example.com/older-tool-history",
      backend: "http",
    });
    appendSessionEvent(session.id, "tool.call.completed", {
      toolCallId: "tool-call-web-fetch-old-1",
      toolName: "web_fetch",
      success: true,
      resultPreview: Array.from({ length: 20 }, () => "Older tool history says the previous result was already verified and should not be repeated.").join(" "),
      durationMs: 36,
      backend: "http",
    });
    appendSessionEvent(session.id, "tool.call.started", {
      toolCallId: "tool-call-web-fetch-0",
      toolName: "web_fetch",
      inputPreview: "https://example.com/context-compaction-notes",
      backend: "http",
    });
    appendSessionEvent(session.id, "tool.call.completed", {
      toolCallId: "tool-call-web-fetch-0",
      toolName: "web_fetch",
      success: false,
      resultPreview: "Initial fetch timed out before returning the page body.",
      durationMs: 31,
      backend: "http",
    });
    appendSessionEvent(session.id, "tool.call.started", {
      toolCallId: "tool-call-web-fetch-1",
      toolName: "web_fetch",
      inputPreview: "https://example.com/context-compaction-notes",
      backend: "http",
    });
    appendSessionEvent(session.id, "tool.call.completed", {
      toolCallId: "tool-call-web-fetch-1",
      toolName: "web_fetch",
      success: true,
      resultPreview: "Context compaction notes mention boundary, session memory, and recent turns.",
      durationMs: 42,
      backend: "http",
    });

    const summary = await refreshSessionMemory(session.id);
    assert.equal(summary.rememberedTurnCount, 2);
    assert.match(summary.summary, /Archived 2 earlier turns|线程记忆|memory_notes/u);

    const snapshot = getSessionSnapshot(session.id);
    assert.equal(snapshot.sessionMemory.rememberedTurnCount, 2);

    const context = await loadContext(session.id, new AbortController().signal);
    const prompt = flattenSystemPrompt(context.systemPrompt);
    assert.match(prompt, /## Session Focus/u);
    assert.match(prompt, /把线程记忆和上下文压缩主链路收清楚/u);
    assert.match(prompt, /## Context Boundary/u);
    assert.match(prompt, /## Session Memory/u);
    assert.match(prompt, /## Tool Transcript/u);
    assert.match(prompt, /\[tool result micro-compacted\]/u);
    assert.match(prompt, /<tool_atom id="tool-call-web-fetch-1"/u);
    assert.match(prompt, /attempts="2"/u);
    assert.match(prompt, /<tool_use>https:\/\/example\.com\/context-compaction-notes/u);
    assert.match(prompt, /<tool_result>Context compaction notes mention boundary/u);
    assert.match(prompt, /Remembered turns covered: 2/u);
    assert.match(prompt, /Boundary source: rolling session memory/u);
    assert.ok((context.timings.promptProjectionStablePartCount as number) >= 2);
    assert.ok((context.timings.promptProjectionVolatilePartCount as number) >= 3);

    const messageTranscript = context.messages
      .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
      .join("\n");
    assert.match(messageTranscript, /继续把 rolling summary 和 recent turns 也收一下/u);
    assert.doesNotMatch(messageTranscript, /先把记忆系统拆成长期记忆和线程记忆两层/u);
    assert.doesNotMatch(messageTranscript, /再把没接进主链路的 memory_notes 摘掉/u);

    const compactedContext = await loadContext(session.id, new AbortController().signal, {
      compaction: {
        forceCheckpoint: true,
        keepRecentTurnsCount: 1,
      },
    });
    const compactedPrompt = flattenSystemPrompt(compactedContext.systemPrompt);
    assert.match(compactedPrompt, /## Session Focus/u);
    assert.match(compactedPrompt, /别把摘要当成新用户消息/u);
    assert.match(compactedPrompt, /## Context Boundary/u);
    assert.match(compactedPrompt, /## Context Checkpoint/u);
    assert.match(compactedPrompt, /Archived turns covered: 2/u);
    assert.match(compactedPrompt, /Boundary source: checkpoint summary/u);

    const compactedTranscript = compactedContext.messages
      .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
      .join("\n");
    assert.match(compactedTranscript, /继续把 rolling summary 和 recent turns 也收一下/u);
    assert.doesNotMatch(compactedTranscript, /先把记忆系统拆成长期记忆和线程记忆两层/u);

    createSessionMessage({
      sessionId: session.id,
      clientMessageId: "assistant-3",
      deviceId: "runtime-agent",
      role: "assistant",
      content: "已经把滚动摘要和 recent turns 分层，后面只差一条明确的边界提示。",
      attachmentIds: [],
    });
    createSessionMessage({
      sessionId: session.id,
      clientMessageId: "user-4",
      deviceId: "desktop",
      role: "user",
      content: "再补一条 context boundary，别让模型把摘要当成新的用户消息。",
      attachmentIds: [],
    });

    const incrementallyCompactedContext = await loadContext(session.id, new AbortController().signal, {
      compaction: {
        forceCheckpoint: true,
        keepRecentTurnsCount: 1,
      },
    });
    const incrementallyCompactedPrompt = flattenSystemPrompt(incrementallyCompactedContext.systemPrompt);
    assert.match(incrementallyCompactedPrompt, /Archived turns covered: 3/u);
    assert.equal(incrementallyCompactedContext.timings.compactionCheckpointIncremental, 1);

    const updatedSnapshot = getSessionSnapshot(session.id);
    assert.equal(updatedSnapshot.compactionState.compactedTurnCount, 3);
    assert.ok(updatedSnapshot.compactionState.lastCompactedMessageId);

    updateRuntimeSettings({
      recentTurnsCount: 3,
    });

    const microCompactSession = createSession("session micro compact smoke");
    createSessionMessage({
      sessionId: microCompactSession.id,
      clientMessageId: "micro-user-1",
      deviceId: "desktop",
      role: "user",
      content: "先给我一大段诊断输出。",
      attachmentIds: [],
    });
    createSessionMessage({
      sessionId: microCompactSession.id,
      clientMessageId: "micro-assistant-1",
      deviceId: "runtime-agent",
      role: "assistant",
      content: Array.from({ length: 240 }, (_, index) => `诊断片段 ${index + 1}: 这里是很长的历史输出，用来模拟旧的大段 assistant 结果。`).join("\n"),
      attachmentIds: [],
    });
    createSessionMessage({
      sessionId: microCompactSession.id,
      clientMessageId: "micro-user-2",
      deviceId: "desktop",
      role: "user",
      content: "别急着做 checkpoint，先保留最近现场。",
      attachmentIds: [],
    });
    createSessionMessage({
      sessionId: microCompactSession.id,
      clientMessageId: "micro-assistant-2",
      deviceId: "runtime-agent",
      role: "assistant",
      content: "好的，我继续保留最近现场，但会想办法别让旧输出太胖。",
      attachmentIds: [],
    });
    createSessionMessage({
      sessionId: microCompactSession.id,
      clientMessageId: "micro-user-3",
      deviceId: "desktop",
      role: "user",
      content: "现在告诉我旧的大段 assistant 输出会不会被瘦身。",
      attachmentIds: [],
    });

    const microCompactedContext = await loadContext(microCompactSession.id, new AbortController().signal);
    const microCompactedTranscript = microCompactedContext.messages
      .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
      .join("\n");
    assert.match(microCompactedTranscript, /\[Micro-compacted assistant output\]/u);
    assert.match(microCompactedTranscript, /现在告诉我旧的大段 assistant 输出会不会被瘦身/u);
    assert.equal(microCompactedContext.timings.compactionMicroCompactedMessages, 1);

    const midTurnContext = await loadContext(session.id, new AbortController().signal, {
      midTurn: {
        currentUserRequest: "再补一条 context boundary，别让模型把摘要当成新的用户消息。",
        assistantDraft: "已经把滚动摘要和 recent turns 分层，后面只差一条明确的边界提示。",
        recoveryReason: "reload_context",
        note: "这是同一轮中的上下文续跑，不要把之前已经做过的工具尝试再做一遍。",
        toolAtoms: [
          {
            toolCallId: "midturn-web-fetch-1",
            toolName: "web_fetch",
            status: "succeeded",
            input: "https://example.com/context-boundary",
            result: "Boundary notes already confirm summary text is not a fresh user turn.",
          },
          {
            toolCallId: "midturn-edit-1",
            toolName: "edit",
            status: "in_progress",
            input: "apps/daemon/src/context/compact/attachments.ts",
            result: null,
          },
        ],
        toolStates: [
          {
            toolName: "grep",
            status: "succeeded",
            detail: "已经确认 summary 和 recent turns 都在主链路里。",
          },
          {
            toolName: "edit",
            status: "in_progress",
            detail: "正在补 boundary block。",
          },
        ],
      },
    });
    const midTurnPrompt = flattenSystemPrompt(midTurnContext.systemPrompt);
    assert.match(midTurnPrompt, /## Mid-Turn Continuation/u);
    assert.match(midTurnPrompt, /reload_context/u);
    assert.match(midTurnPrompt, /<mid_turn_tool_transcript>/u);
    assert.match(midTurnPrompt, /<tool_atom id="midturn-web-fetch-1"/u);
    assert.match(midTurnPrompt, /<tool_use>https:\/\/example\.com\/context-boundary/u);
    assert.match(midTurnPrompt, /<tool_result>Boundary notes already confirm/u);
    assert.match(midTurnPrompt, /<tool_atom id="midturn-edit-1"/u);
    assert.match(midTurnPrompt, /\[still running\]/u);
  } finally {
    rmSync(tempDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

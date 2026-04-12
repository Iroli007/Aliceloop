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
      { refreshSessionRollingSummary },
      { updateRuntimeSettings },
      { createSession, createSessionMessage, getSessionSnapshot },
    ] = await Promise.all([
      import("../src/context/index.ts"),
      import("../src/context/session/rollingSummary.ts"),
      import("../src/repositories/runtimeSettingsRepository.ts"),
      import("../src/repositories/sessionRepository.ts"),
    ]);

    updateRuntimeSettings({
      recentTurnsCount: 1,
    });

    const session = createSession("session rolling summary smoke");

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

    const summary = await refreshSessionRollingSummary(session.id);
    assert.equal(summary.summarizedTurnCount, 2);
    assert.match(summary.summary, /Archived 2 earlier turns|线程记忆|memory_notes/u);

    const snapshot = getSessionSnapshot(session.id);
    assert.equal(snapshot.rollingSummary.summarizedTurnCount, 2);

    const context = await loadContext(session.id, new AbortController().signal);
    const prompt = flattenSystemPrompt(context.systemPrompt);
    assert.match(prompt, /## Context Boundary/u);
    assert.match(prompt, /## Rolling Summary/u);
    assert.match(prompt, /Archived turns covered: 2/u);
    assert.match(prompt, /Boundary source: rolling session memory/u);

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
  } finally {
    rmSync(tempDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

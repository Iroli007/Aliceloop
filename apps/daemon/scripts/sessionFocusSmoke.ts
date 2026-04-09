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
  const tempDataDir = mkdtempSync(join(tmpdir(), "aliceloop-session-focus-"));
  process.env.ALICELOOP_DATA_DIR = tempDataDir;

  try {
    const [
      { loadContext },
      { buildSessionContextFragments },
      { createSession, createSessionMessage, getSessionSnapshot, updateSessionFocusState },
    ] = await Promise.all([
      import("../src/context/index.ts"),
      import("../src/context/session/sessionContext.ts"),
      import("../src/repositories/sessionRepository.ts"),
    ]);

    const session = createSession("session focus smoke");

    const updated = updateSessionFocusState(session.id, {
      goal: "把 session focus state 接进 prompt 主链路。",
      constraints: ["不要引入第三套记忆", "先做最小可用版本"],
      priorities: ["先补 snapshot 和 prompt", "再留最小 API/CLI 写入口"],
      nextStep: "补一个 smoke，确认 focus block 确实会注入上下文。",
      doneCriteria: ["focus state 可持久化", "loadContext 能看到 session focus block"],
      blockers: ["还没有自动维护逻辑"],
    });

    assert.equal(updated.sessionId, session.id);
    assert.equal(updated.goal, "把 session focus state 接进 prompt 主链路。");
    assert.deepEqual(updated.constraints, ["不要引入第三套记忆", "先做最小可用版本"]);

    const snapshot = getSessionSnapshot(session.id);
    assert.equal(snapshot.focusState.goal, updated.goal);
    assert.deepEqual(snapshot.focusState.priorities, updated.priorities);
    assert.equal(snapshot.focusState.nextStep, updated.nextStep);

    const context = await loadContext(session.id, new AbortController().signal);
    const prompt = flattenSystemPrompt(context.systemPrompt);
    assert.match(prompt, /## Session Focus/u);
    assert.match(prompt, /把 session focus state 接进 prompt 主链路。/u);
    assert.match(prompt, /先补 snapshot 和 prompt/u);
    assert.match(prompt, /还没有自动维护逻辑/u);

    const researchSession = createSession("session continuation smoke");
    createSessionMessage({
      sessionId: researchSession.id,
      clientMessageId: "user-1",
      deviceId: "smoke",
      role: "user",
      content: "帮我生成一个桌宠吧",
      attachmentIds: [],
    });
    createSessionMessage({
      sessionId: researchSession.id,
      clientMessageId: "assistant-1",
      deviceId: "smoke",
      role: "assistant",
      content: "计划已更新。",
      attachmentIds: [],
    });
    createSessionMessage({
      sessionId: researchSession.id,
      clientMessageId: "user-2",
      deviceId: "smoke",
      role: "user",
      content: "Python 桌面应用",
      attachmentIds: [],
    });
    createSessionMessage({
      sessionId: researchSession.id,
      clientMessageId: "user-3",
      deviceId: "smoke",
      role: "user",
      content: "查一下黄婷婷这个人，你客观评价一下它",
      attachmentIds: [],
    });

    const researchFragments = buildSessionContextFragments(researchSession.id);
    assert.equal(
      researchFragments.recentConversationFocus.continuationLike,
      false,
      "fresh research requests with explicit new entities should not be treated as continuation-only follow-ups",
    );
    assert.equal(
      researchFragments.recentConversationFocus.effectiveUserQuery,
      "查一下黄婷婷这个人，你客观评价一下它",
      "fresh research requests should not inherit unrelated anchors from the previous task",
    );

    await loadContext(researchSession.id, new AbortController().signal);

    const threadManagementSession = createSession("thread management routing smoke");
    createSessionMessage({
      sessionId: threadManagementSession.id,
      clientMessageId: "user-thread-1",
      deviceId: "smoke",
      role: "user",
      content: "删除掉四月份的所有线程对话",
      attachmentIds: [],
    });

    const threadManagementContext = await loadContext(threadManagementSession.id, new AbortController().signal);
    assert.deepEqual(
      threadManagementContext.routedSkillIds,
      ["thread-management"],
      "thread deletion requests should route to thread-management without notebook/scheduler drift",
    );
    assert.equal(
      "task_output" in threadManagementContext.tools,
      false,
      "thread deletion requests should not attach task output tools",
    );
    assert.equal(
      "agent" in threadManagementContext.tools,
      true,
      "agent should be part of the native tool surface without requiring a delegated-agent skill",
    );

    const explicitAgentSession = createSession("native agent tool smoke");
    createSessionMessage({
      sessionId: explicitAgentSession.id,
      clientMessageId: "user-agent-1",
      deviceId: "smoke",
      role: "user",
      content: "派个子代理去研究这个问题，并把结论回来告诉我",
      attachmentIds: [],
    });

    const explicitAgentContext = await loadContext(explicitAgentSession.id, new AbortController().signal);
    assert.equal(
      "agent" in explicitAgentContext.tools,
      true,
      "explicit sub-agent requests should still have access to the native agent tool",
    );
    assert.equal(
      explicitAgentContext.routedSkillIds.includes("delegated-agent"),
      false,
      "native agent usage should no longer depend on a delegated-agent skill route",
    );
  } finally {
    rmSync(tempDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

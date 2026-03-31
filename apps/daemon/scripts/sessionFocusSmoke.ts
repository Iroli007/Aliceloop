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
      { createSession, getSessionSnapshot, updateSessionFocusState },
    ] = await Promise.all([
      import("../src/context/index.ts"),
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
  } finally {
    rmSync(tempDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

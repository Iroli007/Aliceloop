import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const tempDataDir = mkdtempSync(join(tmpdir(), "aliceloop-delegated-task-"));
  process.env.ALICELOOP_DATA_DIR = tempDataDir;

  const [
    { createDelegatedTask },
    { createSession, createSessionMessage, upsertSessionJob },
    { getTaskDelegationOutput },
  ] = await Promise.all([
    import("../src/repositories/delegatedTaskRepository.ts"),
    import("../src/repositories/sessionRepository.ts"),
    import("../src/services/delegatedTaskService.ts"),
  ]);

  const parentSession = createSession("delegated parent smoke");
  const childSession = createSession("delegated child smoke");
  const delegatedTask = createDelegatedTask({
    sessionId: parentSession.id,
    title: "Task delegation · coder · smoke",
    objective: "Verify delegated task output plumbing.",
    role: "coder",
    childSessionId: childSession.id,
    status: "queued",
  });

  upsertSessionJob({
    id: "delegated-provider-job",
    sessionId: childSession.id,
    kind: "provider-completion",
    status: "running",
    title: "Preparing response",
    detail: "Smoke task is running.",
  });

  const runningOutput = await getTaskDelegationOutput(delegatedTask.id, false);
  assert.deepEqual(
    runningOutput,
    {
      task_id: delegatedTask.id,
      status: "running",
    },
    "task_output should surface the running state before the delegated task finishes",
  );

  createSessionMessage({
    sessionId: childSession.id,
    clientMessageId: "delegated-task-smoke-assistant",
    deviceId: "desktop-smoke",
    role: "assistant",
    content: "Delegated task complete.",
    attachmentIds: [],
  });

  upsertSessionJob({
    id: "delegated-provider-job",
    sessionId: childSession.id,
    kind: "provider-completion",
    status: "done",
    title: "Response ready",
    detail: "Smoke task finished.",
  });

  const completedOutput = await getTaskDelegationOutput(delegatedTask.id, false);
  assert.deepEqual(
    completedOutput,
    {
      task_id: delegatedTask.id,
      status: "completed",
      result: "Delegated task complete.",
    },
    "task_output should return the delegated assistant result once the child session completes",
  );

  console.info("[delegated-task-smoke] passed");
}

main().catch((error) => {
  console.error("[delegated-task-smoke] failed", error);
  process.exitCode = 1;
});

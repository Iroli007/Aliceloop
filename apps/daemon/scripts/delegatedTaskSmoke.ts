import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const tempDataDir = mkdtempSync(join(tmpdir(), "aliceloop-delegated-task-"));
  process.env.ALICELOOP_DATA_DIR = tempDataDir;

  const [
    { createDelegatedTask },
    { createSession, createSessionMessage, listSessionEventsSince, listSessionThreads, upsertSessionJob },
    { publishSessionEvent },
    { getTaskDelegationOutput, runTaskDelegation },
  ] = await Promise.all([
    import("../src/repositories/delegatedTaskRepository.ts"),
    import("../src/repositories/sessionRepository.ts"),
    import("../src/realtime/sessionStreams.ts"),
    import("../src/services/delegatedTaskService.ts"),
  ]);

  const parentSession = createSession("delegated parent smoke");
  const childSession = createSession({ title: "delegated child smoke", hidden: true });
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

  const visibleThreads = listSessionThreads();
  assert.equal(
    visibleThreads.some((thread) => thread.id === childSession.id),
    false,
    "hidden delegated child sessions should not appear in the main thread list",
  );

  const runningOutput = await getTaskDelegationOutput(delegatedTask.id, false);
  assert.deepEqual(
    runningOutput,
    {
      task_id: delegatedTask.id,
      mode: "subagent",
      status: "running",
      output_path: join(tempDataDir, "delegated-tasks", `${delegatedTask.id}.md`),
    },
    "task_output should surface the running state before the delegated task finishes",
  );
  assert.match(
    readFileSync(runningOutput.output_path, "utf8"),
    /Status: running/,
    "running delegated tasks should materialize an output file with their current status",
  );

  const blockingOutputPromise = getTaskDelegationOutput(delegatedTask.id, true, undefined, 1_000);

  setTimeout(() => {
    const messageResult = createSessionMessage({
      sessionId: childSession.id,
      clientMessageId: "delegated-task-smoke-assistant",
      deviceId: "desktop-smoke",
      role: "assistant",
      content: "Delegated task complete.",
      attachmentIds: [],
    });
    for (const event of messageResult.events) {
      publishSessionEvent(event);
    }

    const jobResult = upsertSessionJob({
      id: "delegated-provider-job",
      sessionId: childSession.id,
      kind: "provider-completion",
      status: "done",
      title: "Response ready",
      detail: "Smoke task finished.",
    });
    publishSessionEvent(jobResult.event);
  }, 25);

  const completedOutput = await blockingOutputPromise;
  assert.deepEqual(
    completedOutput,
    {
      task_id: delegatedTask.id,
      mode: "subagent",
      status: "completed",
      output_path: join(tempDataDir, "delegated-tasks", `${delegatedTask.id}.md`),
      result: "Delegated task complete.",
    },
    "task_output should return the delegated assistant result once the child session completes",
  );
  const completedOutputFile = readFileSync(completedOutput.output_path, "utf8");
  assert.match(
    completedOutputFile,
    /## Result\nDelegated task complete\./,
    "completed delegated tasks should write their final result into the output file",
  );

  const backgroundParent = createSession("background agent notification smoke");
  await runTaskDelegation({
    sessionId: backgroundParent.id,
    mode: "fork",
    prompt: "Check that background completion publishes a task notification event.",
    runInBackground: true,
  });
  let taskNotification = undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const backgroundEvents = listSessionEventsSince(backgroundParent.id, 0);
    taskNotification = backgroundEvents.find((event) => event.type === "task.notification");
    if (taskNotification) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(taskNotification, "background agent completion should append a task.notification event to the parent session");

  console.info("[delegated-task-smoke] passed");
}

main().catch((error) => {
  console.error("[delegated-task-smoke] failed", error);
  process.exitCode = 1;
});

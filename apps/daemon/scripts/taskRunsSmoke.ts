import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const tempDataDir = mkdtempSync(join(tmpdir(), "aliceloop-task-runs-"));
  process.env.ALICELOOP_DATA_DIR = tempDataDir;

  const [{ createAttachment, createSession, upsertSessionJob }, { getShellOverview }, { getTaskRun, listTaskRuns }] =
    await Promise.all([
      import("../src/repositories/sessionRepository.ts"),
      import("../src/repositories/overviewRepository.ts"),
      import("../src/repositories/taskRunRepository.ts"),
    ]);

  const session = createSession("任务表烟雾测试");

  const studyJobId = randomUUID();
  upsertSessionJob({
    id: studyJobId,
    sessionId: session.id,
    kind: "study-artifact",
    status: "queued",
    title: "准备生成学习页",
    detail: "任务刚入队。",
  });
  upsertSessionJob({
    id: studyJobId,
    sessionId: session.id,
    kind: "study-artifact",
    status: "running",
    title: "正在生成学习页",
    detail: "正文已经开始组织。",
  });
  upsertSessionJob({
    id: studyJobId,
    sessionId: session.id,
    kind: "study-artifact",
    status: "done",
    title: "学习页生成完成",
    detail: "任务已经完成。",
  });

  const providerJobId = randomUUID();
  upsertSessionJob({
    id: providerJobId,
    sessionId: session.id,
    kind: "provider-completion",
    status: "done",
    title: "模型回复完成",
    detail: "这类 job 不应该进入任务表。",
  });

  const attachmentResult = createAttachment({
    sessionId: session.id,
    fileName: "smoke-note.png",
    mimeType: "image/png",
    byteSize: 12,
    storagePath: join(tempDataDir, "uploads", "smoke-note.png"),
  });

  const scopedTasks = listTaskRuns({ sessionId: session.id, limit: 20 });
  const overview = getShellOverview();
  const studyTask = getTaskRun(studyJobId);
  const attachmentTask = getTaskRun(attachmentResult.jobs[0].id);
  const providerTask = getTaskRun(providerJobId);

  assert(studyTask, "study-artifact task should exist");
  assert.equal(studyTask.taskType, "study-artifact");
  assert.equal(studyTask.status, "done");
  assert.equal(studyTask.sessionId, session.id);

  assert(attachmentTask, "attachment-ingest task should exist");
  assert.equal(attachmentTask.taskType, "attachment-ingest");
  assert.equal(attachmentTask.status, "done");
  assert.equal(attachmentTask.sessionId, session.id);

  assert.equal(providerTask, null, "provider-completion jobs should not be mirrored into task_runs");
  assert(overview.taskRuns.some((task) => task.id === studyJobId), "overview should include study-artifact task");
  assert(scopedTasks.every((task) => task.sessionId === session.id), "session-scoped task list should stay in session");

  console.log(
    JSON.stringify(
      {
        ok: true,
        tempDataDir,
        sessionId: session.id,
        taskIds: scopedTasks.map((task) => task.id),
        taskTypes: scopedTasks.map((task) => task.taskType),
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

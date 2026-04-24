import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const tempDataDir = mkdtempSync(join(tmpdir(), "aliceloop-task-runs-"));
  process.env.ALICELOOP_DATA_DIR = tempDataDir;

  const [
    { createAttachment, createSession, upsertSessionJob },
    { getShellOverview },
    { getDefaultProjectDirectory },
    { getTaskRun, listTaskRuns },
    { runManagedTask },
  ] = await Promise.all([
    import("../../src/repositories/sessionRepository.ts"),
    import("../../src/repositories/overviewRepository.ts"),
    import("../../src/repositories/projectRepository.ts"),
    import("../../src/repositories/taskRunRepository.ts"),
    import("../../src/services/taskRunner.ts"),
  ]);

  const session = createSession("任务表烟雾测试");
  const workspaceRoot = getDefaultProjectDirectory().path;

  const studyJobId = randomUUID();
  const scriptPath = join(workspaceRoot, "echo-task.js");
  const documentPath = join(workspaceRoot, "runtime-notes.md");
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(scriptPath, 'console.log("task-runner-ok");\n', "utf8");
  writeFileSync(documentPath, "# Runtime notes\n\nTask runner smoke document.\n", "utf8");

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
  const documentIngest = await runManagedTask({
    taskType: "document-ingest",
    title: "Runtime 设计草稿",
    sourcePath: documentPath,
    sourceKind: "handout",
    documentKind: "digital",
  });
  const reviewCoach = await runManagedTask({
    taskType: "review-coach",
    sessionId: session.id,
  });
  const localScript = await runManagedTask({
    taskType: "script-runner",
    sessionId: session.id,
    title: "运行任务测试脚本",
    command: "node",
    args: [scriptPath],
    cwd: workspaceRoot,
  });
  const failingScript = await runManagedTask({
    taskType: "script-runner",
    sessionId: session.id,
    title: "运行失败脚本",
    command: "node",
    args: [join(workspaceRoot, "missing-script.js")],
    cwd: workspaceRoot,
  });
  const refreshedTaskList = listTaskRuns({ limit: 20 });
  const refreshedOverview = getShellOverview();

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
  assert(documentIngest.libraryItem, "document-ingest task should create a library item");
  assert.equal(documentIngest.task.taskType, "document-ingest");
  assert.equal(documentIngest.task.status, "done");
  assert.equal(documentIngest.memoryNote?.kind, "attention-summary", "document-ingest should distill attention into memory");
  assert(reviewCoach.memoryNote, "review-coach task should create a memory note");
  assert.equal(reviewCoach.task.taskType, "review-coach");
  assert.equal(localScript.task.taskType, "script-runner");
  assert.equal(localScript.task.status, "done");
  assert(localScript.task.detail.includes("task-runner-ok"), "script-runner should capture stdout");
  assert.equal(failingScript.task.taskType, "script-runner");
  assert.equal(failingScript.task.status, "failed");
  assert.equal(failingScript.memoryNote?.kind, "postmortem", "failed script-runner should create postmortem memory");
  assert(
    refreshedOverview.memories.some((memory) => memory.id === documentIngest.memoryNote?.id),
    "overview should include distilled attention memory",
  );
  assert(
    refreshedOverview.memories.some((memory) => memory.id === failingScript.memoryNote?.id),
    "overview should include failure postmortem memory",
  );
  assert(refreshedTaskList.some((task) => task.id === documentIngest.task.id), "task list should include document-ingest task");
  assert(refreshedTaskList.some((task) => task.id === reviewCoach.task.id), "task list should include review-coach task");
  assert(refreshedTaskList.some((task) => task.id === localScript.task.id), "task list should include script-runner task");
  assert(refreshedTaskList.some((task) => task.id === failingScript.task.id), "task list should include failed script-runner task");

  console.log(
    JSON.stringify(
      {
        ok: true,
        tempDataDir,
        sessionId: session.id,
        taskIds: refreshedTaskList.map((task) => task.id),
        taskTypes: refreshedTaskList.map((task) => task.taskType),
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

import { randomUUID } from "node:crypto";
import { basename, dirname, extname } from "node:path";
import { ingestDocument, type DocumentDetection, type WorkerPlan } from "@aliceloop/pdf-ingest";
import type {
  AttentionState,
  ContentBlock,
  CrossReference,
  DocumentKind,
  DocumentStructure,
  LibraryItem,
  MemoryNote,
  SectionSpan,
  SourceKind,
  TaskRun,
  TaskStatus,
  TaskType,
} from "@aliceloop/runtime-core";
import { getDataDir } from "../db/client";
import { createMemoryNote, getMemoryNote, upsertMemoryNote } from "../context/memory/memoryRepository";
import { getPrimaryLibraryContext, getShellOverview } from "../repositories/overviewRepository";
import { markLibraryAsFocused, persistIngestedLibrary } from "../repositories/libraryRepository";
import { getRuntimeSettings } from "../repositories/runtimeSettingsRepository";
import { listFailedManagedTasksForPostmortemBackfill, upsertTaskRun } from "../repositories/taskRunRepository";
import { createPermissionSandboxExecutor } from "./sandboxExecutor";

interface TaskRunnerResult {
  task: TaskRun;
  libraryItem?: LibraryItem;
  memoryNote?: MemoryNote;
  detection?: DocumentDetection;
  workerPlan?: WorkerPlan;
  structure?: DocumentStructure | null;
  sections?: SectionSpan[];
  contentBlocks?: ContentBlock[];
  crossReferences?: CrossReference[];
  attentionState?: AttentionState;
}

interface DocumentIngestTaskInput {
  taskType: "document-ingest";
  title?: string;
  sourcePath: string;
  sourceKind?: SourceKind;
  documentKind?: DocumentKind;
}

interface ReviewCoachTaskInput {
  taskType: "review-coach";
  sessionId?: string | null;
  title?: string;
}

interface ScriptRunnerTaskInput {
  taskType: "script-runner";
  sessionId?: string | null;
  title?: string;
  command: string;
  args?: string[];
  cwd?: string;
}

export type CreateManagedTaskInput = DocumentIngestTaskInput | ReviewCoachTaskInput | ScriptRunnerTaskInput;

function formatTaskUpdatedAtLabel(status: TaskStatus) {
  switch (status) {
    case "queued":
      return "等待中";
    case "running":
      return "正在运行";
    case "failed":
      return "执行失败";
    case "done":
    default:
      return "刚刚更新";
  }
}

function writeTaskRun(
  taskId: string,
  taskType: TaskType,
  status: TaskStatus,
  title: string,
  detail: string,
  sessionId: string | null,
) {
  const now = new Date().toISOString();
  return upsertTaskRun({
    id: taskId,
    sessionId,
    taskType,
    status,
    title,
    detail,
    updatedAt: now,
    updatedAtLabel: formatTaskUpdatedAtLabel(status),
  });
}

function inferLibraryTitle(sourcePath: string, title?: string) {
  const trimmedTitle = title?.trim();
  if (trimmedTitle) {
    return trimmedTitle;
  }

  const fileName = basename(sourcePath).trim();
  if (!fileName) {
    return "未命名资料";
  }

  return fileName.replace(/\.[^.]+$/, "");
}

function inferConcepts(sections: SectionSpan[]) {
  return sections
    .map((section) => section.title)
    .flatMap((title) => title.split(/[、，,\s/]+/))
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .filter((item, index, items) => items.indexOf(item) === index)
    .slice(0, 6);
}

function buildReviewCoachContent() {
  const overview = getShellOverview();
  const libraryTitle = overview.attention.currentLibraryTitle ?? overview.library[0]?.title ?? "当前资料";
  const concepts = overview.attention.concepts.slice(0, 3);
  const latestArtifact = overview.artifacts[0];
  const latestMemory = overview.memories[0];

  const lines = [
    `当前复习重心：${libraryTitle}`,
    concepts.length > 0 ? `优先回看概念：${concepts.join("、")}` : "优先回看概念：先补最近关注的章节与图表。",
    latestArtifact
      ? `最近工件：${latestArtifact.title}，建议先用它回忆主结构，再回到原文核对细节。`
      : "最近工件：还没有新的学习页，建议先把本轮重点整理成提纲。",
    latestMemory
      ? `记忆提示：${latestMemory.content}`
      : "记忆提示：先从最近两次混淆点入手，再补关系图。",
  ];

  return lines.join("\n");
}

function buildAttentionSummaryMemory(attentionState: AttentionState) {
  const lines = [
    `当前关注资料：${attentionState.currentLibraryTitle ?? "未命名资料"}`,
    attentionState.currentSectionLabel ? `当前章节：${attentionState.currentSectionLabel}` : "当前章节：先从文档起始结构回看。",
    `聚焦摘要：${attentionState.focusSummary}`,
    attentionState.concepts.length > 0
      ? `高频概念：${attentionState.concepts.slice(0, 5).join("、")}`
      : "高频概念：先围绕最近的章节标题和主题词建立导航。",
  ];

  return upsertMemoryNote({
    id: "memory-attention-primary",
    kind: "attention-summary",
    title: `关注摘要 · ${attentionState.currentLibraryTitle ?? "当前资料"}`,
    content: lines.join("\n"),
    source: "attention-index",
    updatedAt: attentionState.updatedAt,
  });
}

function createFailureMemory(input: {
  taskId: string;
  taskType: TaskType;
  title: string;
  detail: string;
  updatedAt?: string;
  context: string[];
}) {
  const lines = [`任务类型：${input.taskType}`, ...input.context, `失败原因：${input.detail}`];

  return upsertMemoryNote({
    id: `postmortem-task-${input.taskId}`,
    kind: "postmortem",
    title: `失败复盘 · ${input.title}`,
    content: lines.join("\n"),
    source: `task-postmortem:${input.taskId}`,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  });
}

export function backfillFailurePostmortems() {
  const failedTasks = listFailedManagedTasksForPostmortemBackfill();
  let createdCount = 0;

  for (const task of failedTasks) {
    const existingMemory = getMemoryNote(`postmortem-task-${task.id}`);
    if (existingMemory) {
      continue;
    }

    const memoryNote = createFailureMemory({
      taskId: task.id,
      taskType: task.taskType,
      title: task.title,
      detail: task.detail,
      updatedAt: task.updatedAt,
      context: [
        `任务标题：${task.title}`,
        task.sessionId ? `会话：${task.sessionId}` : "会话：无",
        "来源：历史失败任务回填",
      ],
    });

    if (memoryNote) {
      createdCount += 1;
    }
  }

  return {
    scannedCount: failedTasks.length,
    upsertedCount: createdCount,
  };
}

function canUseTextFallback(sourcePath: string) {
  const extension = extname(sourcePath).toLowerCase();
  return extension === ".txt" || extension === ".md" || extension === ".markdown";
}

async function runDocumentIngestTask(input: DocumentIngestTaskInput): Promise<TaskRunnerResult> {
  const taskId = randomUUID();
  const title = inferLibraryTitle(input.sourcePath, input.title);
  const runtimeSettings = getRuntimeSettings();

  writeTaskRun(taskId, "document-ingest", "queued", `准备接收资料 · ${title}`, "资料已经登记到任务中心，准备写入本地图书馆。", null);
  writeTaskRun(taskId, "document-ingest", "running", `正在解析资料 · ${title}`, "正在抽取章节结构、块级正文和检索索引。", null);

  try {
    const now = new Date().toISOString();
    const libraryItemId = `library-${randomUUID()}`;
    const sandbox = createPermissionSandboxExecutor({
      label: `document-ingest:${title}`,
      permissionProfile: runtimeSettings.sandboxProfile,
      extraReadRoots: [dirname(input.sourcePath)],
    });
    const fallbackText = canUseTextFallback(input.sourcePath)
      ? await sandbox.readTextFile({
          targetPath: input.sourcePath,
        })
      : undefined;
    const ingestResult = ingestDocument({
      libraryItemId,
      title,
      sourcePath: input.sourcePath,
      fallbackText,
    });
    const sections = ingestResult.structureDraft.sections;
    const libraryItem: LibraryItem = {
      id: libraryItemId,
      title,
      sourceKind: input.sourceKind ?? "handout",
      documentKind: input.documentKind ?? ingestResult.detection.documentKind,
      sourcePath: input.sourcePath,
      createdAt: now,
      updatedAt: now,
      lastAttentionLabel: sections[0]?.title ?? "已完成初版 ingest",
    };

    const persisted = persistIngestedLibrary({
      libraryItem,
      structure: ingestResult.structureDraft.structure,
      sections,
      contentBlocks: ingestResult.contentBlocks,
      crossReferences: ingestResult.crossReferences,
    });

    const attentionState = markLibraryAsFocused({
      libraryItemId,
      libraryTitle: title,
      sectionKey: sections[0]?.key ?? null,
      sectionLabel: sections[0]?.title ?? null,
      focusSummary: `刚完成 ${title} 的初版文档结构抽取，后续可以直接围绕章节和块级内容继续定位。`,
      concepts: inferConcepts(sections),
    });
    const memoryNote = buildAttentionSummaryMemory(attentionState);

    const task = writeTaskRun(
      taskId,
      "document-ingest",
      "done",
      `资料解析完成 · ${title}`,
      `已写入 ${persisted.sections.length} 个章节、${persisted.contentBlocks.length} 个内容块和 ${persisted.crossReferences.length} 条回链。${
        fallbackText ? " 源文本已通过权限型沙箱读取。" : " 当前仍在等待更强的 PDF 正文抽取。"
      }`,
      null,
    );

    return {
      task,
      libraryItem,
      detection: ingestResult.detection,
      workerPlan: ingestResult.workerPlan,
      structure: persisted.structure,
      sections: persisted.sections,
      contentBlocks: persisted.contentBlocks,
      crossReferences: persisted.crossReferences,
      attentionState,
      memoryNote,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "资料解析失败";
    const task = writeTaskRun(taskId, "document-ingest", "failed", `资料解析失败 · ${title}`, detail, null);
    const memoryNote = createFailureMemory({
      taskId,
      taskType: "document-ingest",
      title,
      detail,
      updatedAt: task.updatedAt,
      context: [`资料路径：${input.sourcePath}`],
    });
    return { task, memoryNote };
  }
}

async function runReviewCoachTask(input: ReviewCoachTaskInput): Promise<TaskRunnerResult> {
  const taskId = randomUUID();
  const { relatedLibraryTitle } = getPrimaryLibraryContext();
  const title = input.title?.trim() || `生成复习建议 · ${relatedLibraryTitle}`;

  writeTaskRun(taskId, "review-coach", "queued", title, "正在汇总最近的注意力、工件和记忆。", input.sessionId ?? null);
  writeTaskRun(taskId, "review-coach", "running", title, "正在生成一份新的复习建议。", input.sessionId ?? null);

  const memoryNote = createMemoryNote({
    id: `memory-${randomUUID()}`,
    kind: "learning-pattern",
    title: `复习建议 · ${relatedLibraryTitle}`,
    content: buildReviewCoachContent(),
    source: "review-coach",
    updatedAt: new Date().toISOString(),
  });

  const task = writeTaskRun(
    taskId,
    "review-coach",
    "done",
    title,
    "复习建议已经沉淀为新的记忆笔记，可直接被后续任务复用。",
    input.sessionId ?? null,
  );

  return {
    task,
    memoryNote,
  };
}

async function runScriptRunnerTask(input: ScriptRunnerTaskInput): Promise<TaskRunnerResult> {
  const taskId = randomUUID();
  const command = input.command.trim();
  const args = input.args ?? [];
  const cwd = input.cwd?.trim() || getDataDir();
  const title = input.title?.trim() || `运行脚本 · ${command}`;
  const runtimeSettings = getRuntimeSettings();

  writeTaskRun(taskId, "script-runner", "queued", title, "脚本任务已经入队，等待进入权限型沙箱执行。", input.sessionId ?? null);
  writeTaskRun(taskId, "script-runner", "running", title, "正在通过权限型沙箱执行本地命令。", input.sessionId ?? null);

  try {
    const sandbox = createPermissionSandboxExecutor({
      label: `script-runner:${title}`,
      permissionProfile: runtimeSettings.sandboxProfile,
      extraReadRoots: [cwd],
      extraWriteRoots: [cwd],
      extraCwdRoots: [cwd],
    });
    const result = await sandbox.runBash({
      command,
      args,
      cwd,
      timeoutMs: 20_000,
    });
    const detailParts = [`命令已完成：${command}`];
    if (result.stdout.trim()) {
      detailParts.push(`stdout: ${result.stdout.trim().slice(0, 240)}`);
    }
    if (result.stderr.trim()) {
      detailParts.push(`stderr: ${result.stderr.trim().slice(0, 240)}`);
    }

    const task = writeTaskRun(
      taskId,
      "script-runner",
      "done",
      title,
      detailParts.join(" | "),
      input.sessionId ?? null,
    );

    return {
      task,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "本地脚本执行失败";
    const task = writeTaskRun(taskId, "script-runner", "failed", title, detail, input.sessionId ?? null);
    const memoryNote = createFailureMemory({
      taskId,
      taskType: "script-runner",
      title,
      detail,
      updatedAt: task.updatedAt,
      context: [
        `命令：${command}${args.length > 0 ? ` ${args.join(" ")}` : ""}`,
        `工作目录：${cwd}`,
      ],
    });
    return { task, memoryNote };
  }
}

export async function runManagedTask(input: CreateManagedTaskInput): Promise<TaskRunnerResult> {
  switch (input.taskType) {
    case "document-ingest":
      return runDocumentIngestTask(input);
    case "review-coach":
      return runReviewCoachTask(input);
    case "script-runner":
      return runScriptRunnerTask(input);
    default:
      throw new Error(`Unsupported task type: ${(input as { taskType: string }).taskType}`);
  }
}

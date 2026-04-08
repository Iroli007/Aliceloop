import { randomUUID } from "node:crypto";
import { basename, extname, resolve } from "node:path";
import { ingestDocument, type DocumentDetection, type WorkerPlan } from "@aliceloop/pdf-ingest";
import type {
  AttentionState,
  ContentBlock,
  CrossReference,
  DocumentKind,
  DocumentStructure,
  LibraryItem,
  SectionSpan,
  SourceKind,
  TaskRun,
  TaskStatus,
  TaskType,
} from "@aliceloop/runtime-core";
import { getDefaultProjectDirectory } from "../repositories/projectRepository";
import { getPrimaryLibraryContext, getShellOverview } from "../repositories/overviewRepository";
import { markLibraryAsFocused, persistIngestedLibrary } from "../repositories/libraryRepository";
import { getRuntimeSettings } from "../repositories/runtimeSettingsRepository";
import { upsertTaskRun } from "../repositories/taskRunRepository";
import { createPermissionSandboxExecutor } from "./sandboxExecutor";
import { isPathWithinRoot } from "../runtime/sandbox/toolPolicy";

interface TaskRunnerResult {
  task: TaskRun;
  libraryItem?: LibraryItem;
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

  const lines = [
    `当前复习重心：${libraryTitle}`,
    concepts.length > 0 ? `优先回看概念：${concepts.join("、")}` : "优先回看概念：先补最近关注的章节与图表。",
    latestArtifact
      ? `最近工件：${latestArtifact.title}，建议先用它回忆主结构，再回到原文核对细节。`
      : "最近工件：还没有新的学习页，建议先把本轮重点整理成提纲。",
    "复习提示：先从最近两次混淆点入手，再补关系图。",
  ];

  return lines.join("\n");
}

function canUseTextFallback(sourcePath: string) {
  const extension = extname(sourcePath).toLowerCase();
  return extension === ".txt" || extension === ".md" || extension === ".markdown";
}

function resolveWorkspacePath(workspaceRoot: string, targetPath: string) {
  return resolve(workspaceRoot, targetPath);
}

async function runDocumentIngestTask(input: DocumentIngestTaskInput): Promise<TaskRunnerResult> {
  const taskId = randomUUID();
  const workspaceRoot = getDefaultProjectDirectory().path;
  const sourcePath = resolveWorkspacePath(workspaceRoot, input.sourcePath);
  const title = inferLibraryTitle(sourcePath, input.title);

  writeTaskRun(taskId, "document-ingest", "queued", `准备接收资料 · ${title}`, "资料已经登记到任务中心，准备写入本地图书馆。", null);
  writeTaskRun(taskId, "document-ingest", "running", `正在解析资料 · ${title}`, "正在抽取章节结构、块级正文和检索索引。", null);

  try {
    if (!isPathWithinRoot(sourcePath, workspaceRoot)) {
      throw new Error(`document-ingest sourcePath must stay inside the default workspace: ${sourcePath}`);
    }

    const runtimeSettings = getRuntimeSettings();
    const now = new Date().toISOString();
    const libraryItemId = `library-${randomUUID()}`;
    const sandbox = createPermissionSandboxExecutor({
      label: `document-ingest:${title}`,
      permissionProfile: runtimeSettings.sandboxProfile,
      workspaceRoot,
    });
    const fallbackText = canUseTextFallback(sourcePath)
      ? await sandbox.readTextFile({
          targetPath: sourcePath,
        })
      : undefined;
    const ingestResult = ingestDocument({
      libraryItemId,
      title,
      sourcePath,
      fallbackText,
    });
    const sections = ingestResult.structureDraft.sections;
    const libraryItem: LibraryItem = {
      id: libraryItemId,
      title,
      sourceKind: input.sourceKind ?? "handout",
      documentKind: input.documentKind ?? ingestResult.detection.documentKind,
      sourcePath,
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

    const task = writeTaskRun(
      taskId,
      "document-ingest",
      "done",
      `资料解析完成 · ${title}`,
      `已写入 ${persisted.sections.length} 个章节、${persisted.contentBlocks.length} 个内容块和 ${persisted.crossReferences.length} 条回链。${
        fallbackText ? " 源文本已直接读取。" : " 当前仍在等待更强的 PDF 正文抽取。"
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
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "资料解析失败";
    const task = writeTaskRun(taskId, "document-ingest", "failed", `资料解析失败 · ${title}`, detail, null);
    return { task };
  }
}

async function runReviewCoachTask(input: ReviewCoachTaskInput): Promise<TaskRunnerResult> {
  const taskId = randomUUID();
  const { relatedLibraryTitle } = getPrimaryLibraryContext();
  const title = input.title?.trim() || `生成复习建议 · ${relatedLibraryTitle}`;

  writeTaskRun(taskId, "review-coach", "queued", title, "正在汇总最近的注意力、工件和记忆。", input.sessionId ?? null);
  writeTaskRun(taskId, "review-coach", "running", title, "正在生成一份新的复习建议。", input.sessionId ?? null);

  const task = writeTaskRun(
    taskId,
    "review-coach",
    "done",
    title,
    buildReviewCoachContent(),
    input.sessionId ?? null,
  );

  return { task };
}

async function runScriptRunnerTask(input: ScriptRunnerTaskInput): Promise<TaskRunnerResult> {
  const taskId = randomUUID();
  const workspaceRoot = getDefaultProjectDirectory().path;
  const command = input.command.trim();
  const args = input.args ?? [];
  const cwd = resolveWorkspacePath(workspaceRoot, input.cwd?.trim() || ".");
  const title = input.title?.trim() || `运行脚本 · ${command}`;

  writeTaskRun(taskId, "script-runner", "queued", title, "脚本任务已经入队，等待直接执行。", input.sessionId ?? null);
  writeTaskRun(taskId, "script-runner", "running", title, "正在执行本地命令。", input.sessionId ?? null);

  try {
    if (!isPathWithinRoot(cwd, workspaceRoot)) {
      throw new Error(`script-runner cwd must stay inside the default workspace: ${cwd}`);
    }

    const runtimeSettings = getRuntimeSettings();
    const sandbox = createPermissionSandboxExecutor({
      label: `script-runner:${title}`,
      permissionProfile: runtimeSettings.sandboxProfile,
      workspaceRoot,
      defaultCwd: workspaceRoot,
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
    return { task };
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

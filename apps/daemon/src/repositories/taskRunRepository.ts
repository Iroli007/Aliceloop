import { randomUUID } from "node:crypto";
import type { JobRunDetail, TaskRun, TaskStatus, TaskType } from "@aliceloop/runtime-core";
import { getDatabase } from "../db/client";

interface TaskRunRow {
  id: string;
  sessionId: string | null;
  taskType: TaskType;
  status: TaskStatus;
  title: string;
  detail: string;
  updatedAt: string;
  updatedAtLabel: string;
}

interface JobRunRow {
  id: string;
  sessionId: string;
  kind: string;
  status: TaskStatus;
  title: string;
  detail: string;
  updatedAt: string;
}

interface TrackedTaskStep {
  title: string;
  done: boolean;
}

function toTaskType(jobKind: string): TaskType | null {
  switch (jobKind) {
    case "document-ingest":
    case "attachment-ingest":
    case "study-artifact":
    case "review-coach":
    case "script-runner":
    case "tracked-task":
      return jobKind;
    default:
      return null;
  }
}

function formatUpdatedAtLabel(status: TaskStatus) {
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

function toTaskRun(row: TaskRunRow): TaskRun {
  return {
    id: row.id,
    sessionId: row.sessionId,
    taskType: row.taskType,
    status: row.status,
    title: row.title,
    detail: row.detail,
    updatedAt: row.updatedAt,
    updatedAtLabel: row.updatedAtLabel,
  };
}

function normalizeTrackedTaskSteps(steps: string[]) {
  return steps
    .map((step) => step.trim())
    .filter(Boolean)
    .map((title) => ({ title, done: false } satisfies TrackedTaskStep));
}

function parseTrackedTaskDetail(detail: string) {
  const normalized = detail.trim();
  if (!normalized) {
    return {
      summary: "",
      steps: [] as TrackedTaskStep[],
    };
  }

  const lines = normalized.split(/\r?\n/);
  const stepsHeaderIndex = lines.findIndex((line) => line.trim() === "Steps:");
  if (stepsHeaderIndex < 0) {
    return {
      summary: normalized,
      steps: [] as TrackedTaskStep[],
    };
  }

  const summary = lines.slice(0, stepsHeaderIndex).join("\n").trim();
  const steps = lines
    .slice(stepsHeaderIndex + 1)
    .map((line) => line.match(/^- \[( |x)\] (.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      done: match[1] === "x",
      title: match[2].trim(),
    }));

  return {
    summary,
    steps,
  };
}

function renderTrackedTaskDetail(summary: string, steps: TrackedTaskStep[]) {
  const parts: string[] = [];
  if (summary.trim()) {
    parts.push(summary.trim());
  }

  if (steps.length > 0) {
    if (parts.length > 0) {
      parts.push("");
    }

    parts.push("Steps:");
    for (const step of steps) {
      parts.push(`- [${step.done ? "x" : " "}] ${step.title}`);
    }
  }

  return parts.join("\n");
}

export function upsertTaskRun(taskRun: TaskRun) {
  const db = getDatabase();
  db.prepare(
    `
      INSERT INTO task_runs (
        id, session_id, task_type, status, title, detail, updated_at, updated_at_label
      ) VALUES (
        @id, @sessionId, @taskType, @status, @title, @detail, @updatedAt, @updatedAtLabel
      )
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        task_type = excluded.task_type,
        status = excluded.status,
        title = excluded.title,
        detail = excluded.detail,
        updated_at = excluded.updated_at,
        updated_at_label = excluded.updated_at_label
    `,
  ).run(taskRun);

  return taskRun;
}

export function createTrackedTask(input: {
  title: string;
  sessionId?: string | null;
  detail?: string;
  steps?: string[];
}) {
  const now = new Date().toISOString();
  return upsertTaskRun({
    id: randomUUID(),
    sessionId: input.sessionId ?? null,
    taskType: "tracked-task",
    status: "queued",
    title: input.title.trim(),
    detail: renderTrackedTaskDetail(input.detail ?? "", normalizeTrackedTaskSteps(input.steps ?? [])),
    updatedAt: now,
    updatedAtLabel: formatUpdatedAtLabel("queued"),
  });
}

export function updateTrackedTask(input: {
  taskId: string;
  title?: string;
  detail?: string;
  status?: TaskStatus;
  steps?: string[];
  stepIndex?: number;
  stepDone?: boolean;
  markAllStepsDone?: boolean;
}) {
  const existing = getTaskRun(input.taskId);
  if (!existing || existing.taskType !== "tracked-task") {
    return null;
  }

  const parsed = parseTrackedTaskDetail(existing.detail);
  const nextSteps =
    input.steps !== undefined
      ? normalizeTrackedTaskSteps(input.steps)
      : parsed.steps.map((step) => ({ ...step }));

  if (input.stepIndex !== undefined) {
    if (input.stepIndex < 0 || input.stepIndex >= nextSteps.length) {
      throw new Error("tracked_task_step_out_of_range");
    }

    nextSteps[input.stepIndex] = {
      ...nextSteps[input.stepIndex],
      done: input.stepDone ?? !nextSteps[input.stepIndex].done,
    };
  }

  if (input.markAllStepsDone) {
    for (let index = 0; index < nextSteps.length; index += 1) {
      nextSteps[index] = {
        ...nextSteps[index],
        done: true,
      };
    }
  }

  const nextStatus = input.status ?? existing.status;
  const now = new Date().toISOString();
  return upsertTaskRun({
    ...existing,
    title: input.title?.trim() || existing.title,
    status: nextStatus,
    detail: renderTrackedTaskDetail(
      input.detail !== undefined ? input.detail : parsed.summary,
      nextSteps,
    ),
    updatedAt: now,
    updatedAtLabel: formatUpdatedAtLabel(nextStatus),
  });
}

export function deleteTrackedTask(taskId: string) {
  const existing = getTaskRun(taskId);
  if (!existing || existing.taskType !== "tracked-task") {
    return null;
  }

  const db = getDatabase();
  db.prepare(
    `
      DELETE FROM task_runs
      WHERE id = ?
    `,
  ).run(taskId);

  return existing;
}

export function syncTaskRunFromJob(job: JobRunDetail) {
  const taskType = toTaskType(job.kind);
  if (!taskType) {
    return null;
  }

  return upsertTaskRun({
    id: job.id,
    sessionId: job.sessionId,
    taskType,
    status: job.status,
    title: job.title,
    detail: job.detail,
    updatedAt: job.updatedAt,
    updatedAtLabel: formatUpdatedAtLabel(job.status),
  });
}

export function listTaskRuns(options: { sessionId?: string; taskType?: TaskType; status?: TaskStatus; limit?: number } = {}) {
  const db = getDatabase();
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const filters: string[] = [];
  const params: Array<string | number> = [];

  if (options.sessionId) {
    filters.push("session_id = ?");
    params.push(options.sessionId);
  }

  if (options.taskType) {
    filters.push("task_type = ?");
    params.push(options.taskType);
  }

  if (options.status) {
    filters.push("status = ?");
    params.push(options.status);
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `
        SELECT
          id,
          session_id AS sessionId,
          task_type AS taskType,
          status,
          title,
          detail,
          updated_at AS updatedAt,
          updated_at_label AS updatedAtLabel
        FROM task_runs
        ${whereClause}
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
      `,
    )
    .all(...params, limit) as TaskRunRow[];

  return rows.map(toTaskRun);
}

export function getTaskRun(taskId: string) {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT
          id,
          session_id AS sessionId,
          task_type AS taskType,
          status,
          title,
          detail,
          updated_at AS updatedAt,
          updated_at_label AS updatedAtLabel
        FROM task_runs
        WHERE id = ?
      `,
    )
    .get(taskId) as TaskRunRow | undefined;

  return row ? toTaskRun(row) : null;
}

export function backfillTaskRunsFromJobs() {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          id,
          session_id AS sessionId,
          kind,
          status,
          title,
          detail,
          updated_at AS updatedAt
        FROM job_runs
        ORDER BY updated_at ASC, id ASC
      `,
    )
    .all() as JobRunRow[];

  for (const row of rows) {
    syncTaskRunFromJob({
      id: row.id,
      sessionId: row.sessionId,
      kind: row.kind,
      status: row.status,
      title: row.title,
      detail: row.detail,
      updatedAt: row.updatedAt,
    });
  }
}

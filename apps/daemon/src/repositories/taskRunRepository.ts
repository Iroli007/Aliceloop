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

function toTaskType(jobKind: string): TaskType | null {
  switch (jobKind) {
    case "document-ingest":
    case "attachment-ingest":
    case "study-artifact":
    case "review-coach":
    case "script-runner":
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

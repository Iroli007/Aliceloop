import { randomUUID } from "node:crypto";
import { getDatabase } from "../db/client";

export type DelegatedTaskRole = "coder" | "plan" | "researcher" | "general-purpose";
export type DelegatedTaskStatus = "queued" | "running" | "completed" | "failed";

export interface DelegatedTaskRun {
  id: string;
  sessionId: string | null;
  title: string;
  objective: string;
  role: DelegatedTaskRole;
  childSessionId: string;
  status: DelegatedTaskStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface DelegatedTaskRow {
  id: string;
  sessionId: string | null;
  title: string;
  objective: string;
  rolesJson: string;
  taskIdsJson: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function parseJsonStringArray(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

function normalizeRole(value: string | undefined): DelegatedTaskRole {
  switch (value) {
    case "coder":
    case "plan":
    case "researcher":
    case "general-purpose":
      return value;
    default:
      return "general-purpose";
  }
}

function normalizeStatus(value: string): DelegatedTaskStatus {
  switch (value) {
    case "queued":
    case "running":
    case "completed":
    case "failed":
      return value;
    default:
      return "failed";
  }
}

function toDelegatedTaskRun(row: DelegatedTaskRow): DelegatedTaskRun | null {
  const roles = parseJsonStringArray(row.rolesJson);
  const taskIds = parseJsonStringArray(row.taskIdsJson);
  const childSessionId = taskIds[0] ?? null;

  if (!childSessionId) {
    return null;
  }

  return {
    id: row.id,
    sessionId: row.sessionId,
    title: row.title,
    objective: row.objective,
    role: normalizeRole(roles[0]),
    childSessionId,
    status: normalizeStatus(row.status),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

export function createDelegatedTask(input: {
  id?: string;
  sessionId?: string | null;
  title: string;
  objective: string;
  role: DelegatedTaskRole;
  childSessionId: string;
  status?: DelegatedTaskStatus;
}) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const delegatedTask: DelegatedTaskRun = {
    id: input.id ?? randomUUID(),
    sessionId: input.sessionId ?? null,
    title: input.title.trim(),
    objective: input.objective.trim(),
    role: input.role,
    childSessionId: input.childSessionId,
    status: input.status ?? "queued",
    createdAt: now,
    updatedAt: now,
    completedAt: input.status === "completed" ? now : null,
  };

  db.prepare(
    `
      INSERT INTO mission_runs (
        id, session_id, title, objective, roles_json, plan_id, task_ids_json, status, created_at, updated_at, completed_at
      ) VALUES (
        @id, @sessionId, @title, @objective, @rolesJson, NULL, @taskIdsJson, @status, @createdAt, @updatedAt, @completedAt
      )
    `,
  ).run({
    id: delegatedTask.id,
    sessionId: delegatedTask.sessionId,
    title: delegatedTask.title,
    objective: delegatedTask.objective,
    rolesJson: JSON.stringify([delegatedTask.role]),
    taskIdsJson: JSON.stringify([delegatedTask.childSessionId]),
    status: delegatedTask.status,
    createdAt: delegatedTask.createdAt,
    updatedAt: delegatedTask.updatedAt,
    completedAt: delegatedTask.completedAt,
  });

  return delegatedTask;
}

export function getDelegatedTask(taskId: string) {
  const db = getDatabase();
  const row = db.prepare(
    `
      SELECT
        id,
        session_id AS sessionId,
        title,
        objective,
        roles_json AS rolesJson,
        task_ids_json AS taskIdsJson,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt,
        completed_at AS completedAt
      FROM mission_runs
      WHERE id = ?
    `,
  ).get(taskId) as DelegatedTaskRow | undefined;

  return row ? toDelegatedTaskRun(row) : null;
}

export function updateDelegatedTaskStatus(
  taskId: string,
  status: DelegatedTaskStatus,
) {
  const existing = getDelegatedTask(taskId);
  if (!existing) {
    return null;
  }

  const updatedAt = new Date().toISOString();
  const completedAt = status === "completed" || status === "failed"
    ? (existing.completedAt ?? updatedAt)
    : null;
  const db = getDatabase();
  db.prepare(
    `
      UPDATE mission_runs
      SET status = ?, updated_at = ?, completed_at = ?
      WHERE id = ?
    `,
  ).run(status, updatedAt, completedAt, taskId);

  return {
    ...existing,
    status,
    updatedAt,
    completedAt,
  } satisfies DelegatedTaskRun;
}

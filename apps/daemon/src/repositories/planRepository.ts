import { randomUUID } from "node:crypto";
import { getDatabase } from "../db/client";

export type PlanStatus = "draft" | "approved" | "archived";

interface PlanRow {
  id: string;
  sessionId: string | null;
  title: string;
  goal: string;
  stepsJson: string;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
}

export interface PlanRecord {
  id: string;
  sessionId: string | null;
  title: string;
  goal: string;
  steps: string[];
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
}

interface CreatePlanInput {
  sessionId?: string | null;
  title: string;
  goal?: string;
  steps?: string[];
}

interface ListPlansInput {
  sessionId?: string | null;
  status?: PlanStatus;
  limit?: number;
}

interface UpdatePlanInput {
  planId: string;
  title?: string;
  goal?: string;
  steps?: string[];
  status?: PlanStatus;
}

function normalizePlanStatus(value: string | undefined): PlanStatus {
  switch (value) {
    case "approved":
    case "archived":
      return value;
    case "draft":
    case undefined:
      return "draft";
    default:
      throw new Error("invalid_plan_status");
  }
}

function normalizePlanSteps(input: string[] | undefined) {
  return (input ?? []).map((step) => step.trim()).filter(Boolean);
}

function toPlanRecord(row: PlanRow): PlanRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    title: row.title,
    goal: row.goal,
    steps: JSON.parse(row.stepsJson) as string[],
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    approvedAt: row.approvedAt,
  };
}

function getPlanRow(planId: string) {
  const db = getDatabase();
  return db
    .prepare(
      `
        SELECT
          id,
          session_id AS sessionId,
          title,
          goal,
          steps_json AS stepsJson,
          status,
          created_at AS createdAt,
          updated_at AS updatedAt,
          approved_at AS approvedAt
        FROM plan_runs
        WHERE id = ?
      `,
    )
    .get(planId) as PlanRow | undefined;
}

export function getPlan(planId: string) {
  const row = getPlanRow(planId);
  return row ? toPlanRecord(row) : null;
}

export function listPlans(input: ListPlansInput = {}) {
  const db = getDatabase();
  const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 50), 200));
  const sessionId = input.sessionId?.trim() || null;

  const filters: string[] = [];
  const params: Array<string | number> = [];

  if (sessionId) {
    filters.push("session_id = ?");
    params.push(sessionId);
  }

  if (input.status) {
    filters.push("status = ?");
    params.push(input.status);
  }

  const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `
        SELECT
          id,
          session_id AS sessionId,
          title,
          goal,
          steps_json AS stepsJson,
          status,
          created_at AS createdAt,
          updated_at AS updatedAt,
          approved_at AS approvedAt
        FROM plan_runs
        ${whereClause}
        ORDER BY
          CASE status
            WHEN 'draft' THEN 0
            WHEN 'approved' THEN 1
            ELSE 2
          END,
          updated_at DESC,
          created_at DESC
        LIMIT ?
      `,
    )
    .all(...params, limit) as PlanRow[];

  return rows.map(toPlanRecord);
}

export function createPlan(input: CreatePlanInput): PlanRecord {
  const title = input.title.trim();
  if (!title) {
    throw new Error("plan_title_required");
  }

  const now = new Date().toISOString();
  const row: PlanRow = {
    id: randomUUID(),
    sessionId: input.sessionId?.trim() || null,
    title,
    goal: input.goal?.trim() || "",
    stepsJson: JSON.stringify(normalizePlanSteps(input.steps)),
    status: "draft",
    createdAt: now,
    updatedAt: now,
    approvedAt: null,
  };

  const db = getDatabase();
  db.prepare(
    `
      INSERT INTO plan_runs (
        id,
        session_id,
        title,
        goal,
        steps_json,
        status,
        created_at,
        updated_at,
        approved_at
      ) VALUES (
        @id,
        @sessionId,
        @title,
        @goal,
        @stepsJson,
        @status,
        @createdAt,
        @updatedAt,
        @approvedAt
      )
    `,
  ).run(row);

  return toPlanRecord(row);
}

export function updatePlan(input: UpdatePlanInput) {
  const existing = getPlanRow(input.planId);
  if (!existing) {
    return null;
  }

  const nextStatus = input.status ? normalizePlanStatus(input.status) : existing.status;
  const approvedAt =
    nextStatus === "approved"
      ? existing.approvedAt ?? new Date().toISOString()
      : nextStatus === "draft"
        ? null
        : existing.approvedAt;
  const updatedAt = new Date().toISOString();
  const nextTitle = input.title !== undefined ? input.title.trim() : existing.title;
  if (!nextTitle) {
    throw new Error("plan_title_required");
  }

  const nextGoal = input.goal !== undefined ? input.goal.trim() : existing.goal;
  const nextStepsJson = input.steps !== undefined ? JSON.stringify(normalizePlanSteps(input.steps)) : existing.stepsJson;

  const db = getDatabase();
  db.prepare(
    `
      UPDATE plan_runs
      SET
        title = ?,
        goal = ?,
        steps_json = ?,
        status = ?,
        updated_at = ?,
        approved_at = ?
      WHERE id = ?
    `,
  ).run(nextTitle, nextGoal, nextStepsJson, nextStatus, updatedAt, approvedAt, input.planId);

  return toPlanRecord({
    ...existing,
    title: nextTitle,
    goal: nextGoal,
    stepsJson: nextStepsJson,
    status: nextStatus,
    updatedAt,
    approvedAt,
  });
}

export function approvePlan(planId: string) {
  return updatePlan({
    planId,
    status: "approved",
  });
}

export function archivePlan(planId: string) {
  return updatePlan({
    planId,
    status: "archived",
  });
}

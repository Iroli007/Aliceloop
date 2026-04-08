import type { SessionPlanModeState } from "@aliceloop/runtime-core";
import { getDatabase } from "../db/client";
import { createPlan, getPlan, listPlans } from "./planRepository";

interface SessionPlanModeRow {
  sessionId: string;
  active: number;
  activePlanId: string | null;
  enteredAt: string | null;
  updatedAt: string;
}

interface EnterSessionPlanModeInput {
  sessionId: string;
  planId?: string | null;
  title?: string | null;
}

function createInactivePlanModeState(sessionId: string): SessionPlanModeState {
  return {
    sessionId,
    active: false,
    activePlanId: null,
    enteredAt: null,
    updatedAt: null,
  };
}

function mapPlanModeRow(row: SessionPlanModeRow | undefined, sessionId: string): SessionPlanModeState {
  if (!row) {
    return createInactivePlanModeState(sessionId);
  }

  return {
    sessionId,
    active: row.active === 1,
    activePlanId: row.activePlanId,
    enteredAt: row.enteredAt,
    updatedAt: row.updatedAt,
  };
}

function getSessionRow(sessionId: string) {
  const db = getDatabase();
  return db.prepare(
    `
      SELECT id, title
      FROM sessions
      WHERE id = ?
      LIMIT 1
    `,
  ).get(sessionId) as { id: string; title: string } | undefined;
}

function getPlanModeRow(sessionId: string) {
  const db = getDatabase();
  return db.prepare(
    `
      SELECT
        session_id AS sessionId,
        active,
        active_plan_id AS activePlanId,
        entered_at AS enteredAt,
        updated_at AS updatedAt
      FROM session_plan_modes
      WHERE session_id = ?
      LIMIT 1
    `,
  ).get(sessionId) as SessionPlanModeRow | undefined;
}

function assertSessionExists(sessionId: string) {
  const session = getSessionRow(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} was not found`);
  }

  return session;
}

function resolvePlanForEnter(input: EnterSessionPlanModeInput) {
  if (input.planId?.trim()) {
    const plan = getPlan(input.planId.trim());
    if (!plan) {
      throw new Error(`Plan ${input.planId.trim()} was not found`);
    }
    if (plan.sessionId && plan.sessionId !== input.sessionId) {
      throw new Error("plan_mode_plan_session_mismatch");
    }
    return plan;
  }

  const existingDraft = listPlans({
    sessionId: input.sessionId,
    status: "draft",
    limit: 1,
  })[0];
  if (existingDraft) {
    return existingDraft;
  }

  const session = assertSessionExists(input.sessionId);
  return createPlan({
    sessionId: input.sessionId,
    title: input.title?.trim() || `${session.title} 计划`,
  });
}

export function getSessionPlanModeState(sessionId: string) {
  assertSessionExists(sessionId);
  return mapPlanModeRow(getPlanModeRow(sessionId), sessionId);
}

export function enterSessionPlanMode(input: EnterSessionPlanModeInput) {
  assertSessionExists(input.sessionId);
  const plan = resolvePlanForEnter(input);
  const now = new Date().toISOString();
  const db = getDatabase();

  db.prepare(
    `
      INSERT INTO session_plan_modes (
        session_id,
        active,
        active_plan_id,
        entered_at,
        updated_at
      ) VALUES (?, 1, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        active = 1,
        active_plan_id = excluded.active_plan_id,
        entered_at = excluded.entered_at,
        updated_at = excluded.updated_at
    `,
  ).run(input.sessionId, plan.id, now, now);

  return mapPlanModeRow(getPlanModeRow(input.sessionId), input.sessionId);
}

export function exitSessionPlanMode(sessionId: string) {
  assertSessionExists(sessionId);
  const existing = getPlanModeRow(sessionId);
  if (!existing) {
    return createInactivePlanModeState(sessionId);
  }

  const now = new Date().toISOString();
  const db = getDatabase();
  db.prepare(
    `
      UPDATE session_plan_modes
      SET active = 0,
          updated_at = ?
      WHERE session_id = ?
    `,
  ).run(now, sessionId);

  return mapPlanModeRow(getPlanModeRow(sessionId), sessionId);
}

export function touchSessionPlanModeUpdatedAt(sessionId: string) {
  assertSessionExists(sessionId);
  const existing = getPlanModeRow(sessionId);
  if (!existing) {
    return createInactivePlanModeState(sessionId);
  }

  const now = new Date().toISOString();
  const db = getDatabase();
  db.prepare(
    `
      UPDATE session_plan_modes
      SET updated_at = ?
      WHERE session_id = ?
    `,
  ).run(now, sessionId);

  return mapPlanModeRow(getPlanModeRow(sessionId), sessionId);
}

import { randomUUID } from "node:crypto";
import { getDatabase } from "../db/client";

export interface ProviderReasoningTrace {
  id: string;
  sessionId: string;
  providerId: string;
  model: string;
  toolCallId: string;
  reasoningContent: string;
  reasoningSummary: string;
  createdAt: string;
  updatedAt: string;
}

interface ProviderReasoningTraceRow {
  id: string;
  session_id: string;
  provider_id: string;
  model: string;
  tool_call_id: string;
  reasoning_content: string;
  reasoning_summary: string;
  created_at: string;
  updated_at: string;
}

function summarizeReasoningContent(value: string) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= 280) {
    return normalized;
  }

  return `${normalized.slice(0, 277)}...`;
}

function mapRow(row: ProviderReasoningTraceRow): ProviderReasoningTrace {
  return {
    id: row.id,
    sessionId: row.session_id,
    providerId: row.provider_id,
    model: row.model,
    toolCallId: row.tool_call_id,
    reasoningContent: row.reasoning_content,
    reasoningSummary: row.reasoning_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertProviderReasoningTrace(input: {
  sessionId: string;
  providerId: string;
  model: string;
  toolCallId: string;
  reasoningContent: string;
}) {
  const reasoningContent = input.reasoningContent.trim();
  if (!reasoningContent || !input.toolCallId.trim()) {
    return null;
  }

  const db = getDatabase();
  const now = new Date().toISOString();
  const existing = db.prepare(
    `
      SELECT *
      FROM provider_reasoning_traces
      WHERE session_id = ?
        AND provider_id = ?
        AND tool_call_id = ?
    `,
  ).get(input.sessionId, input.providerId, input.toolCallId) as ProviderReasoningTraceRow | undefined;

  const id = existing?.id ?? randomUUID();
  const createdAt = existing?.created_at ?? now;
  const summary = summarizeReasoningContent(reasoningContent);

  db.prepare(
    `
      INSERT INTO provider_reasoning_traces (
        id, session_id, provider_id, model, tool_call_id, reasoning_content, reasoning_summary, created_at, updated_at
      ) VALUES (
        @id, @sessionId, @providerId, @model, @toolCallId, @reasoningContent, @reasoningSummary, @createdAt, @updatedAt
      )
      ON CONFLICT(session_id, provider_id, tool_call_id)
      DO UPDATE SET
        model = excluded.model,
        reasoning_content = excluded.reasoning_content,
        reasoning_summary = excluded.reasoning_summary,
        updated_at = excluded.updated_at
    `,
  ).run({
    id,
    sessionId: input.sessionId,
    providerId: input.providerId,
    model: input.model,
    toolCallId: input.toolCallId,
    reasoningContent,
    reasoningSummary: summary,
    createdAt,
    updatedAt: now,
  });

  return {
    id,
    sessionId: input.sessionId,
    providerId: input.providerId,
    model: input.model,
    toolCallId: input.toolCallId,
    reasoningContent,
    reasoningSummary: summary,
    createdAt,
    updatedAt: now,
  };
}

export function getProviderReasoningTrace(input: {
  sessionId: string;
  providerId: string;
  toolCallId: string;
}) {
  const row = getDatabase().prepare(
    `
      SELECT *
      FROM provider_reasoning_traces
      WHERE session_id = ?
        AND provider_id = ?
        AND tool_call_id = ?
    `,
  ).get(input.sessionId, input.providerId, input.toolCallId) as ProviderReasoningTraceRow | undefined;

  return row ? mapRow(row) : null;
}

export function listProviderReasoningTracesForToolCalls(input: {
  sessionId: string;
  providerId: string;
  toolCallIds: string[];
}) {
  const toolCallIds = [...new Set(input.toolCallIds.map((id) => id.trim()).filter(Boolean))];
  if (toolCallIds.length === 0) {
    return [];
  }

  const placeholders = toolCallIds.map(() => "?").join(", ");
  const rows = getDatabase().prepare(
    `
      SELECT *
      FROM provider_reasoning_traces
      WHERE session_id = ?
        AND provider_id = ?
        AND tool_call_id IN (${placeholders})
      ORDER BY created_at ASC
    `,
  ).all(input.sessionId, input.providerId, ...toolCallIds) as ProviderReasoningTraceRow[];

  return rows.map(mapRow);
}

import { getDatabase } from "../db/client";

export type OpenTaskStatus = "running" | "waiting_result" | "completed" | "needs_retry";

export interface OpenTaskRecord {
  sessionId: string;
  ownerTool: string;
  status: OpenTaskStatus;
  summary: string;
  toolCallId: string | null;
  toolInput: string;
  toolOutput: string;
  childAgentId: string | null;
  subagentType: string | null;
  persona: string | null;
  updatedAt: string;
}

interface OpenTaskRow {
  session_id: string;
  owner_tool: string;
  status: OpenTaskStatus;
  summary: string;
  tool_call_id: string | null;
  tool_input: string;
  tool_output: string;
  child_agent_id: string | null;
  subagent_type: string | null;
  persona: string | null;
  updated_at: string;
}

function mapRow(row: OpenTaskRow): OpenTaskRecord {
  return {
    sessionId: row.session_id,
    ownerTool: row.owner_tool,
    status: row.status,
    summary: row.summary,
    toolCallId: row.tool_call_id,
    toolInput: row.tool_input,
    toolOutput: row.tool_output,
    childAgentId: row.child_agent_id,
    subagentType: row.subagent_type,
    persona: row.persona,
    updatedAt: row.updated_at,
  };
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readBoolean(record: Record<string, unknown> | null, key: string) {
  const value = record?.[key];
  return typeof value === "boolean" ? value : false;
}

function serialize(value: unknown) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function summarizeToolInput(toolName: string, toolInput: unknown) {
  const record = asRecord(toolInput);
  if (toolName === "agent") {
    return readString(record, "description")
      ?? readString(record, "prompt")
      ?? "child agent task";
  }

  if (toolName === "bash") {
    return readString(record, "script")
      ?? readString(record, "command")
      ?? "shell command";
  }

  if (toolName === "web_search") {
    return readString(record, "query") ?? "web search";
  }

  if (toolName === "web_fetch") {
    return readString(record, "url") ?? "web fetch";
  }

  return `${toolName} task`;
}

function readAgentChildId(record: Record<string, unknown> | null) {
  return readString(record, "agent_id")
    ?? readString(record, "agentId")
    ?? readString(record, "childAgentId")
    ?? readString(record, "childSessionId")
    ?? readString(record, "sessionId");
}

export function getSessionOpenTask(sessionId: string): OpenTaskRecord | null {
  const row = getDatabase()
    .prepare(`
      SELECT
        session_id,
        owner_tool,
        status,
        summary,
        tool_call_id,
        tool_input,
        tool_output,
        child_agent_id,
        subagent_type,
        persona,
        updated_at
      FROM session_open_tasks
      WHERE session_id = ?
    `)
    .get(sessionId) as OpenTaskRow | undefined;

  return row ? mapRow(row) : null;
}

export function upsertSessionOpenTask(input: {
  sessionId: string;
  ownerTool: string;
  status: OpenTaskStatus;
  summary: string;
  toolCallId?: string | null;
  toolInput?: unknown;
  toolOutput?: unknown;
  childAgentId?: string | null;
  subagentType?: string | null;
  persona?: string | null;
}) {
  const updatedAt = new Date().toISOString();
  getDatabase()
    .prepare(`
      INSERT INTO session_open_tasks (
        session_id,
        owner_tool,
        status,
        summary,
        tool_call_id,
        tool_input,
        tool_output,
        child_agent_id,
        subagent_type,
        persona,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        owner_tool = excluded.owner_tool,
        status = excluded.status,
        summary = excluded.summary,
        tool_call_id = excluded.tool_call_id,
        tool_input = excluded.tool_input,
        tool_output = excluded.tool_output,
        child_agent_id = excluded.child_agent_id,
        subagent_type = excluded.subagent_type,
        persona = excluded.persona,
        updated_at = excluded.updated_at
    `)
    .run(
      input.sessionId,
      input.ownerTool,
      input.status,
      input.summary,
      input.toolCallId ?? null,
      serialize(input.toolInput),
      serialize(input.toolOutput),
      input.childAgentId ?? null,
      input.subagentType ?? null,
      input.persona ?? null,
      updatedAt,
    );
}

export function recordToolCallStarted(sessionId: string, toolName: string, toolCallId: string, toolInput: unknown) {
  const record = asRecord(toolInput);
  const status: OpenTaskStatus = toolName === "agent" && readBoolean(record, "run_in_background")
    ? "waiting_result"
    : "running";

  upsertSessionOpenTask({
    sessionId,
    ownerTool: toolName,
    status,
    summary: summarizeToolInput(toolName, toolInput),
    toolCallId,
    toolInput,
    childAgentId: toolName === "agent" ? readString(record, "resume") : null,
    subagentType: toolName === "agent" ? readString(record, "subagent_type") : null,
    persona: toolName === "agent" ? readString(record, "persona") : null,
  });
}

export function recordToolCallCompleted(input: {
  sessionId: string;
  toolName: string;
  toolCallId: string;
  success: boolean;
  output?: unknown;
  error?: unknown;
}) {
  const current = getSessionOpenTask(input.sessionId);
  if (current?.toolCallId && current.toolCallId !== input.toolCallId) {
    return;
  }

  const result = input.success ? input.output : input.error;
  const inputRecord = current ? asRecord(JSON.parse(current.toolInput || "{}")) : null;
  const outputRecord = asRecord(input.output);
  const agentStatus = readString(outputRecord, "status");
  const status: OpenTaskStatus = input.success
    ? input.toolName === "agent" && agentStatus === "async_launched"
      ? "waiting_result"
      : "completed"
    : "needs_retry";

  upsertSessionOpenTask({
    sessionId: input.sessionId,
    ownerTool: input.toolName,
    status,
    summary: current?.summary ?? summarizeToolInput(input.toolName, inputRecord ?? {}),
    toolCallId: input.toolCallId,
    toolInput: inputRecord ?? {},
    toolOutput: result,
    childAgentId: input.toolName === "agent"
      ? readAgentChildId(outputRecord) ?? current?.childAgentId ?? null
      : null,
    subagentType: input.toolName === "agent"
      ? readString(outputRecord, "subagent_type") ?? current?.subagentType ?? null
      : null,
    persona: input.toolName === "agent"
      ? readString(outputRecord, "persona") ?? current?.persona ?? null
      : null,
  });
}

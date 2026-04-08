import { randomUUID } from "node:crypto";
import {
  createDelegatedTask,
  getDelegatedTask,
  updateDelegatedTaskStatus,
  type DelegatedTaskRole,
  type DelegatedTaskRun,
  type DelegatedTaskStatus,
} from "../repositories/delegatedTaskRepository";
import {
  createSession,
  createSessionMessage,
  getSessionProjectBinding,
  getSessionSnapshot,
} from "../repositories/sessionRepository";
import { runProviderReply } from "./providerRunner";

const BACKGROUND_POLL_INTERVAL_MS = 500;
const BACKGROUND_WAIT_TIMEOUT_MS = 20 * 60 * 1000;
const TASK_DEVICE_ID = "task-delegation-runtime";

export interface TaskDelegationInput {
  sessionId: string;
  type: DelegatedTaskRole;
  prompt: string;
  runInBackground?: boolean;
}

export interface DelegatedTaskOutput {
  task_id: string;
  status: DelegatedTaskStatus;
  result?: string;
  error?: string;
}

function summarizePrompt(value: string, maxLength = 56) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Untitled task";
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trimEnd()}...` : normalized;
}

function buildTaskTitle(type: DelegatedTaskRole, prompt: string) {
  return `Task delegation · ${type} · ${summarizePrompt(prompt)}`;
}

function buildRoleInstruction(type: DelegatedTaskRole) {
  switch (type) {
    case "coder":
      return "Act as a coding sub-agent. Inspect the codebase, implement or debug when appropriate, and include verification notes in your final answer.";
    case "plan":
      return "Act as a planning sub-agent. Analyze, structure the work, and return a concrete plan. Do not make repository edits unless the assignment explicitly asks for them.";
    case "researcher":
      return "Act as a research sub-agent. Investigate the question, gather evidence, and return a concise, source-aware summary.";
    case "general-purpose":
    default:
      return "Act as a general-purpose sub-agent. Complete the assignment directly and return a concise handoff for the parent agent.";
  }
}

function buildDelegatedPrompt(type: DelegatedTaskRole, prompt: string) {
  return [
    "You are a delegated sub-agent working on behalf of another Aliceloop agent.",
    buildRoleInstruction(type),
    "Stay tightly focused on the assigned task.",
    "Work in this isolated thread and do not mention internal delegation mechanics unless the task requires it.",
    "Do not delegate further sub-tasks from this delegated run.",
    "Return a concise final answer that the parent agent can relay directly.",
    "",
    "Assigned task:",
    prompt.trim(),
  ].join("\n");
}

function getLatestAssistantMessageContent(sessionId: string) {
  const snapshot = getSessionSnapshot(sessionId);
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index];
    if (message.role !== "assistant") {
      continue;
    }
    const content = message.content.trim();
    if (content) {
      return content;
    }
  }

  return "";
}

function getLatestProviderJob(sessionId: string) {
  const snapshot = getSessionSnapshot(sessionId);
  return snapshot.jobs.find((job) => job.kind === "provider-completion") ?? null;
}

function resolveDelegatedTaskStatus(task: DelegatedTaskRun): DelegatedTaskOutput {
  const providerJob = getLatestProviderJob(task.childSessionId);
  const result = getLatestAssistantMessageContent(task.childSessionId);

  if (providerJob?.status === "failed") {
    if (task.status !== "failed") {
      updateDelegatedTaskStatus(task.id, "failed");
    }
    return {
      task_id: task.id,
      status: "failed",
      error: providerJob.detail.trim() || "Delegated task failed.",
    };
  }

  if (providerJob?.status === "done") {
    if (task.status !== "completed") {
      updateDelegatedTaskStatus(task.id, "completed");
    }
    return {
      task_id: task.id,
      status: "completed",
      ...(result ? { result } : {}),
    };
  }

  if (providerJob?.status === "running") {
    if (task.status !== "running") {
      updateDelegatedTaskStatus(task.id, "running");
    }
    return {
      task_id: task.id,
      status: "running",
    };
  }

  if (providerJob?.status === "queued") {
    if (task.status !== "queued") {
      updateDelegatedTaskStatus(task.id, "queued");
    }
    return {
      task_id: task.id,
      status: "queued",
    };
  }

  return {
    task_id: task.id,
    status: task.status,
  };
}

async function waitForDelegatedTask(taskId: string, timeoutMs = BACKGROUND_WAIT_TIMEOUT_MS) {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const current = getDelegatedTask(taskId);
    if (!current) {
      throw new Error(`Delegated task not found: ${taskId}`);
    }

    const resolved = resolveDelegatedTaskStatus(current);
    if (resolved.status === "completed" || resolved.status === "failed") {
      return resolved;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, BACKGROUND_POLL_INTERVAL_MS);
    });
  }

  throw new Error(`Timed out while waiting for delegated task ${taskId}`);
}

function normalizeDelegatedTaskType(value: string): DelegatedTaskRole {
  switch (value.trim()) {
    case "coder":
      return "coder";
    case "plan":
    case "Plan":
    case "planner":
      return "plan";
    case "researcher":
      return "researcher";
    case "general-purpose":
    default:
      return "general-purpose";
  }
}

export function normalizeTaskDelegationType(value: string) {
  return normalizeDelegatedTaskType(value);
}

export async function runTaskDelegation(input: TaskDelegationInput): Promise<DelegatedTaskOutput> {
  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new Error("Delegated task prompt is required.");
  }

  const projectBinding = getSessionProjectBinding(input.sessionId);
  const role = normalizeDelegatedTaskType(input.type);
  const childSession = createSession({
    title: buildTaskTitle(role, prompt),
    projectId: projectBinding?.projectId ?? null,
  });
  const task = createDelegatedTask({
    sessionId: input.sessionId,
    title: childSession.title,
    objective: prompt,
    role,
    childSessionId: childSession.id,
    status: "queued",
  });

  createSessionMessage({
    sessionId: childSession.id,
    clientMessageId: `task-delegation-${task.id}-${randomUUID()}`,
    content: buildDelegatedPrompt(role, prompt),
    role: "user",
    attachmentIds: [],
    deviceId: TASK_DEVICE_ID,
  });

  updateDelegatedTaskStatus(task.id, "running");
  const runPromise = runProviderReply(childSession.id)
    .then(() => waitForSettledDelegatedTask(task.id))
    .catch((error) => {
      const message = error instanceof Error ? error.message : "Delegated task failed.";
      updateDelegatedTaskStatus(task.id, "failed");
      return {
        task_id: task.id,
        status: "failed" as const,
        error: message,
      };
    });

  if (input.runInBackground) {
    void runPromise;
    return {
      task_id: task.id,
      status: "running",
    };
  }

  return runPromise;
}

async function waitForSettledDelegatedTask(taskId: string) {
  const task = getDelegatedTask(taskId);
  if (!task) {
    throw new Error(`Delegated task not found: ${taskId}`);
  }

  const resolved = resolveDelegatedTaskStatus(task);
  if (resolved.status === "completed" || resolved.status === "failed") {
    return resolved;
  }

  return waitForDelegatedTask(taskId);
}

export async function getTaskDelegationOutput(taskId: string, wait = false): Promise<DelegatedTaskOutput> {
  const task = getDelegatedTask(taskId);
  if (!task) {
    throw new Error(`Delegated task not found: ${taskId}`);
  }

  if (wait) {
    return waitForDelegatedTask(taskId);
  }

  return resolveDelegatedTaskStatus(task);
}

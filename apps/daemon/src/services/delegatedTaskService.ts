import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type JobRunDetail, type SessionEvent, type TaskNotification } from "@aliceloop/runtime-core";
import { getDataDir } from "../db/client";
import {
  createDelegatedTask,
  getDelegatedTask,
  updateDelegatedTaskStatus,
  type DelegatedTaskRole,
  type DelegatedTaskRun,
  type DelegatedTaskStatus,
} from "../repositories/delegatedTaskRepository";
import {
  appendSessionEvent,
  createSession,
  createSessionMessage,
  getSessionProjectBinding,
  getSessionSnapshot,
} from "../repositories/sessionRepository";
import { publishSessionEvent, subscribeToSession } from "../realtime/sessionStreams";
import { runProviderReply } from "./providerRunner";
import { syncSessionProjectHistory } from "./sessionProjectService";

const BACKGROUND_POLL_INTERVAL_MS = 500;
const FOREGROUND_WAIT_TIMEOUT_MS = 20 * 60 * 1000;
const TASK_DEVICE_ID = "task-delegation-runtime";

export interface TaskDelegationInput {
  sessionId: string;
  type?: DelegatedTaskRole;
  name?: string;
  prompt: string;
  handoff?: {
    goal?: string;
    context?: string[];
    artifactRefs?: string[];
  };
  runInBackground?: boolean;
  abortSignal?: AbortSignal;
}

export interface DelegatedTaskOutput {
  task_id: string;
  status: DelegatedTaskStatus;
  output_path: string;
  result?: string;
  error?: string;
  timed_out?: boolean;
}

function summarizePrompt(value: string, maxLength = 56) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Untitled task";
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trimEnd()}...` : normalized;
}

function buildTaskTitle(role: DelegatedTaskRole, prompt: string, name?: string) {
  const label = name?.trim() || summarizePrompt(prompt);
  if (role === "general-purpose") {
    return `Agent · ${label}`;
  }
  return `Agent · ${role} · ${label}`;
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

function buildSubagentPrompt(
  type: DelegatedTaskRole,
  prompt: string,
  handoff?: {
    goal?: string;
    context?: string[];
    artifactRefs?: string[];
  },
) {
  const goal = handoff?.goal?.trim() || null;
  const contextLines = (handoff?.context ?? []).map((item) => item.trim()).filter(Boolean);
  const artifactRefs = (handoff?.artifactRefs ?? []).map((item) => item.trim()).filter(Boolean);

  return [
    "You are a delegated sub-agent working on behalf of another Aliceloop agent.",
    buildRoleInstruction(type),
    "You do not automatically inherit the parent conversation history.",
    "Only rely on the explicit handoff provided below.",
    "Stay tightly focused on the assigned task.",
    "Work in this isolated thread and do not mention internal delegation mechanics unless the task requires it.",
    "Do not delegate further sub-tasks from this delegated run.",
    "Return a concise final answer that the parent agent can relay directly.",
    "",
    goal ? `Goal: ${goal}` : null,
    contextLines.length > 0
      ? [
        "Explicit context:",
        ...contextLines.map((line) => `- ${line}`),
      ].join("\n")
      : null,
    artifactRefs.length > 0
      ? [
        "Relevant artifacts:",
        ...artifactRefs.map((line) => `- ${line}`),
      ].join("\n")
      : null,
    "Assigned task:",
    prompt.trim(),
  ].filter((line): line is string => typeof line === "string" && line.length > 0).join("\n");
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

function getDelegatedTaskOutputPath(taskId: string) {
  return join(getDataDir(), "delegated-tasks", `${taskId}.md`);
}

function summarizeDelegatedOutput(value: string, maxLength = 240) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trimEnd()}...` : normalized;
}

function withOutputPath(taskId: string, output: Omit<DelegatedTaskOutput, "output_path">): DelegatedTaskOutput {
  return {
    ...output,
    output_path: getDelegatedTaskOutputPath(taskId),
  };
}

function buildDelegatedOutputDocument(task: DelegatedTaskRun, output: DelegatedTaskOutput) {
  const lines = [
    `# Delegated Task Output`,
    "",
    `- Task ID: ${task.id}`,
    `- Role: ${task.role}`,
    `- Status: ${output.status}`,
    `- Parent Session: ${task.sessionId ?? "n/a"}`,
    `- Child Session: ${task.childSessionId}`,
    `- Updated At: ${task.updatedAt}`,
  ];

  if (task.completedAt) {
    lines.push(`- Completed At: ${task.completedAt}`);
  }

  lines.push(
    "",
    "## Objective",
    task.objective,
  );

  if (output.result) {
    lines.push(
      "",
      "## Result",
      output.result,
    );
  }

  if (output.error) {
    lines.push(
      "",
      "## Error",
      output.error,
    );
  }

  if (output.timed_out) {
    lines.push(
      "",
      "## Note",
      "The blocking status check timed out before the delegated task reached a terminal state.",
    );
  }

  return `${lines.join("\n")}\n`;
}

async function writeDelegatedOutputFile(task: DelegatedTaskRun, output: DelegatedTaskOutput) {
  const outputPath = output.output_path;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, buildDelegatedOutputDocument(task, output), "utf8");
}

async function publishDelegatedCompletionNotice(task: DelegatedTaskRun, output: DelegatedTaskOutput) {
  if (!task.sessionId) {
    return;
  }

  const preview = summarizeDelegatedOutput(output.result ?? output.error ?? "");
  const notification: TaskNotification = {
    id: `task-notification-${task.id}`,
    taskId: task.id,
    role: task.role === "general-purpose" ? null : task.role,
    status: output.status === "failed" ? "failed" : "completed",
    title: task.title,
    objective: task.objective,
    outputPath: output.output_path,
    preview: preview || null,
    childSessionId: task.childSessionId,
    createdAt: new Date().toISOString(),
  };
  const event = appendSessionEvent(
    task.sessionId,
    "task.notification",
    { notification },
    notification.createdAt,
  );
  publishSessionEvent(event);

  await syncSessionProjectHistory(task.sessionId);
}

function resolveDelegatedTaskStatus(task: DelegatedTaskRun): DelegatedTaskOutput {
  const providerJob = getLatestProviderJob(task.childSessionId);
  const result = getLatestAssistantMessageContent(task.childSessionId);

  if (providerJob?.status === "failed") {
    if (task.status !== "failed") {
      updateDelegatedTaskStatus(task.id, "failed");
    }
    return withOutputPath(task.id, {
      task_id: task.id,
      status: "failed",
      error: providerJob.detail.trim() || "Delegated task failed.",
    });
  }

  if (providerJob?.status === "done") {
    if (task.status !== "completed") {
      updateDelegatedTaskStatus(task.id, "completed");
    }
    return withOutputPath(task.id, {
      task_id: task.id,
      status: "completed",
      ...(result ? { result } : {}),
    });
  }

  if (providerJob?.status === "running") {
    if (task.status !== "running") {
      updateDelegatedTaskStatus(task.id, "running");
    }
    return withOutputPath(task.id, {
      task_id: task.id,
      status: "running",
    });
  }

  if (providerJob?.status === "queued") {
    if (task.status !== "queued") {
      updateDelegatedTaskStatus(task.id, "queued");
    }
    return withOutputPath(task.id, {
      task_id: task.id,
      status: "queued",
    });
  }

  return withOutputPath(task.id, {
    task_id: task.id,
    status: task.status,
  });
}

function waitForAbort(abortSignal: AbortSignal) {
  return new Promise<never>((_, reject) => {
    const handleAbort = () => {
      abortSignal.removeEventListener("abort", handleAbort);
      reject(new Error("Delegated task wait was interrupted."));
    };

    if (abortSignal.aborted) {
      handleAbort();
      return;
    }

    abortSignal.addEventListener("abort", handleAbort, { once: true });
  });
}

function waitForForegroundResult<T>(promise: Promise<T>, abortSignal?: AbortSignal) {
  if (!abortSignal) {
    return promise;
  }

  return Promise.race([
    promise,
    waitForAbort(abortSignal),
  ]);
}

async function waitForDelegatedTaskByPolling(taskId: string, timeoutMs: number, returnCurrentOnTimeout = false) {
  const startedAt = Date.now();
  let latestResolved: DelegatedTaskOutput | null = null;
  let latestTask: DelegatedTaskRun | null = null;

  while (Date.now() - startedAt <= timeoutMs) {
    const current = getDelegatedTask(taskId);
    if (!current) {
      throw new Error(`Delegated task not found: ${taskId}`);
    }

    latestTask = current;
    const resolved = resolveDelegatedTaskStatus(current);
    latestResolved = resolved;
    if (resolved.status === "completed" || resolved.status === "failed") {
      await writeDelegatedOutputFile(getDelegatedTask(taskId) ?? current, resolved);
      return resolved;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, BACKGROUND_POLL_INTERVAL_MS);
    });
  }

  if (returnCurrentOnTimeout) {
    const timedOut = {
      ...(latestResolved ?? withOutputPath(taskId, { task_id: taskId, status: "running" as const })),
      timed_out: true,
    };
    if (latestTask) {
      await writeDelegatedOutputFile(getDelegatedTask(taskId) ?? latestTask, timedOut);
    }
    return timedOut;
  }

  throw new Error(`Timed out while waiting for delegated task ${taskId}`);
}

function isProviderCompletionEvent(event: SessionEvent) {
  if (event.type !== "job.updated") {
    return false;
  }

  const job = (event.payload as { job?: JobRunDetail }).job;
  return job?.kind === "provider-completion";
}

async function waitForDelegatedTask(taskId: string, timeoutMs: number, returnCurrentOnTimeout = false, abortSignal?: AbortSignal) {
  const initialTask = getDelegatedTask(taskId);
  if (!initialTask) {
    throw new Error(`Delegated task not found: ${taskId}`);
  }

  const initialResolved = resolveDelegatedTaskStatus(initialTask);
  if (initialResolved.status === "completed" || initialResolved.status === "failed") {
    await writeDelegatedOutputFile(getDelegatedTask(taskId) ?? initialTask, initialResolved);
    return initialResolved;
  }

  return new Promise<DelegatedTaskOutput>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;

    const cleanup = () => {
      unsubscribe();
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (abortSignal) {
        abortSignal.removeEventListener("abort", handleAbort);
      }
    };

    const settleWith = async (output: DelegatedTaskOutput) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();

      try {
        await writeDelegatedOutputFile(getDelegatedTask(taskId) ?? initialTask, output);
        resolve(output);
      } catch (error) {
        reject(error);
      }
    };

    const failWith = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const inspectCurrent = async () => {
      const current = getDelegatedTask(taskId);
      if (!current) {
        failWith(new Error(`Delegated task not found: ${taskId}`));
        return;
      }

      const resolved = resolveDelegatedTaskStatus(current);
      if (resolved.status === "completed" || resolved.status === "failed") {
        await settleWith(resolved);
      }
    };

    const handleAbort = () => {
      failWith(new Error("Delegated task wait was interrupted."));
    };

    const unsubscribe = subscribeToSession(initialTask.childSessionId, (event) => {
      if (!isProviderCompletionEvent(event)) {
        return;
      }

      void inspectCurrent();
    });

    if (abortSignal?.aborted) {
      handleAbort();
      return;
    }

    if (abortSignal) {
      abortSignal.addEventListener("abort", handleAbort, { once: true });
    }

    timeoutHandle = setTimeout(() => {
      void (async () => {
        try {
          const fallback = await waitForDelegatedTaskByPolling(
            taskId,
            BACKGROUND_POLL_INTERVAL_MS * 2,
            returnCurrentOnTimeout,
          );
          await settleWith(fallback);
        } catch (error) {
          failWith(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    }, timeoutMs);

    void inspectCurrent();
  });
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

export function normalizeAgentSubagentType(value: string) {
  return normalizeDelegatedTaskType(value);
}

export async function runTaskDelegation(input: TaskDelegationInput): Promise<DelegatedTaskOutput> {
  const prompt = input.prompt.trim();
  if (!prompt) {
    throw new Error("Delegated task prompt is required.");
  }

  const projectBinding = getSessionProjectBinding(input.sessionId);
  const role = normalizeDelegatedTaskType(input.type ?? "general-purpose");
  const childSession = createSession({
    title: buildTaskTitle(role, prompt, input.name),
    projectId: projectBinding?.projectId ?? null,
    hidden: true,
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
    content: buildSubagentPrompt(role, prompt, input.handoff),
    role: "user",
    attachmentIds: [],
    deviceId: TASK_DEVICE_ID,
  });

  updateDelegatedTaskStatus(task.id, "running");
  await writeDelegatedOutputFile(getDelegatedTask(task.id) ?? task, withOutputPath(task.id, {
    task_id: task.id,
    status: "running",
  }));
  const runPromise = runProviderReply(childSession.id)
    .then(() => waitForSettledDelegatedTask(task.id))
    .catch((error) => {
      const message = error instanceof Error ? error.message : "Delegated task failed.";
      updateDelegatedTaskStatus(task.id, "failed");
      return withOutputPath(task.id, {
        task_id: task.id,
        status: "failed" as const,
        error: message,
      });
    });
  const finalizedPromise = runPromise.then(async (output) => {
    const currentTask = getDelegatedTask(task.id) ?? task;
    await writeDelegatedOutputFile(currentTask, output);
    if (input.runInBackground) {
      await publishDelegatedCompletionNotice(currentTask, output);
    }
    return output;
  });

  if (input.runInBackground) {
    void finalizedPromise;
    return withOutputPath(task.id, {
      task_id: task.id,
      status: "running",
    });
  }

  return waitForForegroundResult(finalizedPromise, input.abortSignal);
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

  return waitForDelegatedTask(taskId, FOREGROUND_WAIT_TIMEOUT_MS);
}

export async function getTaskDelegationOutput(taskId: string, wait = false, abortSignal?: AbortSignal, timeoutMs = 30_000): Promise<DelegatedTaskOutput> {
  const task = getDelegatedTask(taskId);
  if (!task) {
    throw new Error(`Delegated task not found: ${taskId}`);
  }

  if (wait) {
    return waitForDelegatedTask(taskId, timeoutMs, true, abortSignal);
  }

  const resolved = resolveDelegatedTaskStatus(task);
  await writeDelegatedOutputFile(getDelegatedTask(task.id) ?? task, resolved);
  return resolved;
}

import { randomUUID } from "node:crypto";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { publishSessionEvent } from "../../realtime/sessionStreams";
import {
  createSession,
  createSessionMessage,
  getChildAgentSession,
  getChildAgentSessionByChildId,
  getSessionProjectBinding,
  getSessionSnapshot,
  hasSession,
  upsertChildAgentSession,
  type ChildAgentRecord,
} from "../../repositories/sessionRepository";
import { syncSessionProjectHistory } from "../../services/sessionProjectService";

const DEFAULT_SESSION_ID = "agent";
const subagentTypes = [
  "general-purpose",
  "coder",
  "Plan",
  "Explore",
  "alma-guide",
  "alma-operator",
  "statusline-setup",
  "developer",
  "designer",
  "researcher",
  "product-manager",
  "operator",
  "planner",
  "evaluator",
] as const;
const writeBackKinds = ["summary", "artifact", "decision", "patch"] as const;
const outputPollIntervalMs = 300;

type SubagentType = typeof subagentTypes[number];

const subagentTypeBriefs: Record<SubagentType, string> = {
  "general-purpose": "Handle a broad delegated task with balanced reasoning and concise reporting.",
  coder: "Act as a coding agent. Inspect the relevant files, make scoped edits when asked, and report changed paths.",
  Plan: "Act as a planning agent. Produce an actionable plan, risks, dependencies, and next steps.",
  Explore: "Act as an exploration agent. Gather context, identify relevant files or facts, and avoid unnecessary edits.",
  "alma-guide": "Act as an Alma guide. Explain the path forward clearly and keep the handoff easy to follow.",
  "alma-operator": "Act as an Alma operator. Execute the assigned workflow carefully and report operational status.",
  "statusline-setup": "Act as a statusline setup specialist. Focus on shell/editor statusline configuration details.",
  developer: "You are a senior developer focused on correctness, small patches, and practical verification.",
  designer: "You are a product designer focused on clear UX, visual hierarchy, and user flow.",
  researcher: "You are a researcher focused on evidence, source quality, and careful synthesis.",
  "product-manager": "You are a product manager focused on goals, tradeoffs, user value, and scope.",
  operator: "You are an operator focused on reliable execution, environment state, and clear status updates.",
  planner: "You are a planner focused on sequencing, dependencies, milestones, and acceptance criteria.",
  evaluator: "You are an evaluator focused on review, gaps, risks, and whether the result meets the bar.",
};

function isSubagentType(value: string): value is SubagentType {
  return (subagentTypes as readonly string[]).includes(value);
}

const handoffSchema = z.object({
  goal: z.string().optional().describe("Why this agent is being started"),
  deliverable: z.string().optional().describe("What the agent should return"),
  constraints: z.array(z.string()).optional().describe("Constraints the child agent must follow"),
  context: z.array(z.string()).optional().describe("Background facts, notes, or evidence"),
  acceptanceCriteria: z.array(z.string()).optional().describe("Checks that define success"),
  artifactRefs: z.array(z.string()).optional().describe("Relevant file paths or artifact references"),
  writeBack: z.enum(writeBackKinds).optional().describe("How the result should be packaged: summary, artifact, decision, or patch"),
});

function buildAgentProfile(input: {
  subagentType?: SubagentType;
  childAgent?: ChildAgentRecord | null;
}) {
  const childAgentType = input.childAgent && isSubagentType(input.childAgent.agentRole)
    ? input.childAgent.agentRole
    : undefined;
  const subagentType = input.subagentType ?? childAgentType ?? "general-purpose";

  return {
    agentKind: "subagent-type",
    agentRole: subagentType,
    agentKey: subagentType,
    subagentType,
    memoryScope: `subagent:${subagentType}`,
  };
}

function getResumeChildAgent(parentSessionId: string, resume?: string) {
  const resumeId = resume?.trim();
  return resumeId ? getChildAgentSessionByChildId(parentSessionId, resumeId) : null;
}

function buildAgentIdentity(input: {
  childSessionId: string;
  parentSessionId: string;
  description: string;
  profile: ReturnType<typeof buildAgentProfile>;
}) {
  return {
    agent_id: input.childSessionId,
    agentId: input.childSessionId,
    childAgentId: input.childSessionId,
    childSessionId: input.childSessionId,
    agentInstanceId: input.childSessionId,
    parentSessionId: input.parentSessionId,
    ...input.profile,
    subagent_type: input.profile.subagentType,
    displayName: `${input.profile.agentRole} · ${input.description}`,
  };
}

function appendMessageEvents(events: ReturnType<typeof createSessionMessage>["events"]) {
  for (const event of events) {
    publishSessionEvent(event);
  }
}

function formatList(title: string, values: string[] | undefined) {
  if (!values?.length) {
    return "";
  }

  return [title, ...values.map((value) => `- ${value}`)].join("\n");
}

function buildSystemPrompt(input: {
  parentSessionId: string;
  childSessionId: string;
  agentKey: string;
  memoryScope: string;
  subagentType: SubagentType;
  handoff?: z.infer<typeof handoffSchema>;
  harness?: { enabled?: boolean };
}) {
  const roleBrief = subagentTypeBriefs[input.subagentType];
  const handoff = input.handoff;

  return [
    "You are a child agent spawned from a parent Aliceloop session.",
    `Parent session: ${input.parentSessionId}`,
    `Child agent id: ${input.childSessionId}`,
    `Agent key: ${input.agentKey}`,
    `Memory scope: ${input.memoryScope}`,
    `Subagent type: ${input.subagentType}`,
    roleBrief ? `Role brief:\n${roleBrief}` : "",
    input.harness?.enabled ? "Harness: enabled. Break complex work into sprint-sized loops and report each loop's result." : "",
    handoff?.goal?.trim() ? `Goal:\n${handoff.goal.trim()}` : "",
    handoff?.deliverable?.trim() ? `Deliverable:\n${handoff.deliverable.trim()}` : "",
    formatList("Constraints:", handoff?.constraints),
    formatList("Context:", handoff?.context),
    formatList("Acceptance criteria:", handoff?.acceptanceCriteria),
    formatList("Artifact references:", handoff?.artifactRefs),
    handoff?.writeBack ? `Write back as: ${handoff.writeBack}` : "",
    "Work independently and return a concise result for the parent agent.",
  ].filter(Boolean).join("\n\n");
}

function resolveChildSession(input: {
  description: string;
  parentSessionId: string;
  profile: ReturnType<typeof buildAgentProfile>;
  resume?: string;
}) {
  const resumeId = input.resume?.trim();
  if (resumeId) {
    if (!hasSession(resumeId)) {
      throw new Error(`Cannot resume unknown child agent session: ${resumeId}`);
    }

    return {
      childSessionId: resumeId,
      shouldWriteSystemPrompt: false,
      reusedAgent: true,
    };
  }

  const existing = getChildAgentSession(input.parentSessionId, input.profile.agentKey);
  if (existing && hasSession(existing.childSessionId)) {
    return {
      childSessionId: existing.childSessionId,
      shouldWriteSystemPrompt: false,
      reusedAgent: true,
    };
  }

  const parentBinding = getSessionProjectBinding(input.parentSessionId);
  const childSessionId = createSession({
    title: `Agent · ${input.profile.agentRole}`,
    projectId: parentBinding?.projectId ?? undefined,
    reuseDraft: false,
  }).id;

  upsertChildAgentSession({
    parentSessionId: input.parentSessionId,
    agentKey: input.profile.agentKey,
    childSessionId,
    agentKind: input.profile.agentKind,
    agentRole: input.profile.agentRole,
    displayName: `Agent · ${input.profile.agentRole}`,
  });

  return {
    childSessionId,
    shouldWriteSystemPrompt: true,
    reusedAgent: false,
  };
}

function resolveExistingChildSession(input: {
  parentSessionId: string;
  profile: ReturnType<typeof buildAgentProfile>;
  resume?: string;
}) {
  const resumeId = input.resume?.trim();
  if (resumeId) {
    if (!hasSession(resumeId)) {
      throw new Error(`Cannot read unknown child agent session: ${resumeId}`);
    }

    return resumeId;
  }

  const existing = getChildAgentSession(input.parentSessionId, input.profile.agentKey);
  if (!existing || !hasSession(existing.childSessionId)) {
    throw new Error(`No child agent has been started for ${input.profile.agentKey}.`);
  }

  return existing.childSessionId;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLatestProviderJob(snapshot: ReturnType<typeof getSessionSnapshot>) {
  return snapshot.jobs.find((job) => job.kind === "provider-completion") ?? null;
}

function mapJobStatus(job: ReturnType<typeof getLatestProviderJob>) {
  if (!job) {
    return "idle";
  }

  if (job.status === "done") {
    return "completed";
  }

  return job.status;
}

function isActiveOutputStatus(status: string) {
  return status === "queued" || status === "running";
}

function buildOutputSnapshot(input: {
  parentSessionId: string;
  childSessionId: string;
  description: string;
  profile: ReturnType<typeof buildAgentProfile>;
}) {
  const snapshot = getSessionSnapshot(input.childSessionId);
  const latestJob = getLatestProviderJob(snapshot);
  const latestAssistant = [...snapshot.messages].reverse().find((message) => message.role === "assistant");
  const binding = getSessionProjectBinding(input.childSessionId);
  const outputFile = binding?.transcriptMarkdownPath ?? null;
  const status = mapJobStatus(latestJob);
  const identity = buildAgentIdentity({
    childSessionId: input.childSessionId,
    parentSessionId: input.parentSessionId,
    description: input.description,
    profile: input.profile,
  });

  return {
    ...identity,
    sessionId: input.childSessionId,
    title: snapshot.session.title,
    status,
    jobStatus: latestJob?.status ?? null,
    jobId: latestJob?.id ?? null,
    error: latestJob?.status === "failed" ? latestJob.detail : undefined,
    latestResponse: latestAssistant?.content ?? "",
    result: latestAssistant?.content ?? "",
    response: latestAssistant?.content ?? "",
    outputFile,
    transcriptMarkdownPath: outputFile,
    canReadOutputFile: Boolean(outputFile),
    updatedAt: snapshot.session.updatedAt,
    messageCount: snapshot.messages.length,
  };
}

async function readAgentOutput(input: {
  parentSessionId: string;
  childSessionId: string;
  description: string;
  profile: ReturnType<typeof buildAgentProfile>;
  wait?: boolean;
  timeoutMs?: number;
}) {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildOutputSnapshot(input);

  while (input.wait && isActiveOutputStatus(snapshot.status) && Date.now() < deadline) {
    await delay(outputPollIntervalMs);
    snapshot = buildOutputSnapshot(input);
  }

  return snapshot;
}

export function createAgentTool(parentSessionId = DEFAULT_SESSION_ID): ToolSet {
  return {
    agent: tool({
      description: "Spawn or resume a child Aliceloop agent in its own session. Use it for delegated research, planning, design, operations, or coding work with a structured handoff.",
      inputSchema: z.object({
        description: z.string().min(1).optional().describe("Optional 3-5 word task summary; required when starting a new task"),
        prompt: z.string().min(1).optional().describe("Detailed task instructions for the child agent; required unless read_output is true"),
        subagent_type: z.enum(subagentTypes).optional().describe("Optional AgentDefinition name to dispatch to; omitted defaults to general-purpose"),
        handoff: handoffSchema.optional().describe("Optional structured handoff package for goal, deliverable, constraints, context, acceptance criteria, artifact refs, and write-back style"),
        harness: z.object({
          enabled: z.boolean().optional().describe("Set true to ask the child agent to run multi-sprint orchestration"),
        }).optional().describe("Optional harness controls"),
        model: z.string().optional().describe("Optional requested model; omitted means inherit parent runtime model"),
        resume: z.string().optional().describe("Optional existing child agent session id to resume"),
        read_output: z.boolean().optional().describe("Set true to read the latest output/status for this child agent instead of starting a new task"),
        wait: z.boolean().optional().describe("With read_output, wait briefly for a queued/running child agent to finish"),
        timeout_ms: z.number().int().min(500).max(120_000).optional().describe("Maximum wait time in milliseconds for read_output + wait"),
        run_in_background: z.boolean().optional().describe("Set true to return immediately and collect results from the child session transcript later"),
      }),
      execute: async ({ description, prompt, subagent_type, handoff, harness, model, resume, read_output, wait, timeout_ms, run_in_background }) => {
        const normalizedDescription = description?.trim() ?? "读取子代理输出";
        const normalizedPrompt = prompt?.trim();
        if (read_output) {
          if (normalizedPrompt) {
            throw new Error("read_output cannot be combined with prompt; start a task or read output, not both.");
          }
          if (run_in_background) {
            throw new Error("read_output cannot be combined with run_in_background.");
          }
        } else {
          if (!description?.trim()) {
            throw new Error("description is required unless read_output is true.");
          }
          if (!normalizedPrompt) {
            throw new Error("prompt is required unless read_output is true.");
          }
        }
        const taskPrompt = normalizedPrompt ?? "";

        const agentProfile = buildAgentProfile({
          subagentType: subagent_type,
          childAgent: getResumeChildAgent(parentSessionId, resume),
        });

        if (read_output) {
          const childSessionId = resolveExistingChildSession({
            parentSessionId,
            profile: agentProfile,
            resume,
          });
          return readAgentOutput({
            parentSessionId,
            childSessionId,
            description: normalizedDescription,
            profile: agentProfile,
            wait,
            timeoutMs: timeout_ms,
          });
        }

        const childSession = resolveChildSession({
          description: normalizedDescription,
          parentSessionId,
          profile: agentProfile,
          resume,
        });
        const childSessionId = childSession.childSessionId;
        const agentIdentity = buildAgentIdentity({
          childSessionId,
          parentSessionId,
          description: normalizedDescription,
          profile: agentProfile,
        });

        if (childSession.shouldWriteSystemPrompt) {
          const systemMessage = createSessionMessage({
            sessionId: childSessionId,
            clientMessageId: `child-agent-system-${randomUUID()}`,
            deviceId: "runtime-agent",
            role: "system",
            content: buildSystemPrompt({
              parentSessionId,
              childSessionId,
              agentKey: agentIdentity.agentKey,
              memoryScope: agentIdentity.memoryScope,
              subagentType: agentProfile.subagentType,
              handoff,
              harness,
            }),
            attachmentIds: [],
          });
          appendMessageEvents(systemMessage.events);
        }

        const userMessage = createSessionMessage({
          sessionId: childSessionId,
          clientMessageId: `child-agent-task-${randomUUID()}`,
          deviceId: "runtime-agent",
          role: "user",
          content: taskPrompt,
          attachmentIds: [],
        });
        appendMessageEvents(userMessage.events);

        await syncSessionProjectHistory(childSessionId);

        const { runAgent } = await import("../../runtime/agentRuntime");
        const runPromise = runAgent(childSessionId, {
          model,
        });

        if (run_in_background) {
          void runPromise.catch((error) => {
            console.warn("[agent-tool] background child agent failed", error);
          });

          const snapshot = getSessionSnapshot(childSessionId);
          const binding = getSessionProjectBinding(childSessionId);
          const outputFile = binding?.transcriptMarkdownPath ?? null;
          return {
            ...agentIdentity,
            sessionId: childSessionId,
            title: snapshot.session.title,
            status: "async_launched",
            reusedAgent: childSession.reusedAgent,
            description: normalizedDescription,
            prompt: taskPrompt,
            outputFile,
            transcriptMarkdownPath: outputFile,
            canReadOutputFile: Boolean(outputFile),
            response: "",
          };
        }

        await runPromise;

        const snapshot = getSessionSnapshot(childSessionId);
        const reply = [...snapshot.messages].reverse().find((message) => message.role === "assistant");
        const binding = getSessionProjectBinding(childSessionId);
        const job = snapshot.jobs.find((entry) => entry.kind === "provider-completion");
        const outputFile = binding?.transcriptMarkdownPath ?? null;

        return {
          ...agentIdentity,
          sessionId: childSessionId,
          title: snapshot.session.title,
          status: job?.status === "failed" ? "failed" : "completed",
          reusedAgent: childSession.reusedAgent,
          error: job?.status === "failed" ? job.detail : undefined,
          outputFile,
          transcriptMarkdownPath: outputFile,
          result: reply?.content ?? "",
          response: reply?.content ?? "",
        };
      },
    }),
  };
}

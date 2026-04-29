import { randomUUID } from "node:crypto";
import { generateText, tool, type ToolSet } from "ai";
import { z } from "zod";
import { createProviderModel } from "../../providers/providerModelFactory";
import { getToolModelConfig } from "../../providers/toolModelResolver";
import type { StoredProviderConfig } from "../../repositories/providerRepository";
import { publishSessionEvent } from "../../realtime/sessionStreams";
import {
  createSession,
  createSessionMessage,
  getChildAgentSession,
  getChildAgentSessionByChildId,
  getSessionProjectBinding,
  getSessionSnapshot,
  hasSession,
  listChildAgentSessions,
  upsertChildAgentSession,
  type ChildAgentRecord,
} from "../../repositories/sessionRepository";
import { syncSessionProjectHistory } from "../../services/sessionProjectService";
import {
  appendAgentMemory,
  extractAgentMemoryUpdate,
  getAgentMemoryPath,
  readAgentMemory,
  stripAgentMemoryUpdate,
} from "./agentMemoryStore";

const DEFAULT_SESSION_ID = "agent";
const subagentTypes = [
  "general-purpose",
  "coder",
  "Plan",
  "Explore",
  "alma-guide",
  "alma-operator",
  "statusline-setup",
] as const;
const personaTypes = [
  "developer",
  "designer",
  "researcher",
  "product-manager",
  "operator",
  "planner",
  "evaluator",
] as const;
const writeBackKinds = ["summary", "artifact", "decision", "patch"] as const;
const executionModes = ["session", "ephemeral"] as const;
const outputPollIntervalMs = 300;
const defaultSyncWaitTimeoutMs = 30_000;

type SubagentType = typeof subagentTypes[number];
type PersonaType = typeof personaTypes[number];
type ExecutionMode = typeof executionModes[number];

const subagentTypeBriefs: Record<SubagentType, string> = {
  "general-purpose": "Handle a broad delegated task with balanced reasoning and concise reporting.",
  coder: "Act as a coding agent. Inspect the relevant files, make scoped edits when asked, and report changed paths.",
  Plan: "Act as a planning agent. Produce an actionable plan, risks, dependencies, and next steps.",
  Explore: "Act as an exploration agent. Gather context, identify relevant files or facts, and avoid unnecessary edits.",
  "alma-guide": "Act as an Alma guide. Explain the path forward clearly and keep the handoff easy to follow.",
  "alma-operator": "Act as an Alma operator. Execute the assigned workflow carefully and report operational status.",
  "statusline-setup": "Act as a statusline setup specialist. Focus on shell/editor statusline configuration details.",
};

const personaBriefs: Record<PersonaType, string> = {
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

function isPersonaType(value: string): value is PersonaType {
  return (personaTypes as readonly string[]).includes(value);
}

function defaultSubagentTypeForPersona(persona: PersonaType | undefined): SubagentType {
  switch (persona) {
    case "developer":
      return "coder";
    case "planner":
    case "product-manager":
      return "Plan";
    case "designer":
    case "researcher":
    case "evaluator":
      return "Explore";
    default:
      return "general-purpose";
  }
}

function buildWriteBackInstruction(writeBack: typeof writeBackKinds[number] | undefined) {
  switch (writeBack) {
    case "artifact":
      return "Output contract: return the complete artifact first, then a short note about assumptions or open questions.";
    case "decision":
      return "Output contract: start with the recommended decision, then give the tradeoffs and why alternatives lost.";
    case "patch":
      return "Output contract: start with what changed, then list touched files and verification results.";
    case "summary":
    default:
      return "Output contract: start with the conclusion, then 3-5 key points, then only the details needed to support them.";
  }
}

function applyAgentModelOption(provider: StoredProviderConfig, model?: string) {
  const trimmedModel = model?.trim();
  return trimmedModel ? { ...provider, model: trimmedModel } : provider;
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
  persona?: PersonaType;
  childAgent?: ChildAgentRecord | null;
}) {
  const childSubagentType = input.childAgent && isSubagentType(input.childAgent.agentKind)
    ? input.childAgent.agentKind
    : undefined;
  const childPersona = input.childAgent && isPersonaType(input.childAgent.agentRole)
    ? input.childAgent.agentRole
    : undefined;
  const persona = input.persona ?? childPersona;
  const subagentType = input.subagentType ?? childSubagentType ?? defaultSubagentTypeForPersona(persona);
  const agentKey = persona ? `${subagentType}:${persona}` : subagentType;

  return {
    agentKind: subagentType,
    agentRole: persona ?? "",
    agentKey,
    subagentType,
    persona,
    memoryScope: persona ? `subagent:${subagentType}:${persona}` : `subagent:${subagentType}`,
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
    displayName: `${input.profile.persona ? `${input.profile.subagentType} · ${input.profile.persona}` : input.profile.subagentType} · ${input.description}`,
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
  persona?: PersonaType;
  handoff?: z.infer<typeof handoffSchema>;
  harness?: { enabled?: boolean };
  agentMemory: string;
  agentMemoryPath: string;
  executionMode?: ExecutionMode;
}) {
  const executionBrief = subagentTypeBriefs[input.subagentType];
  const personaBrief = input.persona ? personaBriefs[input.persona] : "";
  const handoff = input.handoff;

  return [
    "You are a child agent spawned from a parent Aliceloop session.",
    `Parent session: ${input.parentSessionId}`,
    `Child agent id: ${input.childSessionId}`,
    `Agent key: ${input.agentKey}`,
    `Memory scope: ${input.memoryScope}`,
    `Agent memory file: ${input.agentMemoryPath}`,
    `Subagent type: ${input.subagentType}`,
    input.persona ? `Persona: ${input.persona}` : "",
    executionBrief ? `Execution template:\n${executionBrief}` : "",
    personaBrief ? `Expert perspective:\n${personaBrief}` : "",
    input.harness?.enabled ? "Harness: enabled. Break complex work into sprint-sized loops and report each loop's result." : "",
    input.executionMode === "ephemeral"
      ? "Execution mode: ephemeral. This run has no persistent child session, transcript, resume handle, or tool access. Return the requested result directly."
      : "",
    handoff?.goal?.trim() ? `Goal:\n${handoff.goal.trim()}` : "",
    handoff?.deliverable?.trim() ? `Deliverable:\n${handoff.deliverable.trim()}` : "",
    formatList("Constraints:", handoff?.constraints),
    formatList("Context:", handoff?.context),
    formatList("Acceptance criteria:", handoff?.acceptanceCriteria),
    formatList("Artifact references:", handoff?.artifactRefs),
    handoff?.writeBack ? `Write back as: ${handoff.writeBack}` : "",
    input.agentMemory
      ? [
          "Existing agent memory:",
          "<agent_memory_context>",
          input.agentMemory,
          "</agent_memory_context>",
        ].join("\n")
      : "Existing agent memory: (none)",
    "If you learn reusable guidance for this agent key, include a short hidden update block at the end of your final reply in this exact form: <agent_memory type=\"feedback\">one reusable lesson</agent_memory>. Use type=\"project\" for stable project knowledge and type=\"reference\" for reusable external references. Omit the block when there is nothing durable to store.",
    buildWriteBackInstruction(handoff?.writeBack),
    "Work independently and return a concise result for the parent agent.",
  ].filter(Boolean).join("\n\n");
}

async function runEphemeralAgent(input: {
  parentSessionId: string;
  description: string;
  prompt: string;
  profile: ReturnType<typeof buildAgentProfile>;
  handoff?: z.infer<typeof handoffSchema>;
  harness?: { enabled?: boolean };
  model?: string;
}) {
  const provider = getToolModelConfig();
  if (!provider?.apiKey) {
    throw new Error("No enabled model gateway with an API key is configured for ephemeral agent runs.");
  }

  const ephemeralId = `ephemeral-agent-${randomUUID()}`;
  const identity = buildAgentIdentity({
    childSessionId: ephemeralId,
    parentSessionId: input.parentSessionId,
    description: input.description,
    profile: input.profile,
  });
  const agentMemory = readAgentMemory(identity.agentKey);
  const response = await generateText({
    model: createProviderModel(applyAgentModelOption(provider, input.model)),
    system: buildSystemPrompt({
      parentSessionId: input.parentSessionId,
      childSessionId: ephemeralId,
      agentKey: identity.agentKey,
      memoryScope: identity.memoryScope,
      subagentType: input.profile.subagentType,
      persona: input.profile.persona,
      handoff: input.handoff,
      harness: input.harness,
      agentMemory,
      agentMemoryPath: getAgentMemoryPath(identity.agentKey),
      executionMode: "ephemeral",
    }),
    prompt: input.prompt,
    temperature: 0.2,
  });
  const agentMemoryPath = persistAgentMemoryFromText({
    agentKey: identity.agentKey,
    childSessionId: ephemeralId,
    text: response.text,
  });
  const replyContent = stripAgentMemoryUpdate(response.text);

  return {
    ...identity,
    executionMode: "ephemeral",
    sessionId: null,
    childSessionId: null,
    childAgentId: null,
    agentInstanceId: ephemeralId,
    status: "completed",
    reusedAgent: false,
    description: input.description,
    prompt: input.prompt,
    outputFile: null,
    transcriptMarkdownPath: null,
    canReadOutputFile: false,
    agentMemoryPath,
    result: replyContent,
    response: replyContent,
  };
}

function persistAgentMemoryFromText(input: {
  agentKey: string;
  childSessionId: string;
  text: string;
}) {
  const update = extractAgentMemoryUpdate(input.text);
  if (!update) {
    return null;
  }

  return appendAgentMemory({
    agentKey: input.agentKey,
    memoryType: update.memoryType,
    content: update.content,
    sourceSessionId: input.childSessionId,
  });
}

function persistAgentMemoryFromLatestReply(input: {
  agentKey: string;
  childSessionId: string;
}) {
  const snapshot = getSessionSnapshot(input.childSessionId);
  const reply = [...snapshot.messages].reverse().find((message) => message.role === "assistant");
  if (!reply?.content) {
    return null;
  }

  return persistAgentMemoryFromText({
    agentKey: input.agentKey,
    childSessionId: input.childSessionId,
    text: reply.content,
  });
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
    title: `Agent · ${input.profile.agentKey}`,
    projectId: parentBinding?.projectId ?? undefined,
    reuseDraft: false,
  }).id;

  upsertChildAgentSession({
    parentSessionId: input.parentSessionId,
    agentKey: input.profile.agentKey,
    childSessionId,
    agentKind: input.profile.agentKind,
    agentRole: input.profile.agentRole,
    displayName: `Agent · ${input.profile.agentKey}`,
  });

  return {
    childSessionId,
    shouldWriteSystemPrompt: true,
    reusedAgent: false,
  };
}

function buildProfileFromChildAgent(childAgent: ChildAgentRecord) {
  return buildAgentProfile({ childAgent });
}

function findFallbackChildAgent(input: {
  parentSessionId: string;
  profile: ReturnType<typeof buildAgentProfile>;
}) {
  const bySubagentKey = getChildAgentSession(input.parentSessionId, input.profile.subagentType);
  if (bySubagentKey && hasSession(bySubagentKey.childSessionId)) {
    return bySubagentKey;
  }

  const candidates = listChildAgentSessions(input.parentSessionId)
    .filter((childAgent) => hasSession(childAgent.childSessionId));
  const matchingSubagent = candidates.filter((childAgent) =>
    childAgent.agentKind === input.profile.subagentType
    || childAgent.agentKey === input.profile.subagentType
    || childAgent.agentKey.startsWith(`${input.profile.subagentType}:`)
  );

  if (matchingSubagent.length === 1) {
    return matchingSubagent[0];
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  return null;
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

    return {
      childSessionId: resumeId,
      profile: input.profile,
    };
  }

  const existing = getChildAgentSession(input.parentSessionId, input.profile.agentKey);
  if (!existing || !hasSession(existing.childSessionId)) {
    const fallback = findFallbackChildAgent(input);
    if (fallback) {
      return {
        childSessionId: fallback.childSessionId,
        profile: buildProfileFromChildAgent(fallback),
      };
    }

    const available = listChildAgentSessions(input.parentSessionId)
      .map((childAgent) => childAgent.agentKey)
      .join(", ");
    throw new Error(`No child agent has been started for ${input.profile.agentKey}.${available ? ` Available child agents: ${available}.` : ""}`);
  }

  return {
    childSessionId: existing.childSessionId,
    profile: input.profile,
  };
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

async function waitForRunCompletion(runPromise: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      runPromise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
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
  const latestResponse = latestAssistant?.content ? stripAgentMemoryUpdate(latestAssistant.content) : "";
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
    latestResponse,
    result: latestResponse,
    response: latestResponse,
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
      description: "Run a delegated Aliceloop agent. Use session mode for child sessions with tools/resume, or ephemeral mode for one-off expert synthesis without a child session.",
      inputSchema: z.object({
        description: z.string().min(1).optional().describe("Optional 3-5 word task summary; required when starting a new task"),
        prompt: z.string().min(1).optional().describe("Detailed task instructions for the child agent; required unless read_output is true"),
        subagent_type: z.enum(subagentTypes).optional().describe("Optional execution template: general-purpose, coder, Plan, Explore, alma-guide, alma-operator, or statusline-setup"),
        persona: z.enum(personaTypes).optional().describe("Optional expert perspective: developer, designer, researcher, product-manager, operator, planner, or evaluator"),
        handoff: handoffSchema.optional().describe("Optional structured handoff package for goal, deliverable, constraints, context, acceptance criteria, artifact refs, and write-back style"),
        harness: z.object({
          enabled: z.boolean().optional().describe("Set true to ask the child agent to run multi-sprint orchestration"),
        }).optional().describe("Optional harness controls"),
        execution_mode: z.enum(executionModes).optional().describe("session creates or reuses a child session; ephemeral runs once without a child session, transcript, resume, background execution, or tools"),
        model: z.string().optional().describe("Optional requested model; omitted means inherit parent runtime model"),
        resume: z.string().optional().describe("Optional existing child agent session id to resume"),
        read_output: z.boolean().optional().describe("Set true to read the latest output/status for this child agent instead of starting a new task"),
        wait: z.boolean().optional().describe("With read_output, wait briefly for a queued/running child agent to finish"),
        timeout_ms: z.number().int().min(500).max(120_000).optional().describe("Maximum wait time in milliseconds for read_output + wait, or for a synchronous child run before it is returned as background work"),
        run_in_background: z.boolean().optional().describe("Set true to return immediately and collect results from the child session transcript later"),
      }),
      execute: async ({ description, prompt, subagent_type, persona, handoff, harness, execution_mode, model, resume, read_output, wait, timeout_ms, run_in_background }) => {
        const normalizedDescription = description?.trim() ?? "读取子代理输出";
        const normalizedPrompt = prompt?.trim();
        const executionMode = execution_mode ?? "session";
        if (read_output) {
          if (normalizedPrompt) {
            throw new Error("read_output cannot be combined with prompt; start a task or read output, not both.");
          }
          if (run_in_background) {
            throw new Error("read_output cannot be combined with run_in_background.");
          }
          if (executionMode === "ephemeral") {
            throw new Error("ephemeral agent runs cannot be read later; use session mode for read_output.");
          }
        } else {
          if (!description?.trim()) {
            throw new Error("description is required unless read_output is true.");
          }
          if (!normalizedPrompt) {
            throw new Error("prompt is required unless read_output is true.");
          }
        }
        if (executionMode === "ephemeral" && (resume || run_in_background || wait || timeout_ms)) {
          throw new Error("ephemeral agent runs do not support resume, run_in_background, wait, or timeout_ms.");
        }
        const taskPrompt = normalizedPrompt ?? "";

        const agentProfile = buildAgentProfile({
          subagentType: subagent_type,
          persona,
          childAgent: getResumeChildAgent(parentSessionId, resume),
        });

        if (read_output) {
          const childSession = resolveExistingChildSession({
            parentSessionId,
            profile: agentProfile,
            resume,
          });
          return readAgentOutput({
            parentSessionId,
            childSessionId: childSession.childSessionId,
            description: normalizedDescription,
            profile: childSession.profile,
            wait,
            timeoutMs: timeout_ms,
          });
        }

        if (executionMode === "ephemeral") {
          return runEphemeralAgent({
            parentSessionId,
            description: normalizedDescription,
            prompt: taskPrompt,
            profile: agentProfile,
            handoff,
            harness,
            model,
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
          const agentMemory = readAgentMemory(agentIdentity.agentKey);
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
              persona: agentProfile.persona,
              handoff,
              harness,
              agentMemory,
              agentMemoryPath: getAgentMemoryPath(agentIdentity.agentKey),
              executionMode: "session",
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
          void runPromise
            .then(() => {
              persistAgentMemoryFromLatestReply({
                agentKey: agentIdentity.agentKey,
                childSessionId,
              });
            })
            .catch((error) => {
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

        const completedInSyncWindow = await waitForRunCompletion(runPromise, timeout_ms ?? defaultSyncWaitTimeoutMs);
        if (!completedInSyncWindow) {
          void runPromise
            .then(() => {
              persistAgentMemoryFromLatestReply({
                agentKey: agentIdentity.agentKey,
                childSessionId,
              });
            })
            .catch((error) => {
              console.warn("[agent-tool] timed-out child agent failed after background handoff", error);
            });

          const snapshot = getSessionSnapshot(childSessionId);
          const binding = getSessionProjectBinding(childSessionId);
          const outputFile = binding?.transcriptMarkdownPath ?? null;
          return {
            ...agentIdentity,
            sessionId: childSessionId,
            title: snapshot.session.title,
            status: "async_launched",
            reason: "sync_timeout",
            reusedAgent: childSession.reusedAgent,
            description: normalizedDescription,
            prompt: taskPrompt,
            outputFile,
            transcriptMarkdownPath: outputFile,
            canReadOutputFile: Boolean(outputFile),
            response: "",
          };
        }

        const snapshot = getSessionSnapshot(childSessionId);
        const reply = [...snapshot.messages].reverse().find((message) => message.role === "assistant");
        const replyContent = reply?.content ? stripAgentMemoryUpdate(reply.content) : "";
        const agentMemoryPath = persistAgentMemoryFromText({
          agentKey: agentIdentity.agentKey,
          childSessionId,
          text: reply?.content ?? "",
        });
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
          agentMemoryPath,
          result: replyContent,
          response: replyContent,
        };
      },
    }),
  };
}

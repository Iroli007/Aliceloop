import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { publishSessionEvent } from "../../realtime/sessionStreams";
import { appendSessionEvent } from "../../repositories/sessionRepository";
import {
  enterSessionPlanMode,
  exitSessionPlanMode,
  getSessionPlanModeState,
  touchSessionPlanModeUpdatedAt,
} from "../../repositories/sessionPlanModeRepository";
import { approvePlan, getPlan, updatePlan } from "../../repositories/planRepository";
import { STABLE_TOOL_PROVIDER_OPTIONS } from "./toolProviderOptions";

export const ENTER_PLAN_MODE_TOOL_NAME = "enter_plan_mode";
export const EXIT_PLAN_MODE_TOOL_NAME = "exit_plan_mode";
export const WRITE_PLAN_ARTIFACT_TOOL_NAME = "write_plan_artifact";

function hasConcretePlanArtifact(planId: string | null) {
  if (!planId) {
    return false;
  }

  const plan = getPlan(planId);
  if (!plan) {
    return false;
  }

  return Boolean(plan.goal.trim()) && plan.steps.length >= 2;
}

export function createPlanModeToolSet(sessionId: string, planModeActive: boolean): ToolSet {
  const tools: ToolSet = {};

  if (!planModeActive) {
    tools[ENTER_PLAN_MODE_TOOL_NAME] = tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
      description:
        "Enter thread-scoped plan mode for tasks that should be explored and designed before implementation. This binds or creates the active draft plan for the current thread.",
      inputSchema: z.object({}),
      execute: async () => {
        const existing = getSessionPlanModeState(sessionId);
        if (existing.active) {
          return JSON.stringify({
            kind: ENTER_PLAN_MODE_TOOL_NAME,
            status: "already_active",
            planMode: existing,
          });
        }

        const planMode = enterSessionPlanMode({ sessionId });
        const event = appendSessionEvent(sessionId, "plan_mode.updated", {
          planMode,
          transition: "entered",
        });
        publishSessionEvent(event);

        return JSON.stringify({
          kind: ENTER_PLAN_MODE_TOOL_NAME,
          status: "entered",
          planMode,
        });
      },
    });
  }

  if (planModeActive) {
    tools[WRITE_PLAN_ARTIFACT_TOOL_NAME] = tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
      description:
        "Update the current thread's plan artifact with a concrete title, goal, and ordered steps. Use this to persist the plan you are discussing with the user while plan mode is active.",
      inputSchema: z.object({
        title: z.string().min(1).max(120).optional().describe("Optional plan title"),
        goal: z.string().min(1).max(1000).describe("Short goal/summary for the plan"),
        steps: z.array(z.string().min(1).max(240)).max(20).describe("Ordered implementation steps for the plan"),
      }),
      execute: async ({ title, goal, steps }) => {
        const existing = getSessionPlanModeState(sessionId);
        if (!existing.active || !existing.activePlanId) {
          return JSON.stringify({
            kind: WRITE_PLAN_ARTIFACT_TOOL_NAME,
            status: "blocked",
            reason: "plan_mode_inactive",
            message: "Plan mode is not active for this thread.",
            planMode: existing,
          });
        }

        const plan = updatePlan({
          planId: existing.activePlanId,
          title,
          goal,
          steps,
        });

        if (!plan) {
          return JSON.stringify({
            kind: WRITE_PLAN_ARTIFACT_TOOL_NAME,
            status: "blocked",
            reason: "plan_missing",
            message: "The active plan artifact could not be found.",
            planMode: existing,
          });
        }

        const planMode = touchSessionPlanModeUpdatedAt(sessionId);
        const event = appendSessionEvent(sessionId, "plan_mode.updated", {
          planMode,
          transition: "updated",
        });
        publishSessionEvent(event);

        return JSON.stringify({
          kind: WRITE_PLAN_ARTIFACT_TOOL_NAME,
          status: "updated",
          planMode,
          plan: {
            id: plan.id,
            title: plan.title,
            goal: plan.goal,
            steps: plan.steps,
            updatedAt: plan.updatedAt,
          },
        });
      },
    });

    tools[EXIT_PLAN_MODE_TOOL_NAME] = tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
      description:
        "Exit thread-scoped plan mode so implementation can begin with the normal execution tool surface.",
      inputSchema: z.object({}),
      execute: async () => {
        const existing = getSessionPlanModeState(sessionId);
        if (!existing.active) {
          return JSON.stringify({
            kind: EXIT_PLAN_MODE_TOOL_NAME,
            status: "already_inactive",
            planMode: existing,
          });
        }

        if (!hasConcretePlanArtifact(existing.activePlanId)) {
          return JSON.stringify({
            kind: EXIT_PLAN_MODE_TOOL_NAME,
            status: "blocked",
            reason: "plan_incomplete",
            message: "The active plan is still incomplete. Finish the plan with a concrete goal and at least two ordered steps before exiting plan mode.",
            planMode: existing,
          });
        }

        const activePlanId = existing.activePlanId;
        if (!activePlanId) {
          return JSON.stringify({
            kind: EXIT_PLAN_MODE_TOOL_NAME,
            status: "blocked",
            reason: "plan_missing",
            message: "The active plan artifact could not be found.",
            planMode: existing,
          });
        }

        approvePlan(activePlanId);
        const planMode = exitSessionPlanMode(sessionId);
        const event = appendSessionEvent(sessionId, "plan_mode.updated", {
          planMode,
          transition: "exited",
        });
        publishSessionEvent(event);

        return JSON.stringify({
          kind: EXIT_PLAN_MODE_TOOL_NAME,
          status: "exited",
          planMode,
        });
      },
    });
  }

  return tools;
}

import { inferSkillIdsForToolCall } from "../context/tools/toolSkillRouting";
import {
  cloneWorksetState,
  type SessionWorksetState,
  type WorksetEntryState,
} from "../context/workset/worksetState";
import { updateSessionWorksetState } from "../repositories/sessionRepository";
import type { ToolCallState } from "./toolStateMachine";

function createWorksetEntryState(): WorksetEntryState {
  return {
    score: 0,
    idleTurns: 0,
    active: false,
    lastAttachedTurn: null,
    lastUsedTurn: null,
  };
}

function normalizeAttachedNames(values: Iterable<string>) {
  return [...new Set(
    [...values]
      .map((value) => value.trim())
      .filter(Boolean),
  )];
}

function isCountedToolCall(state: ToolCallState) {
  return ![
    "input-streaming",
    "input-available",
    "approval-requested",
    "approval-responded",
  ].includes(state.status);
}

export function settleWorksetAfterTurn(input: {
  sessionId: string;
  startingState: SessionWorksetState;
  attachedSkillIds: Iterable<string>;
  directSkillIds: Iterable<string>;
  attachedToolNames: Iterable<string>;
  toolCalls: ToolCallState[];
}) {
  const nextState = cloneWorksetState(input.startingState);
  const turnCounter = nextState.turnCounter + 1;
  nextState.turnCounter = turnCounter;

  const attachedSkillIds = normalizeAttachedNames(input.attachedSkillIds);
  const directSkillIds = normalizeAttachedNames(input.directSkillIds);
  const attachedToolNames = normalizeAttachedNames(input.attachedToolNames);
  const attachedSkillSet = new Set(attachedSkillIds);
  const attachedToolSet = new Set(attachedToolNames);

  const usedToolCalls = input.toolCalls.filter((state) => isCountedToolCall(state));
  const usedToolNames = new Set(usedToolCalls.map((state) => state.toolName));
  const usedSkillIds = new Set<string>();

  for (const call of usedToolCalls) {
    for (const skillId of inferSkillIdsForToolCall(call.toolName, call.input, attachedSkillSet)) {
      usedSkillIds.add(skillId);
    }
  }
  for (const skillId of directSkillIds) {
    if (attachedSkillSet.has(skillId)) {
      usedSkillIds.add(skillId);
    }
  }

  const settleEntry = (
    entries: Record<string, WorksetEntryState>,
    key: string,
    isAttached: boolean,
    isUsed: boolean,
    wasActive: boolean,
  ) => {
    const entry = entries[key] ?? createWorksetEntryState();
    if (isAttached && !wasActive) {
      entry.idleTurns = 0;
      entry.score += 2;
      entry.active = true;
    }

    if (isAttached) {
      entry.lastAttachedTurn = turnCounter;
      if (isUsed) {
        entry.score += 1;
        entry.idleTurns = 0;
        entry.lastUsedTurn = turnCounter;
      } else {
        entry.score = Math.max(0, entry.score - 1);
        entry.idleTurns += 1;
      }

      if (entry.idleTurns >= 2 || entry.score <= 0) {
        entry.score = 0;
        entry.active = false;
      }
    }

    entries[key] = entry;
  };

  const skillKeys = new Set([
    ...Object.keys(nextState.skills),
    ...attachedSkillIds,
    ...directSkillIds,
    ...usedSkillIds,
  ]);
  for (const skillId of skillKeys) {
    const wasActive = Boolean(input.startingState.skills[skillId]?.active);
    settleEntry(
      nextState.skills,
      skillId,
      attachedSkillSet.has(skillId),
      usedSkillIds.has(skillId),
      wasActive,
    );
  }

  const toolKeys = new Set([
    ...Object.keys(nextState.tools),
    ...attachedToolNames,
    ...usedToolNames,
  ]);
  for (const toolName of toolKeys) {
    const wasActive = Boolean(input.startingState.tools[toolName]?.active);
    settleEntry(
      nextState.tools,
      toolName,
      attachedToolSet.has(toolName),
      usedToolNames.has(toolName),
      wasActive,
    );
  }

  updateSessionWorksetState(input.sessionId, nextState);
}

export interface WorksetEntryState {
  score: number;
  idleTurns: number;
  active: boolean;
  lastAttachedTurn: number | null;
  lastUsedTurn: number | null;
}

export interface SessionWorksetState {
  turnCounter: number;
  skills: Record<string, WorksetEntryState>;
  tools: Record<string, WorksetEntryState>;
}

function createEmptyWorksetEntryState(): WorksetEntryState {
  return {
    score: 0,
    idleTurns: 0,
    active: false,
    lastAttachedTurn: null,
    lastUsedTurn: null,
  };
}

export function createEmptyWorksetState(): SessionWorksetState {
  return {
    turnCounter: 0,
    skills: {},
    tools: {},
  };
}

function toNonNegativeInteger(value: unknown, fallback = 0) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(0, Math.floor(numeric));
}

function toNullableTurn(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  return Math.max(0, Math.floor(numeric));
}

function normalizeWorksetEntry(value: unknown): WorksetEntryState | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Partial<WorksetEntryState>;
  const score = toNonNegativeInteger(raw.score, 0);
  const idleTurns = toNonNegativeInteger(raw.idleTurns, 0);
  const active = Boolean(raw.active) && score > 0 && idleTurns < 2;

  return {
    score,
    idleTurns,
    active,
    lastAttachedTurn: toNullableTurn(raw.lastAttachedTurn),
    lastUsedTurn: toNullableTurn(raw.lastUsedTurn),
  };
}

function normalizeWorksetEntryMap(rawEntries: unknown) {
  const entries: Record<string, WorksetEntryState> = {};
  if (!rawEntries || typeof rawEntries !== "object") {
    return entries;
  }

  for (const [key, value] of Object.entries(rawEntries as Record<string, unknown>)) {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      continue;
    }

    const normalizedEntry = normalizeWorksetEntry(value);
    if (normalizedEntry) {
      entries[normalizedKey] = normalizedEntry;
    }
  }

  return entries;
}

export function normalizeWorksetState(value: unknown): SessionWorksetState {
  if (!value || typeof value !== "object") {
    return createEmptyWorksetState();
  }

  const raw = value as Partial<SessionWorksetState>;
  return {
    turnCounter: toNonNegativeInteger(raw.turnCounter, 0),
    skills: normalizeWorksetEntryMap(raw.skills),
    tools: normalizeWorksetEntryMap(raw.tools),
  };
}

export function cloneWorksetState(state: SessionWorksetState): SessionWorksetState {
  return {
    turnCounter: state.turnCounter,
    skills: Object.fromEntries(
      Object.entries(state.skills).map(([key, entry]) => [
        key,
        { ...entry },
      ]),
    ),
    tools: Object.fromEntries(
      Object.entries(state.tools).map(([key, entry]) => [
        key,
        { ...entry },
      ]),
    ),
  };
}

export function serializeWorksetState(state: SessionWorksetState) {
  return JSON.stringify(state);
}

function isActiveWorksetEntry(entry: WorksetEntryState) {
  return entry.active && entry.score > 0 && entry.idleTurns < 2;
}

export function getActiveWorksetSkillIds(state: SessionWorksetState) {
  return Object.entries(state.skills)
    .filter(([, entry]) => isActiveWorksetEntry(entry))
    .map(([skillId]) => skillId)
    .sort((left, right) => left.localeCompare(right, "en"));
}

export function getActiveWorksetToolNames(state: SessionWorksetState) {
  return Object.entries(state.tools)
    .filter(([, entry]) => isActiveWorksetEntry(entry))
    .map(([toolName]) => toolName)
    .sort((left, right) => left.localeCompare(right, "en"));
}

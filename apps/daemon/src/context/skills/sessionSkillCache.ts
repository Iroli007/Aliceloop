import type { SkillGroupId, SkillRouteHints } from "./skillRouting";

interface SessionSkillCacheEntry {
  updatedAt: number;
  skillTtls: Map<string, number>;
  groupTtls: Map<SkillGroupId, number>;
}

const SESSION_SKILL_CACHE = new Map<string, SessionSkillCacheEntry>();

const MAX_SKILL_TTL_TURNS = 4;
const MAX_GROUP_TTL_TURNS = 4;
const MAX_IDLE_MS = 20 * 60 * 1000;

function getOrCreateEntry(sessionId: string) {
  const existing = SESSION_SKILL_CACHE.get(sessionId);
  if (existing) {
    return existing;
  }

  const created: SessionSkillCacheEntry = {
    updatedAt: Date.now(),
    skillTtls: new Map(),
    groupTtls: new Map(),
  };
  SESSION_SKILL_CACHE.set(sessionId, created);
  return created;
}

function pruneEntry(sessionId: string) {
  const entry = SESSION_SKILL_CACHE.get(sessionId);
  if (!entry) {
    return null;
  }

  if (Date.now() - entry.updatedAt > MAX_IDLE_MS) {
    SESSION_SKILL_CACHE.delete(sessionId);
    return null;
  }

  for (const [skillId, ttl] of entry.skillTtls) {
    if (ttl <= 0) {
      entry.skillTtls.delete(skillId);
    }
  }

  for (const [groupId, ttl] of entry.groupTtls) {
    if (ttl <= 0) {
      entry.groupTtls.delete(groupId);
    }
  }

  if (entry.skillTtls.size === 0 && entry.groupTtls.size === 0) {
    SESSION_SKILL_CACHE.delete(sessionId);
    return null;
  }

  return entry;
}

export function advanceSessionSkillCacheTurn(sessionId: string) {
  const entry = pruneEntry(sessionId);
  if (!entry) {
    return;
  }

  for (const [skillId, ttl] of entry.skillTtls) {
    entry.skillTtls.set(skillId, ttl - 1);
  }

  for (const [groupId, ttl] of entry.groupTtls) {
    entry.groupTtls.set(groupId, ttl - 1);
  }

  entry.updatedAt = Date.now();
  pruneEntry(sessionId);
}

export function getSessionSkillCacheHints(
  sessionId: string,
  options?: { includeSticky?: boolean },
): SkillRouteHints {
  const entry = pruneEntry(sessionId);
  if (!entry || options?.includeSticky === false) {
    return {
      stickySkillIds: [],
      stickyGroupIds: [],
      reasons: [],
    };
  }

  return {
    stickySkillIds: [...entry.skillTtls.keys()],
    stickyGroupIds: [...entry.groupTtls.keys()],
    reasons: ["session_skill_cache"],
  };
}

export function rememberSessionSkillRoute(
  sessionId: string,
  input: {
    skillIds: string[];
    groupIds: SkillGroupId[];
  },
) {
  if (input.skillIds.length === 0 && input.groupIds.length === 0) {
    return;
  }

  const entry = getOrCreateEntry(sessionId);
  entry.updatedAt = Date.now();

  for (const skillId of input.skillIds) {
    entry.skillTtls.set(skillId, MAX_SKILL_TTL_TURNS);
  }

  for (const groupId of input.groupIds) {
    entry.groupTtls.set(groupId, MAX_GROUP_TTL_TURNS);
  }
}

export function inspectSessionSkillCache(sessionId: string) {
  const entry = pruneEntry(sessionId);
  if (!entry) {
    return {
      stickySkillIds: [] as string[],
      stickyGroupIds: [] as SkillGroupId[],
    };
  }

  return {
    stickySkillIds: [...entry.skillTtls.keys()],
    stickyGroupIds: [...entry.groupTtls.keys()],
  };
}

export function clearSessionSkillCache(sessionId?: string) {
  if (sessionId) {
    SESSION_SKILL_CACHE.delete(sessionId);
    return;
  }

  SESSION_SKILL_CACHE.clear();
}

import { getSkillDefinition, listActiveSkillDefinitions } from "../skills/skillLoader";

type BashInput = {
  command?: unknown;
  args?: unknown;
  script?: unknown;
};

function normalizeToolName(toolName: string) {
  return toolName.trim();
}

function toToolCommandText(input: unknown) {
  if (!input || typeof input !== "object") {
    return typeof input === "string" ? input : "";
  }

  const raw = input as BashInput;
  const parts: string[] = [];
  if (typeof raw.command === "string") {
    parts.push(raw.command);
  }
  if (Array.isArray(raw.args)) {
    for (const arg of raw.args) {
      if (typeof arg === "string") {
        parts.push(arg);
      }
    }
  }
  if (typeof raw.script === "string") {
    parts.push(raw.script);
  }

  return parts.join(" ").trim();
}

function getCandidateSkillDefinitions(candidateSkillIds?: Iterable<string>) {
  if (!candidateSkillIds) {
    return listActiveSkillDefinitions();
  }

  const definitions: ReturnType<typeof listActiveSkillDefinitions> = [];
  const seen = new Set<string>();
  for (const skillId of candidateSkillIds) {
    const normalizedSkillId = skillId.trim();
    if (!normalizedSkillId || seen.has(normalizedSkillId)) {
      continue;
    }

    seen.add(normalizedSkillId);
    const definition = getSkillDefinition(normalizedSkillId);
    if (definition) {
      definitions.push(definition);
    }
  }

  return definitions;
}

function filterCandidateSkillIds(
  candidateSkillIds: Iterable<string> | undefined,
  preferredSkillIds: string[],
) {
  const candidateSet = candidateSkillIds ? new Set(candidateSkillIds) : null;
  const ordered: string[] = [];
  for (const skillId of preferredSkillIds) {
    if (!skillId.trim()) {
      continue;
    }
    if (candidateSet && !candidateSet.has(skillId)) {
      continue;
    }
    if (!ordered.includes(skillId)) {
      ordered.push(skillId);
    }
  }
  return ordered;
}

function inferBashSkillIds(input: unknown, candidateSkillIds?: Iterable<string>) {
  const commandText = toToolCommandText(input).toLowerCase();
  const directMatches: string[] = [];

  if (/\baliceloop\s+voice\b|\bvoice\s+(?:speak|save|list)\b|\bsay\b/u.test(commandText)) {
    directMatches.push("voice");
  }

  if (/\bscreencapture\b|\bsips\b/u.test(commandText)) {
    directMatches.push("screenshot");
  }

  if (/\baliceloop\s+send\s+(?:file|photo)\b/u.test(commandText)) {
    directMatches.push("send-file");
  }

  if (/\baliceloop\s+tasks\b|\btasks\s+(?:list|add|update|done|show|delete)\b/u.test(commandText)) {
    directMatches.push("tasks");
  }

  if (/\baliceloop\s+skills\b|\bskills\s+(?:list|search|show)\b/u.test(commandText)) {
    directMatches.push("skill-hub", "skill-search");
  }

  if (/\bdate\b|\bsw_vers\b|\bdf\b|\buptime\b|\bifconfig\b|\bnetworksetup\b|\bscutil\b|\buname\b/u.test(commandText)) {
    directMatches.push("system-info");
  }

  if (/\bfind\b|\bdu\b|\bls\b|\bmv\b|\bcp\b|\brm\b|\bzip\b|\btar\b|\btrash\b|\bmkdir\b|\brmdir\b|\bchmod\b|\bchown\b/u.test(commandText)) {
    directMatches.push("file-manager");
  }

  return filterCandidateSkillIds(candidateSkillIds, directMatches);
}

function inferDirectSkillIds(toolName: string) {
  switch (normalizeToolName(toolName)) {
    case "web_search":
      return ["web-search"];
    case "web_fetch":
      return ["web-fetch"];
    case "view_image":
      return ["browser"];
    case "browser_media_probe":
    case "browser_video_watch_start":
    case "browser_video_watch_poll":
    case "browser_video_watch_stop":
      return ["browser"];
    case "browser_find":
    case "browser_navigate":
    case "browser_snapshot":
    case "browser_wait":
    case "browser_click":
    case "browser_type":
    case "browser_scroll":
    case "browser_screenshot":
    case "browser_batch":
      return ["browser"];
    case "chrome_relay_status":
    case "chrome_relay_list_tabs":
    case "chrome_relay_open":
    case "chrome_relay_navigate":
    case "chrome_relay_read":
    case "chrome_relay_read_dom":
    case "chrome_relay_click":
    case "chrome_relay_type":
    case "chrome_relay_screenshot":
    case "chrome_relay_scroll":
    case "chrome_relay_eval":
    case "chrome_relay_back":
    case "chrome_relay_forward":
      return ["web-fetch"];
    default:
      return [];
  }
}

function inferFromAllowedTools(
  toolName: string,
  candidateSkillIds?: Iterable<string>,
) {
  const candidateDefinitions = getCandidateSkillDefinitions(candidateSkillIds);
  return candidateDefinitions
    .filter((skill) => skill.allowedTools.includes(toolName))
    .map((skill) => skill.id);
}

export function inferSkillIdsForToolCall(
  toolName: string,
  input: unknown,
  candidateSkillIds?: Iterable<string>,
) {
  const directSkillIds = filterCandidateSkillIds(candidateSkillIds, inferDirectSkillIds(toolName));
  if (directSkillIds.length > 0) {
    return directSkillIds;
  }

  if (normalizeToolName(toolName) === "bash") {
    return inferBashSkillIds(input, candidateSkillIds);
  }

  return inferFromAllowedTools(toolName, candidateSkillIds);
}

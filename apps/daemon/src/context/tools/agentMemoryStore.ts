import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDataDir } from "../../db/client";

const allowedAgentMemoryTypes = new Set(["feedback", "project", "reference"]);

function encodeAgentKey(agentKey: string) {
  return encodeURIComponent(agentKey).replace(/%/g, "_");
}

export function getAgentMemoryPath(agentKey: string) {
  return join(getDataDir(), "agent-memory", encodeAgentKey(agentKey), "MEMORY.md");
}

export function readAgentMemory(agentKey: string) {
  const path = getAgentMemoryPath(agentKey);
  if (!existsSync(path)) {
    return "";
  }

  return readFileSync(path, "utf8").trim();
}

export function appendAgentMemory(input: {
  agentKey: string;
  memoryType: string;
  content: string;
  sourceSessionId: string;
}) {
  const content = input.content.replace(/\s+/g, " ").trim();
  if (!content) {
    return null;
  }

  const memoryType = allowedAgentMemoryTypes.has(input.memoryType) ? input.memoryType : "feedback";
  const path = getAgentMemoryPath(input.agentKey);
  mkdirSync(dirname(path), { recursive: true });

  const header = existsSync(path)
    ? ""
    : [
        "---",
        `agentKey: ${JSON.stringify(input.agentKey)}`,
        "---",
        "",
      ].join("\n");
  const entry = [
    header,
    `## ${new Date().toISOString()}`,
    `- type: ${memoryType}`,
    `- sourceSessionId: ${input.sourceSessionId}`,
    `- content: ${content}`,
    "",
  ].join("\n");

  appendFileSync(path, entry, "utf8");
  return path;
}

export function extractAgentMemoryUpdate(text: string) {
  const match = text.match(/<agent_memory(?:\s+type="([^"]+)")?\s*>([\s\S]*?)<\/agent_memory>/iu);
  if (!match) {
    return null;
  }

  const content = match[2]?.trim() ?? "";
  if (!content) {
    return null;
  }

  return {
    memoryType: match[1]?.trim() || "feedback",
    content,
  };
}

export function stripAgentMemoryUpdate(text: string) {
  return text.replace(/\n?\s*<agent_memory(?:\s+type="[^"]+")?\s*>[\s\S]*?<\/agent_memory>\s*/giu, "").trim();
}

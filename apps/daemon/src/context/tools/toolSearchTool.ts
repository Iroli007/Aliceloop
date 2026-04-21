import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ToolSchemaLifecycle } from "./toolRegistry";

export interface ToolSearchCatalogEntry {
  name: string;
  description: string;
  attached: boolean;
  lifecycle: ToolSchemaLifecycle | "external";
}

function normalizeText(value: string) {
  return value.trim().toLowerCase();
}

function tokenizeQuery(query: string) {
  return normalizeText(query)
    .split(/[\s/,_-]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

function scoreCatalogEntry(entry: ToolSearchCatalogEntry, query: string, tokens: string[]) {
  if (!query) {
    return 0;
  }

  const normalizedName = normalizeText(entry.name);
  const haystack = `${normalizedName} ${normalizeText(entry.description)}`;
  let score = 0;

  if (normalizedName === query) {
    score += 120;
  }
  if (normalizedName.includes(query)) {
    score += 60;
  }
  if (haystack.includes(query)) {
    score += 24;
  }

  for (const token of tokens) {
    if (token.length < 2) {
      continue;
    }

    if (normalizedName.includes(token)) {
      score += 18;
      continue;
    }

    if (haystack.includes(token)) {
      score += 8;
    }
  }

  if (entry.attached) {
    score += 6;
  }
  if (entry.lifecycle === "base") {
    score += 3;
  } else if (entry.lifecycle === "session-stable") {
    score += 2;
  }

  return score;
}

function compareCatalogEntries(left: ToolSearchCatalogEntry, right: ToolSearchCatalogEntry) {
  if (left.attached !== right.attached) {
    return left.attached ? -1 : 1;
  }

  const lifecycleOrder: Record<ToolSearchCatalogEntry["lifecycle"], number> = {
    base: 0,
    "session-stable": 1,
    dynamic: 2,
    volatile: 3,
    external: 4,
  };
  const lifecycleCompare = lifecycleOrder[left.lifecycle] - lifecycleOrder[right.lifecycle];
  if (lifecycleCompare !== 0) {
    return lifecycleCompare;
  }

  return left.name.localeCompare(right.name, "en");
}

export function createToolSearchTool(catalogEntries: ToolSearchCatalogEntry[]): ToolSet {
  const dedupedCatalog = [...catalogEntries]
    .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.name === entry.name) === index)
    .sort(compareCatalogEntries);

  return {
    tool_search: tool({
      description:
        "Search Aliceloop's available tools by name and description. Use this when the task is about what tools exist, which tool matches a capability, or when a specialized tool may be missing from the current visible set.",
      inputSchema: z.object({
        query: z.string().describe("Natural-language description of the capability or tool you are looking for"),
        limit: z.number().int().min(1).max(25).default(8).describe("Maximum number of matching tools to return"),
      }),
      execute: async ({ query, limit }) => {
        const normalizedQuery = normalizeText(query);
        const tokens = tokenizeQuery(query);
        const genericCatalogQuery = /(?:tool|tools|skill|skills|capabilit|工具|能力|可用|available)/iu.test(query);

        const rankedEntries = dedupedCatalog
          .map((entry) => ({
            entry,
            score: scoreCatalogEntry(entry, normalizedQuery, tokens),
          }))
          .filter(({ score }) => genericCatalogQuery || score > 0)
          .sort((left, right) => right.score - left.score || compareCatalogEntries(left.entry, right.entry));

        const matches = (rankedEntries.length > 0 ? rankedEntries : dedupedCatalog.map((entry) => ({ entry, score: 0 })))
          .slice(0, limit)
          .map(({ entry, score }) => ({
            name: entry.name,
            description: entry.description,
            attached: entry.attached,
            lifecycle: entry.lifecycle,
            score,
          }));

        return {
          query,
          totalCatalogSize: dedupedCatalog.length,
          totalMatches: matches.length,
          matches,
        };
      },
    }),
  };
}

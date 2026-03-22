import { tool } from "ai";
import { z } from "zod";

const DEFAULT_SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";
const SEARCH_TIMEOUT_MS = 15_000;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function decodeHtmlEntities(text: string) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function stripHtml(html: string) {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function normalizeDuckDuckGoUrl(rawHref: string, endpoint: URL) {
  const href = rawHref.trim();
  if (!href) {
    return "";
  }

  try {
    const absolute = href.startsWith("//")
      ? new URL(`https:${href}`)
      : new URL(href, endpoint);

    const redirected = absolute.searchParams.get("uddg");
    if (redirected) {
      return decodeURIComponent(redirected);
    }

    return absolute.toString();
  } catch {
    return href;
  }
}

function parseHtmlResults(html: string, endpoint: URL, limit: number) {
  const results: SearchResult[] = [];
  const anchorPattern = /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null = null;

  while ((match = anchorPattern.exec(html)) && results.length < limit) {
    const url = normalizeDuckDuckGoUrl(match[1], endpoint);
    const title = stripHtml(match[2]);
    const nearbyHtml = html.slice(match.index, match.index + 1500);
    const snippetMatch = nearbyHtml.match(
      /<(?:a|div|span)[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i,
    );
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : "";

    if (!title || !url) {
      continue;
    }

    results.push({
      title,
      url,
      snippet,
    });
  }

  return results;
}

function normalizeJsonResults(payload: unknown, limit: number) {
  const rawResults = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && "results" in payload && Array.isArray(payload.results)
      ? payload.results
      : [];

  return rawResults
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const title = typeof item.title === "string" ? item.title.trim() : "";
      const url = typeof item.url === "string" ? item.url.trim() : "";
      const snippet = typeof item.snippet === "string" ? item.snippet.trim() : "";

      if (!title || !url) {
        return null;
      }

      return {
        title,
        url,
        snippet,
      } satisfies SearchResult;
    })
    .filter((item): item is SearchResult => Boolean(item))
    .slice(0, limit);
}

function buildSearchUrl(query: string, domains: string[]) {
  const endpointText = process.env.ALICELOOP_WEB_SEARCH_ENDPOINT?.trim() || DEFAULT_SEARCH_ENDPOINT;
  const scopedQuery = domains.length > 0 ? `${query} ${domains.map((domain) => `site:${domain}`).join(" ")}` : query;

  if (endpointText.includes("{query}")) {
    return endpointText.replace("{query}", encodeURIComponent(scopedQuery));
  }

  const url = new URL(endpointText);
  url.searchParams.set("q", scopedQuery);
  return url.toString();
}

export function createWebSearchTool() {
  return {
    web_search: tool({
      description:
        "Search the public web for fresh information and source discovery. " +
        "Returns a compact JSON payload of titles, URLs, and snippets. " +
        "Use this before web_fetch when you need current or source-finding work.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Search query"),
        maxResults: z.number().int().min(1).max(10).optional().default(5),
        domains: z.array(z.string().min(1)).max(5).optional().default([]).describe("Optional domains to scope with site:"),
      }),
      execute: async ({ query, maxResults, domains }) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
        const searchUrl = buildSearchUrl(query, domains);

        try {
          const response = await fetch(searchUrl, {
            signal: controller.signal,
            headers: {
              "User-Agent": "Aliceloop/1.0 (web_search tool)",
              Accept: "text/html, application/json, text/plain, */*",
            },
            redirect: "follow",
          });

          if (!response.ok) {
            return JSON.stringify({
              error: `HTTP ${response.status} ${response.statusText}`,
              query,
              searchUrl,
            });
          }

          const contentType = response.headers.get("content-type") ?? "";
          const rawBody = await response.text();
          const endpoint = new URL(searchUrl);

          const results = contentType.includes("application/json")
            ? normalizeJsonResults(JSON.parse(rawBody), maxResults)
            : parseHtmlResults(rawBody, endpoint, maxResults);

          return JSON.stringify(
            {
              query,
              searchUrl,
              results,
            },
            null,
            2,
          );
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            return JSON.stringify({
              error: `Request timed out after ${SEARCH_TIMEOUT_MS / 1000}s`,
              query,
              searchUrl,
            });
          }

          const message = error instanceof Error ? error.message : String(error);
          return JSON.stringify({
            error: message,
            query,
            searchUrl,
          });
        } finally {
          clearTimeout(timeout);
        }
      },
    }),
  };
}

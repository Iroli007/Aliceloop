import { tool } from "ai";
import { z } from "zod";
import { withDesktopRelayTab, navigateRelayTab, readRelaySearchResults } from "./desktopRelayResearch";
import { logPerfTrace, nowMs, roundMs } from "../../runtime/perfTrace";

const DEFAULT_SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";
const SEARCH_TIMEOUT_MS = 15_000;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  sourceType: SearchSourceType;
  score: number;
  reasons: string[];
}

function createSearchResult(input: {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  sourceType: SearchSourceType;
}): SearchResult {
  return {
    ...input,
    score: 0,
    reasons: [],
  };
}

function isSearchResult(value: SearchResult | null): value is SearchResult {
  return Boolean(value);
}

type SearchSourceType =
  | "official"
  | "platform"
  | "news"
  | "analytics"
  | "encyclopedia"
  | "community"
  | "unknown";

interface SearchQueryIntent {
  needsFreshness: boolean;
  needsHistoricalSnapshot: boolean;
  asksMetric: boolean;
  mentionsBilibili: boolean;
}

const ENCYCLOPEDIA_HOST_PATTERNS = [
  "baike.baidu.com",
  "wikipedia.org",
  "wikiwand.com",
  "hudong.com",
  "baike.com",
];

const NEWS_HOST_PATTERNS = [
  "news",
  "thepaper.cn",
  "36kr.com",
  "ithome.com",
  "jiemian.com",
  "bjnews.com.cn",
  "caixin.com",
];

const ANALYTICS_HOST_PATTERNS = [
  "mcndata.cn",
  "socialblade.com",
  "newrank.cn",
  "toobigdata.com",
];

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

function extractDomain(rawUrl: string) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function hostMatches(domain: string, patterns: string[]) {
  return patterns.some((pattern) => {
    return domain === pattern || domain.endsWith(`.${pattern}`) || domain.includes(pattern);
  });
}

function classifySourceType(domain: string): SearchSourceType {
  if (!domain) {
    return "unknown";
  }

  if (hostMatches(domain, ENCYCLOPEDIA_HOST_PATTERNS)) {
    return "encyclopedia";
  }

  if (domain === "bilibili.com" || domain.endsWith(".bilibili.com")) {
    return "platform";
  }

  if (hostMatches(domain, ANALYTICS_HOST_PATTERNS)) {
    return "analytics";
  }

  if (hostMatches(domain, NEWS_HOST_PATTERNS)) {
    return "news";
  }

  if (
    domain.endsWith(".gov") ||
    domain.endsWith(".gov.cn") ||
    domain.endsWith(".edu") ||
    domain.endsWith(".edu.cn") ||
    domain.endsWith(".org") ||
    domain.endsWith(".org.cn") ||
    domain.endsWith(".ac.cn")
  ) {
    return "official";
  }

  if (domain.endsWith(".com") || domain.endsWith(".cn")) {
    return "community";
  }

  return "unknown";
}

function analyzeQueryIntent(query: string): SearchQueryIntent {
  const normalized = query.trim().toLowerCase();
  return {
    needsFreshness: /最新|实时|当前|现在|今日|今天|最近|截至|截止|latest|current|today|now|real[- ]?time/i.test(normalized),
    needsHistoricalSnapshot: /(?:\d{4}[年/-]\d{1,2}[月/-]\d{1,2}日?)|(?:\d{1,2}月\d{1,2}日)|(?:march|april|may|june|july|august|september|october|november|december|january|february)\s+\d{1,2}/i.test(
      normalized,
    ),
    asksMetric: /粉丝|粉絲|followers?|播放|点赞|点赞量|订阅|订阅数|阅读量|销量|股价|市值|排名|score|price|rank/i.test(
      normalized,
    ),
    mentionsBilibili: /b站|哔哩哔哩|bilibili|up主|up\s*主/i.test(normalized),
  };
}

function scoreResult(
  result: Pick<SearchResult, "title" | "url" | "snippet" | "domain" | "sourceType">,
  index: number,
  intent: SearchQueryIntent,
  scopedDomains: string[],
) {
  let score = Math.max(1, 12 - index);
  const reasons: string[] = [`search-rank:${index + 1}`];

  if (scopedDomains.some((domain) => result.domain === domain || result.domain.endsWith(`.${domain}`))) {
    score += 8;
    reasons.push("domain-scoped");
  }

  if (intent.mentionsBilibili && result.domain.endsWith("bilibili.com")) {
    score += 8;
    reasons.push("platform-match:bilibili");
  }

  if (intent.asksMetric && result.sourceType === "platform") {
    score += 6;
    reasons.push("metric-source:platform");
  }

  if (intent.asksMetric && result.sourceType === "analytics") {
    score += 4;
    reasons.push("metric-source:analytics");
  }

  if ((intent.needsFreshness || intent.needsHistoricalSnapshot) && result.sourceType === "news") {
    score += 4;
    reasons.push("time-sensitive:news");
  }

  if (intent.needsFreshness && result.sourceType === "official") {
    score += 4;
    reasons.push("freshness:official");
  }

  if ((intent.needsFreshness || intent.needsHistoricalSnapshot || intent.asksMetric) && result.sourceType === "encyclopedia") {
    score -= 12;
    reasons.push("penalty:encyclopedia-for-time-sensitive-query");
  }

  if (intent.needsHistoricalSnapshot && /截至|截止|updated|published|发布|日期|time/i.test(`${result.title} ${result.snippet}`)) {
    score += 2;
    reasons.push("has-time-cue");
  }

  return {
    score,
    reasons,
  };
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

    const domain = extractDomain(url);

    results.push({
      ...createSearchResult({
        title,
        url,
        snippet,
        domain,
        sourceType: classifySourceType(domain),
      }),
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

      const domain = extractDomain(url);

      return createSearchResult({
        title,
        url,
        snippet,
        domain,
        sourceType: classifySourceType(domain),
      });
    })
    .filter(isSearchResult)
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

export function createWebSearchTool(sessionId = "web_search") {
  return {
    web_search: tool({
      description:
        "Search the public web for fresh information and source discovery. " +
        "Returns a compact JSON payload of titles, URLs, and snippets. " +
        "On Aliceloop Desktop this prefers a temporary visible Chrome relay tab before falling back to the configured HTTP search endpoint. " +
        "Use this before web_fetch when you need current or source-finding work.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Search query"),
        maxResults: z.number().int().min(1).max(10).optional().default(5),
        domains: z.array(z.string().min(1)).max(5).optional().default([]).describe("Optional domains to scope with site:"),
      }),
      execute: async ({ query, maxResults, domains }) => {
        const startedAt = nowMs();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
        const searchUrl = buildSearchUrl(query, domains);
        let relayFallbackReason: string | null = null;

        try {
          let relayResults = null;
          try {
            relayResults = await withDesktopRelayTab(async (relay, tabId) => {
              await navigateRelayTab(relay, tabId, searchUrl, "load");
              return readRelaySearchResults(relay, tabId, maxResults);
            });
          } catch (error) {
            relayFallbackReason = error instanceof Error ? error.message : String(error);
          }

          if (relayResults && relayResults.results.length > 0) {
            const intent = analyzeQueryIntent(query);
            const normalizedDomains = domains.map((domain) => domain.trim().toLowerCase()).filter(Boolean);
            const results = relayResults.results
              .map((result, index) => {
                const hydrated = createSearchResult({
                  title: result.title,
                  url: result.url,
                  snippet: result.snippet,
                  domain: result.domain,
                  sourceType: classifySourceType(result.domain),
                });
                const { score, reasons } = scoreResult(hydrated, index, intent, normalizedDomains);
                return {
                  ...hydrated,
                  score,
                  reasons,
                };
              })
              .sort((left, right) => right.score - left.score || left.url.localeCompare(right.url))
              .slice(0, maxResults);

            logPerfTrace("web_search", {
              sessionId,
              query,
              backend: relayResults.backend,
              totalMs: roundMs(nowMs() - startedAt),
              resultCount: results.length,
            });

            return JSON.stringify(
              {
                query,
                searchUrl: relayResults.url,
                backend: relayResults.backend,
                queryAnalysis: intent,
                results,
              },
              null,
              2,
            );
          }

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

          const rawResults = contentType.includes("application/json")
            ? normalizeJsonResults(JSON.parse(rawBody), maxResults)
            : parseHtmlResults(rawBody, endpoint, maxResults);

          const intent = analyzeQueryIntent(query);
          const normalizedDomains = domains.map((domain) => domain.trim().toLowerCase()).filter(Boolean);
          const results = rawResults
            .map((result, index) => {
              const { score, reasons } = scoreResult(result, index, intent, normalizedDomains);
              return {
                ...result,
                score,
                reasons,
              };
            })
            .sort((left, right) => right.score - left.score || left.url.localeCompare(right.url))
            .slice(0, maxResults);

          logPerfTrace("web_search", {
            sessionId,
            query,
            backend: "http_fetch",
            totalMs: roundMs(nowMs() - startedAt),
            resultCount: results.length,
            relayFallbackReason,
          });

          return JSON.stringify(
            {
              query,
              searchUrl,
              backend: "http_fetch",
              queryAnalysis: intent,
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
          logPerfTrace("web_search", {
            sessionId,
            query,
            backend: "error",
            totalMs: roundMs(nowMs() - startedAt),
            error: message,
          });
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

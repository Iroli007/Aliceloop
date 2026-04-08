import { tool } from "ai";
import { z } from "zod";
import { withDesktopRelayTab, navigateRelayTab, readRelaySearchResults } from "./desktopRelayResearch";
import { logPerfTrace, nowMs, roundMs } from "../../runtime/perfTrace";
import { fetchReadableWebContent, summarizeReadableText } from "./webFetchTool";
import { STABLE_TOOL_PROVIDER_OPTIONS } from "./toolProviderOptions";

const DEFAULT_SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/";
const SEARCH_TIMEOUT_MS = 30_000;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  domain: string;
  sourceType: SearchSourceType;
  score: number;
  reasons: string[];
  citationIndex?: number;
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
  asksFollowerMetric: boolean;
  needsPrimaryPlatformSweep: boolean;
  mentionsBilibili: boolean;
  mentionsDouyin: boolean;
  mentionsTwitter: boolean;
  mentionsNga: boolean;
  mentionsMoegirl: boolean;
  asksBiography: boolean;
}

interface SearchQueryPlan {
  anchorQuery: string;
  splitTerms: string[];
  searchQueries: string[];
}

interface SearchLaneResult {
  query: string;
  searchUrl: string;
  backend: "desktop_chrome" | "http_search";
  rawResults: SearchResult[];
  error?: string;
}

interface SearchResultPayload {
  title: string;
  url: string;
  snippet: string;
  summary?: string;
  fetchedAt?: string;
  truncated?: boolean;
  wordCount?: number;
  markdown?: string;
  domain: string;
  sourceType: SearchSourceType;
  citationIndex?: number;
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

function normalizeInlineText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function extractQuotedPhrases(query: string) {
  const matches = [...query.matchAll(/"([^"]+)"|“([^”]+)”|'([^']+)'/g)];
  return matches
    .map((match) => (match[1] ?? match[2] ?? match[3] ?? "").trim())
    .filter(Boolean);
}

function splitSearchQuery(query: string) {
  const normalized = normalizeInlineText(query);
  const unquoted = normalized.replace(/"([^"]+)"|“([^”]+)”|'([^']+)'/g, " $1$2$3 ");
  const splitTerms = unquoted
    .split(/\s+\bOR\b\s+|\s+\bAND\b\s+|[|｜]/i)
    .map((part) => normalizeInlineText(part))
    .filter(Boolean);
  const anchorQuery = extractQuotedPhrases(normalized)[0] ?? splitTerms[0] ?? normalized;
  const searchQueries = [
    normalized,
    ...splitTerms.map((term) => {
      if (term.includes(anchorQuery)) {
        return term;
      }

      return `${anchorQuery} ${term}`.trim();
    }),
  ];

  return {
    anchorQuery,
    splitTerms,
    searchQueries: [...new Set(searchQueries)].slice(0, 3),
  };
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

  if (
    domain === "bilibili.com"
    || domain.endsWith(".bilibili.com")
    || domain === "douyin.com"
    || domain.endsWith(".douyin.com")
    || domain === "iesdouyin.com"
    || domain.endsWith(".iesdouyin.com")
    || domain === "x.com"
    || domain.endsWith(".x.com")
    || domain === "twitter.com"
    || domain.endsWith(".twitter.com")
  ) {
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
  const asksFollowerMetric = /粉丝|粉絲|followers?|关注者|多少粉/u.test(normalized);
  const asksPlatformActivity = /动态|活动|发了什么|发了啥|更新|投稿|视频|作品|直播|帖子|post|tweet|更新了什么/u.test(normalized);
  return {
    needsFreshness: /最新|实时|当前|现在|今日|今天|最近|截至|截止|latest|current|today|now|real[- ]?time/i.test(normalized),
    needsHistoricalSnapshot: /(?:\d{4}[年/-]\d{1,2}[月/-]\d{1,2}日?)|(?:\d{1,2}月\d{1,2}日)|(?:march|april|may|june|july|august|september|october|november|december|january|february)\s+\d{1,2}/i.test(
      normalized,
    ),
    asksMetric: /粉丝|粉絲|followers?|播放|点赞|点赞量|订阅|订阅数|阅读量|销量|股价|市值|排名|score|price|rank/i.test(
      normalized,
    ),
    asksFollowerMetric,
    needsPrimaryPlatformSweep: asksFollowerMetric || asksPlatformActivity,
    mentionsBilibili: /b站|哔哩哔哩|bilibili|up主|up\s*主/i.test(normalized),
    mentionsDouyin: /抖音|douyin|iesdouyin/i.test(normalized),
    mentionsTwitter: /推特|twitter|x\.com|tweet|tweets/i.test(normalized),
    mentionsNga: /(?:^|[\s\u4e00-\u9fa5])nga(?:$|[\s\u4e00-\u9fa5])|艾泽拉斯国家地理|nga论坛|nga帖子|nga贴子|nga讨论/u.test(normalized),
    mentionsMoegirl: /萌娘百科|萌百|moegirl|moegirl\.org/i.test(normalized),
    asksBiography: /谁是|是谁|简介|介绍|百科|生平|人物|出生|哪里人|个人资料|背景/i.test(normalized),
  };
}

function buildEffectiveQuery(query: string, intent: SearchQueryIntent) {
  if (
    intent.needsPrimaryPlatformSweep
    && !intent.mentionsBilibili
    && !intent.mentionsDouyin
    && !intent.mentionsTwitter
    && !intent.asksBiography
  ) {
    return `${query} B站 抖音 推特 bilibili douyin twitter`;
  }

  return query;
}

function buildSearchQueryPlan(query: string, intent: SearchQueryIntent) {
  const normalized = normalizeInlineText(query);
  const split = splitSearchQuery(normalized);
  const laneQueries = new Set<string>();
  laneQueries.add(buildEffectiveQuery(normalized, intent));

  for (const term of split.splitTerms) {
    const expanded = term.includes(split.anchorQuery)
      ? term
      : `${split.anchorQuery} ${term}`.trim();
    laneQueries.add(buildEffectiveQuery(expanded, intent));
  }

  return {
    anchorQuery: split.anchorQuery,
    splitTerms: split.splitTerms,
    searchQueries: [...laneQueries].slice(0, 3),
  } satisfies SearchQueryPlan;
}

function normalizeScopedDomains(domains: string[] | undefined, intent: SearchQueryIntent) {
  const normalized = (domains ?? []).map((domain) => domain.trim().toLowerCase()).filter(Boolean);
  if (intent.mentionsBilibili && (intent.asksMetric || intent.needsFreshness || intent.needsHistoricalSnapshot)) {
    normalized.push("bilibili.com");
  }
  if (intent.mentionsDouyin && (intent.asksMetric || intent.needsFreshness || intent.needsHistoricalSnapshot)) {
    normalized.push("douyin.com", "iesdouyin.com");
  }
  if (intent.mentionsTwitter && (intent.asksMetric || intent.needsFreshness || intent.needsHistoricalSnapshot)) {
    normalized.push("x.com", "twitter.com");
  }
  if (intent.mentionsNga) {
    normalized.push("nga.178.com", "bbs.nga.cn", "g.nga.cn");
  }
  if (intent.mentionsMoegirl) {
    normalized.push("mzh.moegirl.org.cn", "zh.moegirl.org.cn", "moegirl.org.cn");
  }

  return [...new Set(normalized)];
}

function dedupeSearchResults(results: SearchResult[]) {
  const seen = new Map<string, SearchResult>();
  for (const result of results) {
    if (!seen.has(result.url)) {
      seen.set(result.url, result);
    }
  }

  return [...seen.values()];
}

function serializeSearchResult(result: SearchResult): SearchResultPayload {
  const payload: SearchResultPayload = {
    title: result.title,
    url: result.url,
    snippet: result.snippet,
    domain: result.domain,
    sourceType: result.sourceType,
  };
  if (result.citationIndex !== undefined) {
    payload.citationIndex = result.citationIndex;
  }

  return payload;
}

async function enrichSearchResult(
  sessionId: string,
  result: SearchResult,
  includeMarkdown: boolean,
) {
  try {
    const fetched = await fetchReadableWebContent(sessionId, {
      url: result.url,
      extractMain: true,
      maxLength: includeMarkdown ? 4_000 : 1_600,
      timeoutMs: 8_000,
      preferRelay: false,
    });

    return {
      summary: summarizeReadableText(fetched.content),
      fetchedAt: fetched.fetchedAt,
      truncated: fetched.truncated,
      wordCount: fetched.wordCount,
      markdown: includeMarkdown ? fetched.content : undefined,
    };
  } catch {
    const fetchedAt = new Date().toISOString();
    const summary = summarizeReadableText(result.snippet);
    return {
      summary,
      fetchedAt,
      truncated: false,
      wordCount: summary ? summary.split(/\s+/u).filter(Boolean).length : 0,
      markdown: includeMarkdown ? result.snippet : undefined,
    };
  }
}

async function searchLaneViaHttp(
  query: string,
  domains: string[],
  maxResults: number,
  signal: AbortSignal,
): Promise<SearchLaneResult> {
  const searchUrl = buildSearchUrl(query, domains);
  try {
    const response = await fetch(searchUrl, {
      signal,
      headers: {
        "User-Agent": "Aliceloop/1.0 (web_search tool)",
        Accept: "text/html, application/json, text/plain, */*",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      return {
        query,
        searchUrl,
        backend: "http_search",
        rawResults: [],
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    const rawBody = await response.text();
    const endpoint = new URL(searchUrl);
    const rawResults = contentType.includes("application/json")
      ? normalizeJsonResults(JSON.parse(rawBody), maxResults)
      : parseHtmlResults(rawBody, endpoint, maxResults);

    return {
      query,
      searchUrl,
      backend: "http_search",
      rawResults,
    };
  } catch (error) {
    return {
      query,
      searchUrl,
      backend: "http_search",
      rawResults: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function collectSearchLaneResults(
  sessionId: string,
  searchQueries: string[],
  domains: string[],
  maxResults: number,
  signal: AbortSignal,
): Promise<SearchLaneResult[]> {
  const relayResults = await withDesktopRelayTab(sessionId, async (relay, tabId) => {
    const runs: SearchLaneResult[] = [];

    for (const query of searchQueries) {
      const searchUrl = buildSearchUrl(query, domains);
      try {
        await navigateRelayTab(relay, tabId, searchUrl, "domcontentloaded");
        const relaySearch = await readRelaySearchResults(relay, tabId, maxResults);
        if (relaySearch.results.length > 0) {
          runs.push({
            query,
            searchUrl: relaySearch.url,
            backend: relaySearch.backend,
            rawResults: relaySearch.results.map((result) => {
              return createSearchResult({
                title: result.title,
                url: result.url,
                snippet: result.snippet,
                domain: result.domain,
                sourceType: classifySourceType(result.domain),
              });
            }),
          });
          continue;
        }
      } catch {
        // Fall back to the configured HTTP endpoint for this lane.
      }

      runs.push(await searchLaneViaHttp(query, domains, maxResults, signal));
    }

    return runs;
  });

  if (relayResults) {
    return relayResults;
  }

  const httpResults: SearchLaneResult[] = [];
  for (const query of searchQueries) {
    httpResults.push(await searchLaneViaHttp(query, domains, maxResults, signal));
  }
  return httpResults;
}

function matchesScopedDomain(domain: string, scopedDomains: string[]) {
  return scopedDomains.some((scopedDomain) => domain === scopedDomain || domain.endsWith(`.${scopedDomain}`));
}

function scoreResult(
  result: Pick<SearchResult, "title" | "url" | "snippet" | "domain" | "sourceType">,
  index: number,
  intent: SearchQueryIntent,
  scopedDomains: string[],
) {
  let score = Math.max(1, 12 - index);
  const reasons: string[] = [`search-rank:${index + 1}`];

  if (matchesScopedDomain(result.domain, scopedDomains)) {
    score += 8;
    reasons.push("domain-scoped");
  }

  if (intent.mentionsBilibili && result.domain.endsWith("bilibili.com")) {
    score += 8;
    reasons.push("platform-match:bilibili");
  }
  if (intent.mentionsDouyin && (result.domain.endsWith("douyin.com") || result.domain.endsWith("iesdouyin.com"))) {
    score += 8;
    reasons.push("platform-match:douyin");
  }
  if (intent.mentionsTwitter && (result.domain === "x.com" || result.domain.endsWith(".x.com") || result.domain.endsWith("twitter.com"))) {
    score += 8;
    reasons.push("platform-match:twitter");
  }

  if (intent.asksMetric && result.sourceType === "platform") {
    score += 6;
    reasons.push("metric-source:platform");
  }

  if (intent.asksFollowerMetric && result.sourceType === "platform") {
    score += 8;
    reasons.push("follower-metric-source:platform");
  }

  if (intent.asksMetric && result.sourceType === "analytics") {
    score += 4;
    reasons.push("metric-source:analytics");
  }

  if (intent.asksFollowerMetric && result.sourceType === "analytics") {
    score += 3;
    reasons.push("follower-metric-source:analytics");
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

  if (intent.asksFollowerMetric && result.sourceType === "encyclopedia") {
    score -= 10;
    reasons.push("penalty:encyclopedia-for-follower-query");
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

function shouldSuppressEncyclopedia(result: SearchResult, intent: SearchQueryIntent, scopedDomains: string[]) {
  if (result.sourceType !== "encyclopedia") {
    return false;
  }

  return intent.needsFreshness
    || intent.needsHistoricalSnapshot
    || intent.asksMetric
    || intent.asksFollowerMetric
    || intent.needsPrimaryPlatformSweep
    || intent.mentionsBilibili
    || scopedDomains.length > 0
    || !intent.asksBiography;
}

function rankAndFilterResults(
  rawResults: SearchResult[],
  intent: SearchQueryIntent,
  scopedDomains: string[],
  maxResults: number,
) {
  const ranked = rawResults
    .map((result, index) => {
      const { score, reasons } = scoreResult(result, index, intent, scopedDomains);
      return {
        ...result,
        score,
        reasons,
      };
    })
    .sort((left, right) => right.score - left.score || left.url.localeCompare(right.url));

  const hasScopedMatch = scopedDomains.length > 0 && ranked.some((result) => matchesScopedDomain(result.domain, scopedDomains));
  const hasNonEncyclopediaAlternative = ranked.some((result) => result.sourceType !== "encyclopedia");

  const filtered = ranked.filter((result) => {
    if (hasScopedMatch && scopedDomains.length > 0 && !matchesScopedDomain(result.domain, scopedDomains) && result.sourceType === "encyclopedia") {
      return false;
    }

    if (hasNonEncyclopediaAlternative && shouldSuppressEncyclopedia(result, intent, scopedDomains)) {
      return false;
    }

    return true;
  });

  return (filtered.length > 0 ? filtered : ranked).slice(0, maxResults);
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
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
      description:
        "Search the public web for fresh information and source discovery. " +
        "It splits the query into up to three keyword lanes, returns up to 10 ranked results, and can enrich each result with fetched summaries. " +
        "On Aliceloop Desktop this prefers a temporary visible Chrome relay tab before falling back to the configured HTTP search endpoint. " +
        "Use this before web_fetch when you need current or source-finding work.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Search query"),
        max_results: z.number().int().min(1).max(10).optional().default(10).describe("Maximum results to return"),
        maxResults: z.number().int().min(1).max(10).optional().describe("Compatibility alias for max_results"),
        include_markdown: z.boolean().optional().default(false).describe("Whether to attach fetched markdown for each result"),
        includeMarkdown: z.boolean().optional().describe("Compatibility alias for include_markdown"),
        domains: z.array(z.string().min(1)).max(5).optional().describe("Optional domains to scope with site:"),
      }),
      execute: async ({ query, max_results, maxResults, include_markdown, includeMarkdown, domains }) => {
        const startedAt = nowMs();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
        const intent = analyzeQueryIntent(query);
        const queryPlan = buildSearchQueryPlan(query, intent);
        const normalizedDomains = normalizeScopedDomains(domains, intent);
        const resolvedMaxResults = max_results ?? maxResults ?? 10;
        const resolvedIncludeMarkdown = include_markdown ?? includeMarkdown ?? false;
        const effectiveQuery = queryPlan.searchQueries[0] ?? query;

        try {
          const laneRuns = await collectSearchLaneResults(
            sessionId,
            queryPlan.searchQueries,
            normalizedDomains,
            resolvedMaxResults,
            controller.signal,
          );

          const laneSummaries = laneRuns.map((lane) => ({
            query: lane.query,
            searchUrl: lane.searchUrl,
            backend: lane.backend,
            resultCount: lane.rawResults.length,
            error: lane.error,
          }));

          const mergedResults = dedupeSearchResults(laneRuns.flatMap((lane) => lane.rawResults));
          const rankedResults = rankAndFilterResults(mergedResults, intent, normalizedDomains, resolvedMaxResults);
          const enrichedResults = await Promise.all(
            rankedResults.map((result) => enrichSearchResult(sessionId, result, resolvedIncludeMarkdown)),
          );
          const results = rankedResults.map((result, index) => ({
            ...serializeSearchResult({
              ...result,
              citationIndex: index + 1,
            }),
            ...enrichedResults[index],
          }));
          const sources = results.map((result) => ({
            citationIndex: result.citationIndex,
            title: result.title,
            url: result.url,
            domain: result.domain,
            sourceType: result.sourceType,
          }));
          const backend = laneRuns.find((lane) => lane.backend === "desktop_chrome")?.backend
            ?? laneRuns[0]?.backend
            ?? "http_search";

          logPerfTrace("web_search", {
            sessionId,
            query,
            backend,
            totalMs: roundMs(nowMs() - startedAt),
            resultCount: results.length,
            searchLaneCount: laneRuns.length,
          });

          return JSON.stringify(
            {
              query,
              backend,
              effectiveQuery,
              effectiveDomains: normalizedDomains,
              searchUrl: laneRuns[0]?.searchUrl ?? buildSearchUrl(queryPlan.searchQueries[0] ?? query, normalizedDomains),
              searchUrls: laneRuns.map((lane) => lane.searchUrl),
              queryAnalysis: {
                ...intent,
                anchorQuery: queryPlan.anchorQuery,
                splitTerms: queryPlan.splitTerms,
                searchQueries: queryPlan.searchQueries,
                effectiveDomains: normalizedDomains,
                effectiveQuery,
              },
              searches: laneSummaries,
              results,
              sources,
            },
            null,
            2,
          );
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            return JSON.stringify({
              error: `Request timed out after ${SEARCH_TIMEOUT_MS / 1000}s`,
              query,
              queryAnalysis: {
                ...intent,
                anchorQuery: queryPlan.anchorQuery,
                splitTerms: queryPlan.splitTerms,
                searchQueries: queryPlan.searchQueries,
                effectiveDomains: normalizedDomains,
              },
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
            queryAnalysis: {
              ...intent,
              anchorQuery: queryPlan.anchorQuery,
              splitTerms: queryPlan.splitTerms,
              searchQueries: queryPlan.searchQueries,
              effectiveDomains: normalizedDomains,
            },
          });
        } finally {
          clearTimeout(timeout);
        }
      },
    }),
  };
}

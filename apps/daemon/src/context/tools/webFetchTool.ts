import { z } from "zod";
import { tool } from "ai";
import TurndownService from "turndown";
import { withDesktopRelayTab, navigateRelayTab, readRelayReadableContent } from "./desktopRelayResearch";
import { logPerfTrace, nowMs, roundMs } from "../../runtime/perfTrace";
import { STABLE_TOOL_PROVIDER_OPTIONS } from "./toolProviderOptions";

const MAX_CONTENT_LENGTH = 50_000;
const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_SUMMARY_LENGTH = 240;

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

// Strip noisy elements before conversion
turndown.remove(["script", "style", "nav", "footer", "iframe", "noscript"]);

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[… truncated at ${limit} characters]`;
}

function countWords(text: string) {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

function stripMarkdown(text: string) {
  return text
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[*_~>#-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function summarizeReadableText(text: string, maxLength = DEFAULT_SUMMARY_LENGTH) {
  const normalized = stripMarkdown(text);
  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength).trimEnd()}...`;
}

interface HtmlMetadata {
  title: string | null;
  publishedAt: string | null;
  modifiedAt: string | null;
}

function extractFirstMatch(html: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }

  return null;
}

function extractHtmlMetadata(html: string): HtmlMetadata {
  const title = extractFirstMatch(html, [/<title[^>]*>([\s\S]*?)<\/title>/i]);
  const publishedAt = extractFirstMatch(html, [
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']pubdate["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']publishdate["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /"datePublished"\s*:\s*"([^"]+)"/i,
    /<time[^>]+datetime=["']([^"']+)["'][^>]*>/i,
  ]);
  const modifiedAt = extractFirstMatch(html, [
    /<meta[^>]+property=["']article:modified_time["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+name=["']lastmod["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /"dateModified"\s*:\s*"([^"]+)"/i,
  ]);

  return {
    title,
    publishedAt,
    modifiedAt,
  };
}

function buildReadableSourceHeader(input: {
  url: string;
  backend: "desktop_chrome" | "http_fetch";
  title: string | null;
  publishedAt: string | null;
  modifiedAt: string | null;
}) {
  const domain = (() => {
    try {
      return new URL(input.url).hostname;
    } catch {
      return "";
    }
  })();

  const lines = [
    `Source URL: ${input.url}`,
    `Source Domain: ${domain || "unknown"}`,
    `Retrieved At: ${new Date().toISOString()}`,
    `Fetch Backend: ${input.backend}`,
  ];

  if (input.title) {
    lines.push(`Page Title: ${input.title}`);
  }

  if (input.publishedAt) {
    lines.push(`Published At: ${input.publishedAt}`);
  }

  if (input.modifiedAt) {
    lines.push(`Modified At: ${input.modifiedAt}`);
  }

  lines.push("", "---", "");
  return lines.join("\n");
}

/**
 * Try to extract <main> or <article> from raw HTML.
 * Falls back to full <body> if neither exists.
 */
function extractMainContent(html: string): string {
  // Simple regex extraction — good enough without a full DOM parser
  for (const tag of ["main", "article"]) {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
    const match = html.match(regex);
    if (match) return match[0];
  }

  // Fallback: strip everything outside <body>
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch ? bodyMatch[0] : html;
}

export interface ReadableWebContentPayload {
  url: string;
  backend: "desktop_chrome" | "http_fetch";
  title: string | null;
  publishedAt: string | null;
  modifiedAt: string | null;
  content: string;
  fetchedAt: string;
  truncated: boolean;
  wordCount: number;
}

export async function fetchReadableWebContent(
  sessionId: string,
  input: {
    url: string;
    extractMain?: boolean;
    maxLength?: number;
    timeoutMs?: number;
    preferRelay?: boolean;
  },
): Promise<ReadableWebContentPayload> {
  const extractMain = input.extractMain ?? true;
  const maxLength = input.maxLength ?? MAX_CONTENT_LENGTH;
  const timeoutMs = input.timeoutMs ?? FETCH_TIMEOUT_MS;
  const preferRelay = input.preferRelay ?? true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let relayResult = null;
    if (preferRelay) {
      try {
        relayResult = await withDesktopRelayTab(sessionId, async (relay, tabId) => {
          await navigateRelayTab(relay, tabId, input.url, "domcontentloaded");
          return readRelayReadableContent(relay, tabId, {
            maxTextLength: maxLength,
            extractMain,
          });
        });
      } catch {
        relayResult = null;
      }
    }

    if (relayResult) {
      const truncated = relayResult.pageText.length > maxLength;
      const content = truncate(relayResult.pageText, maxLength);
      return {
        url: relayResult.url,
        backend: relayResult.backend,
        title: relayResult.title || null,
        publishedAt: relayResult.publishedAt,
        modifiedAt: relayResult.modifiedAt,
        content,
        fetchedAt: new Date().toISOString(),
        truncated,
        wordCount: countWords(content),
      };
    }

    const response = await fetch(input.url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Aliceloop/1.0 (web_fetch tool)",
        Accept: "text/html, application/json, text/plain, */*",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const rawBody = await response.text();
    const fetchedAt = new Date().toISOString();

    if (contentType.includes("application/json") || contentType.includes("text/plain")) {
      const truncated = rawBody.length > maxLength;
      const content = truncate(rawBody, maxLength);
      return {
        url: input.url,
        backend: "http_fetch",
        title: null,
        publishedAt: null,
        modifiedAt: null,
        content,
        fetchedAt,
        truncated,
        wordCount: countWords(content),
      };
    }

    const metadata = extractHtmlMetadata(rawBody);
    const htmlChunk = extractMain ? extractMainContent(rawBody) : rawBody;
    const markdown = turndown.turndown(htmlChunk);
    const truncated = markdown.length > maxLength;
    const content = truncate(markdown, maxLength);
    return {
      url: input.url,
      backend: "http_fetch",
      title: metadata.title,
      publishedAt: metadata.publishedAt,
      modifiedAt: metadata.modifiedAt,
      content,
      fetchedAt,
      truncated,
      wordCount: countWords(content),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function createWebFetchTool(sessionId = "web_fetch") {
  return {
    web_fetch: tool({
      providerOptions: STABLE_TOOL_PROVIDER_OPTIONS,
      description:
        "Fetch the content of a public URL and return it as readable text. " +
        "HTML pages are converted to Markdown with boilerplate removed. " +
        "JSON and plain text keep their raw payload but are stamped with source metadata. " +
        "On Aliceloop Desktop this prefers a temporary visible Chrome relay tab before falling back to raw HTTP. " +
        "Use this when a task requires inspecting a known URL (docs page, API response, article, release notes).",
      inputSchema: z.object({
        url: z
          .string()
          .url()
          .describe("The URL to fetch"),
        extractMain: z
          .boolean()
          .optional()
          .default(true)
          .describe("If true (default), extract <main>/<article> content and strip nav/footer/scripts"),
        maxLength: z
          .number()
          .int()
          .min(1000)
          .max(MAX_CONTENT_LENGTH)
          .optional()
          .default(MAX_CONTENT_LENGTH)
          .describe(`Maximum characters to return (default ${MAX_CONTENT_LENGTH})`),
      }),
      execute: async ({ url, extractMain, maxLength }) => {
        const startedAt = nowMs();
        let relayFallbackReason: string | null = null;

        try {
          try {
            const content = await fetchReadableWebContent(sessionId, {
              url,
              extractMain,
              maxLength,
              timeoutMs: FETCH_TIMEOUT_MS,
              preferRelay: true,
            });
            logPerfTrace("web_fetch", {
              sessionId,
              url,
              backend: content.backend,
              totalMs: roundMs(nowMs() - startedAt),
              extractMain,
              relayFallbackReason,
            });
            return truncate(
              `${buildReadableSourceHeader({
                url: content.url,
                backend: content.backend,
                title: content.title,
                publishedAt: content.publishedAt,
                modifiedAt: content.modifiedAt,
              })}${content.content}`,
              maxLength,
            );
          } catch (error) {
            relayFallbackReason = error instanceof Error ? error.message : String(error);
          }
          throw new Error(relayFallbackReason);
        } catch (error: unknown) {
          if (error instanceof DOMException && error.name === "AbortError") {
            return JSON.stringify({
              error: `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`,
              url,
            });
          }
          const message = error instanceof Error ? error.message : String(error);
          logPerfTrace("web_fetch", {
            sessionId,
            url,
            backend: "error",
            totalMs: roundMs(nowMs() - startedAt),
            error: message,
          });
          return JSON.stringify({ error: message, url });
        }
      },
    }),
  };
}

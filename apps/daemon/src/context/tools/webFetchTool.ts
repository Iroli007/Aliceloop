import { z } from "zod";
import { tool } from "ai";
import TurndownService from "turndown";
import { withDesktopRelayTab, navigateRelayTab, readRelayReadableContent } from "./desktopRelayResearch";
import { logPerfTrace, nowMs, roundMs } from "../../runtime/perfTrace";

const MAX_CONTENT_LENGTH = 50_000;
const FETCH_TIMEOUT_MS = 15_000;

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

function buildHtmlSourceHeader(url: string, metadata: HtmlMetadata) {
  const domain = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();

  const lines = [
    `Source URL: ${url}`,
    `Source Domain: ${domain || "unknown"}`,
    `Retrieved At: ${new Date().toISOString()}`,
  ];

  if (metadata.title) {
    lines.push(`Page Title: ${metadata.title}`);
  }

  if (metadata.publishedAt) {
    lines.push(`Published At: ${metadata.publishedAt}`);
  }

  if (metadata.modifiedAt) {
    lines.push(`Modified At: ${metadata.modifiedAt}`);
  }

  lines.push("", "---", "");
  return lines.join("\n");
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

export function createWebFetchTool(sessionId = "web_fetch") {
  return {
    web_fetch: tool({
      description:
        "Fetch the content of a public URL and return it as readable text. " +
        "HTML pages are converted to Markdown with boilerplate removed. " +
        "JSON and plain text are returned as-is. " +
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
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        let relayFallbackReason: string | null = null;

        try {
          let relayResult = null;
          try {
            relayResult = await withDesktopRelayTab(async (relay, tabId) => {
              await navigateRelayTab(relay, tabId, url, "load");
              return readRelayReadableContent(relay, tabId, {
                maxTextLength: maxLength,
                extractMain,
              });
            });
          } catch (error) {
            relayFallbackReason = error instanceof Error ? error.message : String(error);
          }

          if (relayResult) {
            const content = truncate(
              `${buildReadableSourceHeader({
                url: relayResult.url,
                backend: relayResult.backend,
                title: relayResult.title || null,
                publishedAt: relayResult.publishedAt,
                modifiedAt: relayResult.modifiedAt,
              })}${relayResult.pageText}`,
              maxLength,
            );
            logPerfTrace("web_fetch", {
              sessionId,
              url,
              backend: relayResult.backend,
              totalMs: roundMs(nowMs() - startedAt),
              extractMain,
            });
            return content;
          }

          const response = await fetch(url, {
            signal: controller.signal,
            headers: {
              "User-Agent": "Aliceloop/1.0 (web_fetch tool)",
              Accept: "text/html, application/json, text/plain, */*",
            },
            redirect: "follow",
          });

          if (!response.ok) {
            return JSON.stringify({
              error: `HTTP ${response.status} ${response.statusText}`,
              url,
            });
          }

          const contentType = response.headers.get("content-type") ?? "";
          const rawBody = await response.text();

          // JSON — return as-is
          if (contentType.includes("application/json")) {
            return truncate(rawBody, maxLength);
          }

          // Plain text — return as-is
          if (contentType.includes("text/plain")) {
            return truncate(rawBody, maxLength);
          }

          // HTML — extract and convert to Markdown
          const metadata = extractHtmlMetadata(rawBody);
          const htmlChunk = extractMain ? extractMainContent(rawBody) : rawBody;
          const markdown = turndown.turndown(htmlChunk);
          const content = truncate(`${buildHtmlSourceHeader(url, metadata)}${markdown}`, maxLength);
          logPerfTrace("web_fetch", {
            sessionId,
            url,
            backend: "http_fetch",
            totalMs: roundMs(nowMs() - startedAt),
            extractMain,
            relayFallbackReason,
          });
          return content;
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
        } finally {
          clearTimeout(timeout);
        }
      },
    }),
  };
}

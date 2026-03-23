import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { clearBrowserSession, previewBrowserRuntime, refreshDesktopRelaySession, resolveBrowserSession } from "./browserSessionRegistry";
import { desktopChromeRelayBackend, isDesktopBrowserUnavailableError } from "./desktopChromeRelayBackend";
import { playwrightBrowserBackend } from "./playwrightBrowserBackend";
import { type BrowserBackend, type BrowserSessionRecord, normalizeWaitUntil } from "./browserTypes";

const DEFAULT_BROWSER_SESSION_ID = "default-browser-session";

function getBrowserBackend(session: BrowserSessionRecord): BrowserBackend {
  return session.backend === "desktop_chrome" ? desktopChromeRelayBackend : playwrightBrowserBackend;
}

async function executeBrowserOperation<T>(
  sessionId: string,
  operation: (backend: BrowserBackend, session: BrowserSessionRecord) => Promise<T>,
) {
  const session = resolveBrowserSession(sessionId);
  const backend = getBrowserBackend(session);

  try {
    return await operation(backend, session);
  } catch (error) {
    if (session.backend === "desktop_chrome" && isDesktopBrowserUnavailableError(error)) {
      const refreshed = refreshDesktopRelaySession(session);
      if (refreshed) {
        try {
          return await operation(desktopChromeRelayBackend, refreshed);
        } catch (retryError) {
          if (isDesktopBrowserUnavailableError(retryError)) {
            throw new Error(`desktop_browser_unavailable: ${retryError.message}`);
          }

          throw retryError;
        }
      }

      throw new Error(`desktop_browser_unavailable: ${error.message}`);
    }

    throw error;
  }
}

export function getBrowserToolRuntime(sessionId: string) {
  const runtime = previewBrowserRuntime(sessionId);
  return {
    backend: runtime.backend,
    tabId: runtime.tabId,
  };
}

export function createBrowserTools(sessionId = DEFAULT_BROWSER_SESSION_ID): ToolSet {
  const dispose = async () => {
    const session = resolveBrowserSession(sessionId);
    await getBrowserBackend(session).disposeSession(session);
    clearBrowserSession(sessionId);
  };

  const tools: ToolSet = {
    browser_navigate: tool({
      description:
        "Open a URL in a browser and return a structured page snapshot with element refs. " +
        "On Aliceloop Desktop this prefers a visible Google Chrome relay; otherwise it falls back to local Playwright.",
      inputSchema: z.object({
        url: z.string().min(1).describe("Target URL to open"),
        waitUntil: z
          .enum(["load", "domcontentloaded", "networkidle"])
          .optional()
          .describe("Navigation readiness gate; defaults to domcontentloaded"),
      }),
      execute: async ({ url, waitUntil }) => {
        const snapshot = await executeBrowserOperation(sessionId, (backend, session) => {
          return backend.navigate(session, url, normalizeWaitUntil(waitUntil));
        });
        return JSON.stringify(snapshot, null, 2);
      },
    }),

    browser_snapshot: tool({
      description:
        "Capture the current page state as JSON, including headings, visible text, and interactive element refs " +
        "from the current browser tab.",
      inputSchema: z.object({
        maxTextLength: z.number().int().min(200).max(10_000).optional(),
        maxElements: z.number().int().min(1).max(100).optional(),
      }),
      execute: async ({ maxTextLength, maxElements }) => {
        const snapshot = await executeBrowserOperation(sessionId, (backend, session) => {
          return backend.snapshot(session, {
            maxTextLength,
            maxElements,
          });
        });
        return JSON.stringify(snapshot, null, 2);
      },
    }),

    browser_click: tool({
      description:
        "Click an interactive page element by its ref from browser_snapshot, then return the refreshed page snapshot.",
      inputSchema: z.object({
        ref: z.string().min(1).describe("Element ref from browser_snapshot"),
        waitUntil: z
          .enum(["load", "domcontentloaded", "networkidle"])
          .optional()
          .describe("Post-click readiness gate; defaults to domcontentloaded"),
      }),
      execute: async ({ ref, waitUntil }) => {
        const snapshot = await executeBrowserOperation(sessionId, (backend, session) => {
          return backend.click(session, ref, normalizeWaitUntil(waitUntil));
        });
        return JSON.stringify(snapshot, null, 2);
      },
    }),

    browser_type: tool({
      description:
        "Fill a text field by its ref from browser_snapshot, optionally pressing Enter, and return the refreshed page snapshot.",
      inputSchema: z.object({
        ref: z.string().min(1).describe("Element ref from browser_snapshot"),
        text: z.string().describe("Text to enter into the element"),
        submit: z.boolean().optional().default(false).describe("Press Enter after typing"),
      }),
      execute: async ({ ref, text, submit }) => {
        const snapshot = await executeBrowserOperation(sessionId, (backend, session) => {
          return backend.type(session, ref, text, submit);
        });
        return JSON.stringify(snapshot, null, 2);
      },
    }),

    browser_screenshot: tool({
      description:
        "Save a screenshot of the current page to disk and return the output path.",
      inputSchema: z.object({
        outputPath: z.string().optional().describe("Optional output path for the PNG file"),
        fullPage: z.boolean().optional().default(true).describe("Capture the full page instead of only the viewport"),
      }),
      execute: async ({ outputPath, fullPage }) => {
        const result = await executeBrowserOperation(sessionId, (backend, session) => {
          return backend.screenshot(session, outputPath, fullPage);
        });
        return JSON.stringify(result, null, 2);
      },
    }),
  };

  for (const browserTool of Object.values(tools)) {
    Object.assign(browserTool, {
      __dispose: () => dispose(),
    });
  }

  return tools;
}

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { normalizeWaitUntil, type BrowserSessionRecord } from "./browserTypes";
import {
  backDesktopRelay,
  desktopChromeRelayBackend,
  ensureDesktopRelayTab,
  evalDesktopRelay,
  forwardDesktopRelay,
  isDesktopBrowserUnavailableError,
  listDesktopRelayTabs,
  readDesktopRelay,
  readDesktopRelayDom,
  requestDesktopRelay,
  scrollDesktopRelay,
} from "./desktopChromeRelayBackend";
import { refreshDesktopRelaySession, resolveDesktopRelaySession } from "./browserSessionRegistry";

const DEFAULT_CHROME_RELAY_SESSION_ID = "default-chrome-relay-session";

async function executeChromeRelayOperation<T>(
  sessionId: string,
  operation: (session: BrowserSessionRecord) => Promise<T>,
) {
  const session = resolveDesktopRelaySession(sessionId);

  try {
    return await operation(session);
  } catch (error) {
    if (isDesktopBrowserUnavailableError(error)) {
      const refreshed = refreshDesktopRelaySession(session);
      if (refreshed) {
        try {
          return await operation(refreshed);
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

function normalizeTabId(tabId?: string) {
  const normalized = tabId?.trim();
  return normalized ? normalized : null;
}

async function resolveTargetTab(session: BrowserSessionRecord, tabId?: string) {
  const explicit = normalizeTabId(tabId);
  if (explicit) {
    session.tabId = explicit;
    return explicit;
  }

  return ensureDesktopRelayTab(session);
}

export function createChromeRelayTools(sessionId = DEFAULT_CHROME_RELAY_SESSION_ID): ToolSet {
  return {
    chrome_relay_status: tool({
      description: "Check whether the Aliceloop Desktop Chrome relay is healthy and how many attached relay tabs exist.",
      inputSchema: z.object({}),
      execute: async () => {
        const result = await executeChromeRelayOperation(sessionId, async (session) => {
          return requestDesktopRelay(session, "/status", { method: "GET" });
        });
        return JSON.stringify(result, null, 2);
      },
    }),

    chrome_relay_list_tabs: tool({
      description: "List the currently attached Aliceloop Desktop Chrome relay tabs.",
      inputSchema: z.object({}),
      execute: async () => {
        const result = await executeChromeRelayOperation(sessionId, async (session) => {
          const tabs = await listDesktopRelayTabs(session);
          if (!session.tabId && tabs.activeTabId) {
            session.tabId = tabs.activeTabId;
          }
          return tabs;
        });
        return JSON.stringify(result, null, 2);
      },
    }),

    chrome_relay_open: tool({
      description: "Open a new Aliceloop Desktop Chrome relay tab, optionally navigating to a URL immediately.",
      inputSchema: z.object({
        url: z.string().optional().describe("Optional URL to open in the new tab"),
        waitUntil: z
          .enum(["load", "domcontentloaded", "networkidle"])
          .optional()
          .describe("Navigation readiness gate when url is provided"),
      }),
      execute: async ({ url, waitUntil }) => {
        const result = await executeChromeRelayOperation(sessionId, async (session) => {
          const payload = await requestDesktopRelay<{ tabId?: string; url?: string; title?: string | null }>(
            session,
            "/tabs/open",
            {
              method: "POST",
              body: JSON.stringify({
                url: url?.trim() || undefined,
                waitUntil: normalizeWaitUntil(waitUntil),
              }),
            },
          );
          if (typeof payload.tabId === "string" && payload.tabId) {
            session.tabId = payload.tabId;
          }
          return payload;
        });
        return JSON.stringify(result, null, 2);
      },
    }),

    chrome_relay_navigate: tool({
      description: "Navigate the current or specified relay tab to a URL and return a refreshed DOM snapshot.",
      inputSchema: z.object({
        url: z.string().min(1).describe("Target URL"),
        tabId: z.string().optional().describe("Optional relay tab id; defaults to the current session tab"),
        waitUntil: z
          .enum(["load", "domcontentloaded", "networkidle"])
          .optional()
          .describe("Navigation readiness gate"),
      }),
      execute: async ({ url, tabId, waitUntil }) => {
        const result = await executeChromeRelayOperation(sessionId, async (session) => {
          const targetTabId = await resolveTargetTab(session, tabId);
          const snapshot = await desktopChromeRelayBackend.navigate(session, url, normalizeWaitUntil(waitUntil));
          session.tabId = snapshot.tabId ?? targetTabId;
          return snapshot;
        });
        return JSON.stringify(result, null, 2);
      },
    }),

    chrome_relay_read: tool({
      description: "Read the current or specified relay tab as cleaned page text with metadata.",
      inputSchema: z.object({
        tabId: z.string().optional().describe("Optional relay tab id; defaults to the current session tab"),
        maxTextLength: z.number().int().min(200).max(50_000).optional(),
        extractMain: z.boolean().optional().default(true),
      }),
      execute: async ({ tabId, maxTextLength, extractMain }) => {
        const result = await executeChromeRelayOperation(sessionId, async (session) => {
          const targetTabId = await resolveTargetTab(session, tabId);
          session.tabId = targetTabId;
          return readDesktopRelay(session, targetTabId, {
            maxTextLength,
            extractMain,
          });
        });
        return JSON.stringify(result, null, 2);
      },
    }),

    chrome_relay_read_dom: tool({
      description: "Read the current or specified relay tab as a DOM snapshot with element refs and visible text.",
      inputSchema: z.object({
        tabId: z.string().optional().describe("Optional relay tab id; defaults to the current session tab"),
        maxTextLength: z.number().int().min(200).max(10_000).optional(),
        maxElements: z.number().int().min(1).max(100).optional(),
      }),
      execute: async ({ tabId, maxTextLength, maxElements }) => {
        const result = await executeChromeRelayOperation(sessionId, async (session) => {
          const targetTabId = await resolveTargetTab(session, tabId);
          session.tabId = targetTabId;
          return readDesktopRelayDom(session, targetTabId, {
            maxTextLength,
            maxElements,
          });
        });
        return JSON.stringify(result, null, 2);
      },
    }),

    chrome_relay_click: tool({
      description: "Click an element ref in the current or specified relay tab and return the refreshed DOM snapshot.",
      inputSchema: z.object({
        ref: z.string().min(1),
        tabId: z.string().optional().describe("Optional relay tab id; defaults to the current session tab"),
        waitUntil: z
          .enum(["load", "domcontentloaded", "networkidle"])
          .optional()
          .describe("Post-click readiness gate"),
      }),
      execute: async ({ ref, tabId, waitUntil }) => {
        const result = await executeChromeRelayOperation(sessionId, async (session) => {
          const targetTabId = await resolveTargetTab(session, tabId);
          session.tabId = targetTabId;
          return desktopChromeRelayBackend.click(session, ref, normalizeWaitUntil(waitUntil));
        });
        return JSON.stringify(result, null, 2);
      },
    }),

    chrome_relay_type: tool({
      description: "Type into an element ref in the current or specified relay tab and return the refreshed DOM snapshot.",
      inputSchema: z.object({
        ref: z.string().min(1),
        text: z.string(),
        tabId: z.string().optional().describe("Optional relay tab id; defaults to the current session tab"),
        submit: z.boolean().optional().default(false),
      }),
      execute: async ({ ref, text, tabId, submit }) => {
        const result = await executeChromeRelayOperation(sessionId, async (session) => {
          const targetTabId = await resolveTargetTab(session, tabId);
          session.tabId = targetTabId;
          return desktopChromeRelayBackend.type(session, ref, text, submit);
        });
        return JSON.stringify(result, null, 2);
      },
    }),

    chrome_relay_screenshot: tool({
      description: "Capture a screenshot from the current or specified relay tab and return the saved file path.",
      inputSchema: z.object({
        tabId: z.string().optional().describe("Optional relay tab id; defaults to the current session tab"),
        outputPath: z.string().optional(),
        ref: z.string().optional(),
        fullPage: z.boolean().optional().default(true),
      }),
      execute: async ({ tabId, outputPath, ref, fullPage }) => {
        const result = await executeChromeRelayOperation(sessionId, async (session) => {
          const targetTabId = await resolveTargetTab(session, tabId);
          session.tabId = targetTabId;
          return desktopChromeRelayBackend.screenshot(session, outputPath, fullPage, ref);
        });
        return JSON.stringify(result, null, 2);
      },
    }),

    chrome_relay_scroll: tool({
      description: "Scroll the current or specified relay tab and return the refreshed DOM snapshot.",
      inputSchema: z.object({
        tabId: z.string().optional().describe("Optional relay tab id; defaults to the current session tab"),
        direction: z.enum(["up", "down", "left", "right"]).optional().default("down"),
        amount: z.number().int().min(50).max(4_000).optional(),
      }),
      execute: async ({ tabId, direction, amount }) => {
        const result = await executeChromeRelayOperation(sessionId, async (session) => {
          const targetTabId = await resolveTargetTab(session, tabId);
          session.tabId = targetTabId;
          return scrollDesktopRelay(session, targetTabId, direction, amount);
        });
        return JSON.stringify(result, null, 2);
      },
    }),

    chrome_relay_eval: tool({
      description: "Evaluate a JavaScript expression in the current or specified relay tab and return its serialized result.",
      inputSchema: z.object({
        expression: z.string().min(1),
        tabId: z.string().optional().describe("Optional relay tab id; defaults to the current session tab"),
      }),
      execute: async ({ expression, tabId }) => {
        const result = await executeChromeRelayOperation(sessionId, async (session) => {
          const targetTabId = await resolveTargetTab(session, tabId);
          session.tabId = targetTabId;
          return evalDesktopRelay(session, targetTabId, expression);
        });
        return JSON.stringify(result, null, 2);
      },
    }),

    chrome_relay_back: tool({
      description: "Go back in the current or specified relay tab history and return the refreshed DOM snapshot.",
      inputSchema: z.object({
        tabId: z.string().optional().describe("Optional relay tab id; defaults to the current session tab"),
        waitUntil: z
          .enum(["load", "domcontentloaded", "networkidle"])
          .optional()
          .describe("Navigation readiness gate"),
      }),
      execute: async ({ tabId, waitUntil }) => {
        const result = await executeChromeRelayOperation(sessionId, async (session) => {
          const targetTabId = await resolveTargetTab(session, tabId);
          session.tabId = targetTabId;
          return backDesktopRelay(session, targetTabId, normalizeWaitUntil(waitUntil));
        });
        return JSON.stringify(result, null, 2);
      },
    }),

    chrome_relay_forward: tool({
      description: "Go forward in the current or specified relay tab history and return the refreshed DOM snapshot.",
      inputSchema: z.object({
        tabId: z.string().optional().describe("Optional relay tab id; defaults to the current session tab"),
        waitUntil: z
          .enum(["load", "domcontentloaded", "networkidle"])
          .optional()
          .describe("Navigation readiness gate"),
      }),
      execute: async ({ tabId, waitUntil }) => {
        const result = await executeChromeRelayOperation(sessionId, async (session) => {
          const targetTabId = await resolveTargetTab(session, tabId);
          session.tabId = targetTabId;
          return forwardDesktopRelay(session, targetTabId, normalizeWaitUntil(waitUntil));
        });
        return JSON.stringify(result, null, 2);
      },
    }),
  };
}

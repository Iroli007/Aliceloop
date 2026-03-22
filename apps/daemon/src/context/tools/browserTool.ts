import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tool, type ToolSet } from "ai";
import type { Browser, BrowserContext, Page } from "playwright";
import { z } from "zod";
import { getDataDir } from "../../db/client";

type BrowserWaitUntil = "load" | "domcontentloaded" | "networkidle";

interface BrowserSnapshotPayload {
  url: string;
  title: string;
  headings: Array<{ level: string; text: string }>;
  elements: Array<{
    ref: string;
    tag: string;
    role: string;
    text: string;
    type: string;
    name: string;
    placeholder: string;
    href: string;
    value: string;
    disabled: boolean;
  }>;
  pageText: string;
}

const DEFAULT_VIEWPORT = { width: 1440, height: 960 };
const DEFAULT_MAX_TEXT_LENGTH = 4_000;
const DEFAULT_MAX_ELEMENTS = 30;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

let screenshotSequence = 0;

function resolveDefaultScreenshotPath() {
  screenshotSequence += 1;
  return join(
    getDataDir(),
    "browser-screenshots",
    `aliceloop-browser-${Date.now()}-${screenshotSequence}.png`,
  );
}

function escapeAttributeValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizeWaitUntil(value: string | undefined): BrowserWaitUntil {
  if (value === "load" || value === "networkidle") {
    return value;
  }

  return "domcontentloaded";
}

function friendlyBrowserError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Executable doesn't exist")) {
    return `${message}\nRun \`npx playwright install chromium\` to provision the local browser runtime.`;
  }

  return message;
}

async function collectSnapshot(
  page: Page,
  options?: {
    maxTextLength?: number;
    maxElements?: number;
  },
): Promise<BrowserSnapshotPayload> {
  const payload = JSON.stringify({
    maxTextLength: options?.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
    maxElements: options?.maxElements ?? DEFAULT_MAX_ELEMENTS,
  });

  return page.evaluate(`
    (() => {
      const input = ${payload};
      const counterKey = "__ALICELOOP_BROWSER_REF_COUNTER__";
      const scope = globalThis;
      let nextRef = Number.isFinite(scope[counterKey]) ? Number(scope[counterKey]) : 1;

      function compact(value, limit) {
        return String(value ?? "").replace(/\\s+/g, " ").trim().slice(0, limit);
      }

      function isVisible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      }

      function ensureRef(element) {
        const existing = element.getAttribute("data-aliceloop-ref");
        if (existing) {
          return existing;
        }

        const next = "e" + nextRef;
        nextRef += 1;
        element.setAttribute("data-aliceloop-ref", next);
        return next;
      }

      const interactiveSelector = [
        "a[href]",
        "button",
        "input",
        "textarea",
        "select",
        "summary",
        "[role='button']",
        "[role='link']",
        "[contenteditable='true']"
      ].join(",");

      const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
        .filter(isVisible)
        .slice(0, 12)
        .map(function (element) {
          return {
            level: element.tagName.toLowerCase(),
            text: compact(element.textContent, 160)
          };
        })
        .filter(function (entry) {
          return entry.text.length > 0;
        });

      const elements = Array.from(document.querySelectorAll(interactiveSelector))
        .filter(isVisible)
        .slice(0, input.maxElements)
        .map(function (element) {
          const htmlElement = element;
          const ref = ensureRef(element);
          const text = compact(
            htmlElement.innerText || htmlElement.textContent || htmlElement.getAttribute("aria-label"),
            160
          );
          const href = element.tagName === "A" ? element.href : compact(element.getAttribute("href"), 240);
          const rawValue = Array.isArray(htmlElement.value)
            ? htmlElement.value.join(", ")
            : (typeof htmlElement.value === "string" ? htmlElement.value : String(htmlElement.value ?? ""));

          return {
            ref,
            tag: element.tagName.toLowerCase(),
            role: compact(element.getAttribute("role"), 40),
            text,
            type: compact(htmlElement.type, 40),
            name: compact(htmlElement.name, 60),
            placeholder: compact(htmlElement.placeholder, 80),
            href,
            value: compact(rawValue, 120),
            disabled: Boolean(htmlElement.disabled) || element.getAttribute("aria-disabled") === "true"
          };
        });

      scope[counterKey] = nextRef;

      return {
        url: window.location.href,
        title: compact(document.title, 200),
        headings,
        elements,
        pageText: compact(document.body ? document.body.innerText : "", input.maxTextLength)
      };
    })()
  `);
}

class BrowserSessionManager {
  private browserPromise: Promise<Browser> | null = null;

  private contextPromise: Promise<BrowserContext> | null = null;

  private pagePromise: Promise<Page> | null = null;

  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleIdleDisposal() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => {
      void this.dispose();
    }, DEFAULT_IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = import("playwright")
        .then(async ({ chromium }) => {
          return chromium.launch({
            headless: process.env.ALICELOOP_BROWSER_HEADLESS !== "false",
          });
        })
        .catch((error) => {
          this.browserPromise = null;
          throw error;
        });
    }

    return this.browserPromise;
  }

  private async getContext(): Promise<BrowserContext> {
    if (!this.contextPromise) {
      this.contextPromise = this.getBrowser()
        .then(async (browser) => {
          return browser.newContext({
            viewport: DEFAULT_VIEWPORT,
            ignoreHTTPSErrors: true,
          });
        })
        .catch((error) => {
          this.contextPromise = null;
          throw error;
        });
    }

    return this.contextPromise;
  }

  private async getPage(): Promise<Page> {
    if (!this.pagePromise) {
      this.pagePromise = this.getContext()
        .then(async (context) => {
          const page = await context.newPage();
          await page.goto("about:blank");
          return page;
        })
        .catch((error) => {
          this.pagePromise = null;
          throw error;
        });
    }

    return this.pagePromise;
  }

  private async waitForSettledPage(page: Page, waitUntil: BrowserWaitUntil) {
    await page.waitForLoadState(waitUntil, { timeout: 10_000 }).catch(async () => {
      await page.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => undefined);
    });
  }

  async dispose() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    const browserPromise = this.browserPromise;
    this.pagePromise = null;
    this.contextPromise = null;
    this.browserPromise = null;

    if (!browserPromise) {
      return;
    }

    try {
      const browser = await browserPromise;
      await browser.close();
    } catch {
      // Best-effort cleanup only.
    }
  }

  async navigate(url: string, waitUntil: BrowserWaitUntil) {
    try {
      const page = await this.getPage();
      await page.goto(url, {
        waitUntil,
        timeout: 20_000,
      });

      return collectSnapshot(page);
    } catch (error) {
      throw new Error(friendlyBrowserError(error));
    } finally {
      this.scheduleIdleDisposal();
    }
  }

  async snapshot(options?: {
    maxTextLength?: number;
    maxElements?: number;
  }) {
    try {
      const page = await this.getPage();
      return collectSnapshot(page, options);
    } catch (error) {
      throw new Error(friendlyBrowserError(error));
    } finally {
      this.scheduleIdleDisposal();
    }
  }

  async click(ref: string, waitUntil: BrowserWaitUntil) {
    try {
      const page = await this.getPage();
      const selector = `[data-aliceloop-ref="${escapeAttributeValue(ref)}"]`;
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) {
        throw new Error(`No browser element matches ref ${ref}. Run browser_snapshot again to refresh refs.`);
      }

      await locator.click({
        timeout: 10_000,
      });
      await this.waitForSettledPage(page, waitUntil);
      return collectSnapshot(page);
    } catch (error) {
      throw new Error(friendlyBrowserError(error));
    } finally {
      this.scheduleIdleDisposal();
    }
  }

  async type(ref: string, text: string, submit: boolean) {
    try {
      const page = await this.getPage();
      const selector = `[data-aliceloop-ref="${escapeAttributeValue(ref)}"]`;
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) {
        throw new Error(`No browser element matches ref ${ref}. Run browser_snapshot again to refresh refs.`);
      }

      await locator.fill(text, { timeout: 10_000 });
      if (submit) {
        await locator.press("Enter", { timeout: 10_000 });
        await this.waitForSettledPage(page, "domcontentloaded");
      }

      return collectSnapshot(page);
    } catch (error) {
      throw new Error(friendlyBrowserError(error));
    } finally {
      this.scheduleIdleDisposal();
    }
  }

  async screenshot(outputPath?: string, fullPage?: boolean) {
    try {
      const page = await this.getPage();
      const targetPath = outputPath?.trim() || resolveDefaultScreenshotPath();
      mkdirSync(dirname(targetPath), { recursive: true });
      await page.screenshot({
        path: targetPath,
        fullPage: fullPage ?? true,
      });

      return {
        path: targetPath,
        url: page.url(),
      };
    } catch (error) {
      throw new Error(friendlyBrowserError(error));
    } finally {
      this.scheduleIdleDisposal();
    }
  }
}

export function createBrowserTools(): ToolSet {
  const manager = new BrowserSessionManager();

  const tools: ToolSet = {
    browser_navigate: tool({
      description:
        "Open a URL in a real headless browser and return a structured page snapshot with element refs.",
      inputSchema: z.object({
        url: z.string().min(1).describe("Target URL to open"),
        waitUntil: z
          .enum(["load", "domcontentloaded", "networkidle"])
          .optional()
          .describe("Navigation readiness gate; defaults to domcontentloaded"),
      }),
      execute: async ({ url, waitUntil }) => {
        const snapshot = await manager.navigate(url, normalizeWaitUntil(waitUntil));
        return JSON.stringify(snapshot, null, 2);
      },
    }),

    browser_snapshot: tool({
      description:
        "Capture the current page state as JSON, including headings, visible text, and interactive element refs.",
      inputSchema: z.object({
        maxTextLength: z.number().int().min(200).max(10_000).optional(),
        maxElements: z.number().int().min(1).max(100).optional(),
      }),
      execute: async ({ maxTextLength, maxElements }) => {
        const snapshot = await manager.snapshot({
          maxTextLength,
          maxElements,
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
        const snapshot = await manager.click(ref, normalizeWaitUntil(waitUntil));
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
        const snapshot = await manager.type(ref, text, submit);
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
        const result = await manager.screenshot(outputPath, fullPage);
        return JSON.stringify(result, null, 2);
      },
    }),
  };

  for (const browserTool of Object.values(tools)) {
    Object.assign(browserTool, {
      __dispose: () => manager.dispose(),
    });
  }

  return tools;
}

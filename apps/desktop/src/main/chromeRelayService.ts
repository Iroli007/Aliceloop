import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { chromium } from "playwright-core";
import type {
  BrowserReadablePayload,
  BrowserScreenshotPayload,
  BrowserSearchResultsPayload,
  BrowserSnapshotPayload,
  BrowserWaitUntil,
  ChromeRelayMeta,
} from "./chromeRelayTypes";

const DEFAULT_VIEWPORT = { width: 1440, height: 960 };
const DEFAULT_MAX_TEXT_LENGTH = 4_000;
const DEFAULT_MAX_ELEMENTS = 30;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_SCREENSHOT_ROOT_NAME = "browser-screenshots";

function escapeAttributeValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizeWaitUntil(value: string | undefined): BrowserWaitUntil {
  if (value === "load" || value === "networkidle") {
    return value;
  }

  return "domcontentloaded";
}

async function collectSnapshot(
  page: Page,
  tabId: string,
  options?: {
    maxTextLength?: number;
    maxElements?: number;
  },
): Promise<BrowserSnapshotPayload> {
  type SnapshotCore = Omit<BrowserSnapshotPayload, "backend" | "tabId">;
  const payload = JSON.stringify({
    maxTextLength: options?.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
    maxElements: options?.maxElements ?? DEFAULT_MAX_ELEMENTS,
  });

  const result = await page.evaluate(`
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
  `) as SnapshotCore;

  return {
    ...result,
    backend: "desktop_chrome",
    tabId,
  };
}

async function collectReadableContent(
  page: Page,
  tabId: string,
  options?: {
    maxTextLength?: number;
    extractMain?: boolean;
  },
): Promise<BrowserReadablePayload> {
  const payload = JSON.stringify({
    maxTextLength: options?.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
    extractMain: options?.extractMain !== false,
  });

  const result = await page.evaluate(`
    (() => {
      const input = ${payload};

      function compact(value, limit) {
        return String(value ?? "").replace(/\\s+/g, " ").trim().slice(0, limit);
      }

      function getMetaContent(selector) {
        const element = document.querySelector(selector);
        const content = element?.getAttribute("content");
        return content ? compact(content, 120) : null;
      }

      const publishedAt =
        getMetaContent('meta[property="article:published_time"]') ||
        getMetaContent('meta[name="pubdate"]') ||
        getMetaContent('meta[name="publishdate"]') ||
        document.querySelector('time[datetime]')?.getAttribute('datetime') ||
        null;

      const modifiedAt =
        getMetaContent('meta[property="article:modified_time"]') ||
        getMetaContent('meta[name="lastmod"]') ||
        null;

      const root = input.extractMain
        ? document.querySelector("main, article") || document.body
        : document.body;

      const pageText = compact(root ? root.innerText : document.body?.innerText ?? "", input.maxTextLength);

      return {
        url: window.location.href,
        title: compact(document.title, 200),
        publishedAt: publishedAt ? compact(publishedAt, 120) : null,
        modifiedAt: modifiedAt ? compact(modifiedAt, 120) : null,
        pageText,
      };
    })()
  `) as Omit<BrowserReadablePayload, "backend" | "tabId">;

  return {
    ...result,
    backend: "desktop_chrome",
    tabId,
  };
}

async function collectSearchResults(
  page: Page,
  tabId: string,
  maxResults: number,
): Promise<BrowserSearchResultsPayload> {
  const payload = JSON.stringify({
    maxResults,
  });

  const result = await page.evaluate(`
    (() => {
      const input = ${payload};

      function compact(value, limit) {
        return String(value ?? "").replace(/\\s+/g, " ").trim().slice(0, limit);
      }

      function isVisible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      }

      function extractDomain(url) {
        try {
          return new URL(url, window.location.href).hostname.toLowerCase();
        } catch {
          return "";
        }
      }

      const results = [];
      const seen = new Set();

      function pushResult(title, url, snippet) {
        const normalizedTitle = compact(title, 180);
        const normalizedUrl = compact(url, 400);
        if (!normalizedTitle || !normalizedUrl || seen.has(normalizedUrl)) {
          return;
        }

        seen.add(normalizedUrl);
        results.push({
          title: normalizedTitle,
          url: normalizedUrl,
          snippet: compact(snippet, 280),
          domain: extractDomain(normalizedUrl),
        });
      }

      const structuredNodes = Array.from(document.querySelectorAll(".result, [data-testid='result'], article"))
        .filter(isVisible);

      for (const node of structuredNodes) {
        if (results.length >= input.maxResults) {
          break;
        }

        const link = node.querySelector("a.result__a, h2 a, h3 a, a[href]");
        if (!link || !isVisible(link)) {
          continue;
        }

        const snippetNode =
          node.querySelector(".result__snippet, .snippet, [class*='snippet'], p") ||
          node.querySelector("div");

        pushResult(
          link.textContent || link.getAttribute("aria-label") || "",
          link.href || link.getAttribute("href") || "",
          snippetNode?.textContent || "",
        );
      }

      if (results.length < input.maxResults) {
        const genericLinks = Array.from(document.querySelectorAll("main a[href], article a[href], body a[href]"))
          .filter((link) => isVisible(link));

        for (const link of genericLinks) {
          if (results.length >= input.maxResults) {
            break;
          }

          const text = compact(link.textContent || link.getAttribute("aria-label") || "", 180);
          const href = link.href || link.getAttribute("href") || "";
          if (text.length < 4) {
            continue;
          }

          pushResult(text, href, link.closest("article, section, div")?.textContent || "");
        }
      }

      return {
        url: window.location.href,
        results: results.slice(0, input.maxResults),
      };
    })()
  `) as Omit<BrowserSearchResultsPayload, "backend" | "tabId">;

  return {
    ...result,
    backend: "desktop_chrome",
    tabId,
  };
}

async function readDevToolsPort(profileDir: string) {
  const portFile = join(profileDir, "DevToolsActivePort");
  if (!existsSync(portFile)) {
    return null;
  }

  const [portLine] = readFileSync(portFile, "utf8").split(/\r?\n/, 2);
  const port = Number(portLine?.trim());
  return Number.isFinite(port) && port > 0 ? port : null;
}

export interface ChromeRelayServiceOptions {
  chromeExecutablePath: string;
  profileDir: string;
  screenshotRoot: string;
}

type RelayTabRecord = {
  id: string;
  page: Page;
};

export class ChromeRelayService {
  private readonly chromeExecutablePath: string;

  private readonly profileDir: string;

  private readonly screenshotRoot: string;

  private chromeProcess: ChildProcess | null = null;

  private browser: Browser | null = null;

  private tabs = new Map<string, RelayTabRecord>();

  private connectionPromise: Promise<Browser> | null = null;

  private lastError: string | null = null;

  constructor(options: ChromeRelayServiceOptions) {
    this.chromeExecutablePath = options.chromeExecutablePath;
    this.profileDir = options.profileDir;
    this.screenshotRoot = options.screenshotRoot;
  }

  getCapability(baseUrl: string, token: string): ChromeRelayMeta {
    const enabled = existsSync(this.chromeExecutablePath);
    return {
      browserRelay: {
        enabled,
        backend: "desktop_chrome",
        baseUrl,
        token,
        visible: true,
        healthy: enabled && !this.lastError,
      },
    };
  }

  private markHealthy() {
    this.lastError = null;
  }

  private markError(error: unknown) {
    this.lastError = error instanceof Error ? error.message : String(error);
  }

  private async waitForBrowserReady(profileDir: string, chrome: ChildProcess) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < DEFAULT_CONNECT_TIMEOUT_MS) {
      if (chrome.exitCode !== null) {
        throw new Error(`Chrome exited before DevTools was ready (code ${chrome.exitCode ?? "unknown"})`);
      }

      const port = await readDevToolsPort(profileDir);
      if (port) {
        return port;
      }

      await delay(100);
    }

    throw new Error("Timed out waiting for Chrome DevTools port");
  }

  private async connectExistingBrowser() {
    const port = await readDevToolsPort(this.profileDir);
    if (!port) {
      return null;
    }

    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      return null;
    }
  }

  private async launchChromeAndConnect() {
    mkdirSync(this.profileDir, { recursive: true });

    const existing = await this.connectExistingBrowser();
    if (existing) {
      return existing;
    }

    const chrome = spawn(
      this.chromeExecutablePath,
      [
        "--remote-debugging-port=0",
        `--user-data-dir=${this.profileDir}`,
        "about:blank",
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );

    this.chromeProcess = chrome;
    chrome.once("exit", () => {
      this.chromeProcess = null;
    });
    const port = await this.waitForBrowserReady(this.profileDir, chrome);
    return chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  }

  private async getBrowser() {
    if (this.browser?.isConnected()) {
      return this.browser;
    }

    if (!this.connectionPromise) {
      this.connectionPromise = this.launchChromeAndConnect()
        .then((browser) => {
          this.browser = browser;
          this.markHealthy();
          browser.on("disconnected", () => {
            this.browser = null;
            this.connectionPromise = null;
            this.markError("Chrome relay disconnected");
          });
          return browser;
        })
        .catch((error) => {
          this.connectionPromise = null;
          this.markError(error);
          throw error;
        });
    }

    return this.connectionPromise;
  }

  private async getContext(): Promise<BrowserContext> {
    const browser = await this.getBrowser();
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error("Chrome default context is not available");
    }

    return context;
  }

  private async waitForSettledPage(page: Page, waitUntil: BrowserWaitUntil) {
    await page.waitForLoadState(waitUntil, { timeout: 10_000 }).catch(async () => {
      await page.waitForLoadState("domcontentloaded", { timeout: 3_000 }).catch(() => undefined);
    });
  }

  private pruneClosedTabs() {
    for (const [tabId, record] of this.tabs) {
      if (record.page.isClosed()) {
        this.tabs.delete(tabId);
      }
    }
  }

  private async getTabRecord(tabId: string) {
    this.pruneClosedTabs();
    const record = this.tabs.get(tabId);
    if (!record) {
      throw new Error(`Unknown browser relay tab: ${tabId}`);
    }

    return record;
  }

  async openTab() {
    try {
      const context = await this.getContext();
      const page = await context.newPage();
      await page.setViewportSize(DEFAULT_VIEWPORT).catch(() => undefined);
      const tabId = randomUUID();
      this.tabs.set(tabId, { id: tabId, page });
      page.on("close", () => {
        this.tabs.delete(tabId);
      });
      this.markHealthy();

      return {
        tabId,
        url: page.url(),
      };
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async navigate(tabId: string, url: string, waitUntil: string | undefined) {
    try {
      const record = await this.getTabRecord(tabId);
      await record.page.goto(url, {
        waitUntil: normalizeWaitUntil(waitUntil),
        timeout: 20_000,
      });
      this.markHealthy();

      return collectSnapshot(record.page, tabId);
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async snapshot(tabId: string, options?: { maxTextLength?: number; maxElements?: number }) {
    try {
      const record = await this.getTabRecord(tabId);
      this.markHealthy();
      return collectSnapshot(record.page, tabId, options);
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async click(tabId: string, ref: string, waitUntil: string | undefined) {
    try {
      const record = await this.getTabRecord(tabId);
      const selector = `[data-aliceloop-ref="${escapeAttributeValue(ref)}"]`;
      const locator = record.page.locator(selector).first();
      if ((await locator.count()) === 0) {
        throw new Error(`No browser element matches ref ${ref}. Run browser_snapshot again to refresh refs.`);
      }

      await locator.click({ timeout: 10_000 });
      await this.waitForSettledPage(record.page, normalizeWaitUntil(waitUntil));
      this.markHealthy();
      return collectSnapshot(record.page, tabId);
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async type(tabId: string, ref: string, text: string, submit: boolean) {
    try {
      const record = await this.getTabRecord(tabId);
      const selector = `[data-aliceloop-ref="${escapeAttributeValue(ref)}"]`;
      const locator = record.page.locator(selector).first();
      if ((await locator.count()) === 0) {
        throw new Error(`No browser element matches ref ${ref}. Run browser_snapshot again to refresh refs.`);
      }

      await locator.fill(text, { timeout: 10_000 });
      if (submit) {
        await locator.press("Enter", { timeout: 10_000 });
        await this.waitForSettledPage(record.page, "domcontentloaded");
      }
      this.markHealthy();

      return collectSnapshot(record.page, tabId);
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async screenshot(tabId: string, outputPath?: string, fullPage = true): Promise<BrowserScreenshotPayload> {
    try {
      const record = await this.getTabRecord(tabId);
      const targetPath = outputPath?.trim() || join(this.screenshotRoot, `browser-${Date.now()}-${tabId}.png`);
      mkdirSync(dirname(targetPath), { recursive: true });
      await record.page.screenshot({
        path: targetPath,
        fullPage,
      });
      this.markHealthy();

      return {
        path: targetPath,
        url: record.page.url(),
        backend: "desktop_chrome",
        tabId,
      };
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async readable(tabId: string, options?: { maxTextLength?: number; extractMain?: boolean }) {
    try {
      const record = await this.getTabRecord(tabId);
      this.markHealthy();
      return await collectReadableContent(record.page, tabId, options);
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async searchResults(tabId: string, maxResults: number) {
    try {
      const record = await this.getTabRecord(tabId);
      this.markHealthy();
      return await collectSearchResults(record.page, tabId, maxResults);
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async closeTab(tabId: string) {
    try {
      const record = await this.getTabRecord(tabId);
      this.tabs.delete(tabId);
      await record.page.close().catch(() => undefined);
      this.markHealthy();
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async dispose() {
    for (const tabId of [...this.tabs.keys()]) {
      await this.closeTab(tabId).catch(() => undefined);
    }

    if (this.browser?.isConnected()) {
      await this.browser.close().catch(() => undefined);
    }

    const chromeProcess = this.chromeProcess;
    this.chromeProcess = null;
    if (chromeProcess && chromeProcess.exitCode === null) {
      chromeProcess.kill("SIGTERM");
      await delay(300);
      if (chromeProcess.exitCode === null) {
        chromeProcess.kill("SIGKILL");
        await delay(100);
      }
    }

    this.browser = null;
    this.connectionPromise = null;
    this.lastError = null;
  }
}

export function createDefaultChromeRelayServiceOptions(userDataDir: string): ChromeRelayServiceOptions {
  return {
    chromeExecutablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    profileDir: join(userDataDir, "chrome-relay-profile"),
    screenshotRoot: join(userDataDir, DEFAULT_SCREENSHOT_ROOT_NAME),
  };
}

import type { Browser, BrowserContext, Page } from "playwright";
import {
  type BrowserBackend,
  type BrowserSessionRecord,
  type BrowserWaitUntil,
  collectSnapshot,
  ensureDirectoryForFile,
  escapeAttributeValue,
  friendlyBrowserError,
  resolveDefaultScreenshotPath,
} from "./browserTypes";

const DEFAULT_VIEWPORT = { width: 1440, height: 960 };
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

class PlaywrightSessionManager {
  private browserPromise: Promise<Browser> | null = null;

  private contextPromise: Promise<BrowserContext> | null = null;

  private pagePromise: Promise<Page> | null = null;

  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleIdleDisposal(onDispose: () => void) {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => {
      void this.dispose().finally(onDispose);
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
      // Best-effort cleanup.
    }
  }

  async navigate(session: BrowserSessionRecord, url: string, waitUntil: BrowserWaitUntil, onDispose: () => void) {
    try {
      const page = await this.getPage();
      session.tabId ??= `playwright:${session.sessionId}`;
      await page.goto(url, {
        waitUntil,
        timeout: 20_000,
      });

      return await collectSnapshot(page, "playwright", session.tabId);
    } catch (error) {
      throw new Error(friendlyBrowserError(error));
    } finally {
      this.scheduleIdleDisposal(onDispose);
    }
  }

  async snapshot(
    session: BrowserSessionRecord,
    options: { maxTextLength?: number; maxElements?: number } | undefined,
    onDispose: () => void,
  ) {
    try {
      const page = await this.getPage();
      session.tabId ??= `playwright:${session.sessionId}`;
      return await collectSnapshot(page, "playwright", session.tabId, options);
    } catch (error) {
      throw new Error(friendlyBrowserError(error));
    } finally {
      this.scheduleIdleDisposal(onDispose);
    }
  }

  async click(session: BrowserSessionRecord, ref: string, waitUntil: BrowserWaitUntil, onDispose: () => void) {
    try {
      const page = await this.getPage();
      session.tabId ??= `playwright:${session.sessionId}`;
      const selector = `[data-aliceloop-ref="${escapeAttributeValue(ref)}"]`;
      const locator = page.locator(selector).first();
      if ((await locator.count()) === 0) {
        throw new Error(`No browser element matches ref ${ref}. Run browser_snapshot again to refresh refs.`);
      }

      await locator.click({ timeout: 10_000 });
      await this.waitForSettledPage(page, waitUntil);
      return await collectSnapshot(page, "playwright", session.tabId);
    } catch (error) {
      throw new Error(friendlyBrowserError(error));
    } finally {
      this.scheduleIdleDisposal(onDispose);
    }
  }

  async type(session: BrowserSessionRecord, ref: string, text: string, submit: boolean, onDispose: () => void) {
    try {
      const page = await this.getPage();
      session.tabId ??= `playwright:${session.sessionId}`;
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

      return await collectSnapshot(page, "playwright", session.tabId);
    } catch (error) {
      throw new Error(friendlyBrowserError(error));
    } finally {
      this.scheduleIdleDisposal(onDispose);
    }
  }

  async screenshot(session: BrowserSessionRecord, outputPath: string | undefined, fullPage: boolean | undefined, onDispose: () => void) {
    try {
      const page = await this.getPage();
      session.tabId ??= `playwright:${session.sessionId}`;
      const targetPath = outputPath?.trim() || resolveDefaultScreenshotPath();
      ensureDirectoryForFile(targetPath);
      await page.screenshot({
        path: targetPath,
        fullPage: fullPage ?? true,
      });

      return {
        path: targetPath,
        url: page.url(),
        backend: "playwright" as const,
        tabId: session.tabId,
      };
    } catch (error) {
      throw new Error(friendlyBrowserError(error));
    } finally {
      this.scheduleIdleDisposal(onDispose);
    }
  }
}

const managers = new Map<string, PlaywrightSessionManager>();

function getManager(sessionId: string) {
  let manager = managers.get(sessionId);
  if (!manager) {
    manager = new PlaywrightSessionManager();
    managers.set(sessionId, manager);
  }

  return manager;
}

export const playwrightBrowserBackend: BrowserBackend = {
  kind: "playwright",
  navigate(session, url, waitUntil) {
    return getManager(session.sessionId).navigate(session, url, waitUntil, () => {
      managers.delete(session.sessionId);
    });
  },
  snapshot(session, options) {
    return getManager(session.sessionId).snapshot(session, options, () => {
      managers.delete(session.sessionId);
    });
  },
  click(session, ref, waitUntil) {
    return getManager(session.sessionId).click(session, ref, waitUntil, () => {
      managers.delete(session.sessionId);
    });
  },
  type(session, ref, text, submit) {
    return getManager(session.sessionId).type(session, ref, text, submit, () => {
      managers.delete(session.sessionId);
    });
  },
  screenshot(session, outputPath, fullPage) {
    return getManager(session.sessionId).screenshot(session, outputPath, fullPage, () => {
      managers.delete(session.sessionId);
    });
  },
  async disposeSession(session) {
    const manager = managers.get(session.sessionId);
    managers.delete(session.sessionId);
    await manager?.dispose();
    session.tabId = null;
  },
};


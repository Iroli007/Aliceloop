import type { BrowserRelayCapability } from "@aliceloop/runtime-core";

export type BrowserWaitUntil = "load" | "domcontentloaded" | "networkidle";
export type BrowserBackendKind = "desktop_chrome";

export interface BrowserSnapshotPayload {
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
  backend: BrowserBackendKind;
  tabId: string;
}

export interface BrowserScreenshotPayload {
  path: string;
  url: string;
  backend: BrowserBackendKind;
  tabId: string;
}

export interface BrowserReadablePayload {
  url: string;
  title: string;
  publishedAt: string | null;
  modifiedAt: string | null;
  pageText: string;
  backend: BrowserBackendKind;
  tabId: string;
}

export interface BrowserSearchResultPayload {
  title: string;
  url: string;
  snippet: string;
  domain: string;
}

export interface BrowserSearchResultsPayload {
  url: string;
  backend: BrowserBackendKind;
  tabId: string;
  results: BrowserSearchResultPayload[];
}

export interface ChromeRelayMeta {
  browserRelay: BrowserRelayCapability;
}

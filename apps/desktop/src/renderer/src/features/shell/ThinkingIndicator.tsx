import { useEffect, useMemo, useState } from "react";
import "./ThinkingIndicator.css";

interface ThinkingIndicatorProps {
  thinkingSteps?: string[];
}

const toolActivityLabelMap: Record<string, string> = {
  web_search: "Searching the web",
  web_fetch: "Fetching a page",
  browser_find: "Finding elements in the browser",
  browser_navigate: "Navigating the browser",
  browser_click: "Clicking in the browser",
  browser_type: "Typing in the browser",
  browser_scroll: "Scrolling the page",
  browser_press_key: "Using browser keyboard input",
  browser_snapshot: "Inspecting the page",
  browser_take_screenshot: "Capturing a browser screenshot",
  browser_wait_for: "Waiting for the page",
  browser_wait: "Waiting for page elements",
  browser_tabs: "Managing browser tabs",
  browser_hover: "Hovering in the browser",
  browser_select_option: "Selecting a browser option",
  browser_fill_form: "Filling a browser form",
  read: "Reading files",
  write: "Writing files",
  edit: "Editing files",
  grep: "Searching file contents",
  glob: "Scanning files",
  view_image: "Inspecting an image",
  bash: "Running shell commands",
  shell: "Running shell commands",
};

const backendLabelMap: Record<string, string> = {
  http_fetch: "HTTP fetch",
  browser_relay: "browser relay",
  desktop_chrome: "Chrome relay",
  pinchtab: "PinchTab",
  openai: "OpenAI",
};

function humanizeIdentifier(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^./, (char) => char.toUpperCase());
}

function toThinkingActivity(step: string) {
  const parts = step.split("·").map((part) => part.trim()).filter(Boolean);
  const toolName = parts.length >= 2 ? parts[1] : parts[0] ?? step.trim();
  const backend = parts.length >= 3 ? parts[2] : null;
  const activity = toolActivityLabelMap[toolName] ?? `Using ${humanizeIdentifier(toolName)}`;
  const backendLabel = backend ? (backendLabelMap[backend] ?? humanizeIdentifier(backend)) : null;
  return backendLabel ? `${activity} via ${backendLabel}` : activity;
}

export function ThinkingIndicator({ thinkingSteps = [] }: ThinkingIndicatorProps) {
  const rotationFrames = useMemo(() => {
    const activities = Array.from(new Set(thinkingSteps.map((step) => toThinkingActivity(step))));
    if (activities.length === 0) {
      return ["* Thinking..."];
    }

    return ["* Thinking...", ...activities.map((activity) => `* ${activity}...`)];
  }, [thinkingSteps]);
  const rotationKey = rotationFrames.join("||");
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    setFrameIndex(0);
  }, [rotationKey]);

  useEffect(() => {
    if (rotationFrames.length <= 1) {
      return;
    }

    const timer = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % rotationFrames.length);
    }, 1350);

    return () => {
      window.clearInterval(timer);
    };
  }, [rotationFrames.length, rotationKey]);

  const currentFrame = rotationFrames[frameIndex] ?? "* Thinking...";

  return (
    <div className="thinking-indicator">
      <div className="thinking-indicator__header">
        <span className="thinking-indicator__text" data-text={currentFrame}>
          {currentFrame}
        </span>
      </div>
    </div>
  );
}

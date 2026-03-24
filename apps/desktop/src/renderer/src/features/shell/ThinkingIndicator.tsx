import { useEffect, useMemo, useState } from "react";
import "./ThinkingIndicator.css";

interface ThinkingIndicatorProps {
  thinkingSteps?: string[];
}

const toolActivityLabelMap: Record<string, string> = {
  web_search: "web_searching",
  web_fetch: "web_fetching",
  browser_navigate: "browser_navigating",
  read: "reading",
  write: "writing",
  edit: "editing",
  shell: "executing",
};

function toThinkingActivity(step: string) {
  const parts = step.split("·").map((part) => part.trim()).filter(Boolean);
  const toolName = parts.length >= 2 ? parts[1] : parts[0] ?? step.trim();
  const backend = parts.length >= 3 ? parts[2] : null;
  const activity = toolActivityLabelMap[toolName] ?? `${toolName.replace(/[\s-]+/g, "_")}ing`;
  return backend ? `${activity} · ${backend}` : activity;
}

export function ThinkingIndicator({ thinkingSteps = [] }: ThinkingIndicatorProps) {
  const artGradient = "linear-gradient(92deg, rgba(251, 146, 60, 0.5) 0%, #fb923c 28%, #fed7aa 50%, #fb923c 72%, rgba(251, 146, 60, 0.5) 100%)";
  const rotationFrames = useMemo(() => {
    const uniqueActivities = Array.from(new Set(thinkingSteps.map((step) => toThinkingActivity(step))));
    if (uniqueActivities.length === 0) {
      return ["Thinking"];
    }

    return uniqueActivities.flatMap((activity) => ["Thinking", activity]);
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
    }, 820);

    return () => {
      window.clearInterval(timer);
    };
  }, [rotationFrames.length, rotationKey]);

  const containerStyle = {
    margin: "12px 0 8px",
    padding: 0,
    border: "none",
    borderRadius: 0,
    background: "transparent",
    overflow: "visible",
  } as const;

  const headerStyle = {
    width: "100%",
    padding: "0",
    textAlign: "left",
    boxSizing: "border-box",
  } as const;

  const textStyle = {
    display: "inline-block",
    color: "#fb923c",
    fontSize: "13px",
    fontWeight: 600,
    fontFamily: '"JetBrains Mono", "SFMono-Regular", ui-monospace, monospace',
    lineHeight: 1.4,
    letterSpacing: "0.02em",
    backgroundImage: artGradient,
    backgroundSize: "240% 100%",
    backgroundClip: "text",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    textShadow: "0 0 8px rgba(251, 146, 60, 0.18)",
    animation: "thinking-sheen 2.2s linear infinite",
  } as const;

  return (
    <div className="thinking-indicator" style={containerStyle}>
      <div className="thinking-indicator__header" style={headerStyle}>
        <span className="thinking-indicator__text" style={textStyle}>
          {`* ${rotationFrames[frameIndex] ?? "Thinking"}...`}
        </span>
      </div>
    </div>
  );
}

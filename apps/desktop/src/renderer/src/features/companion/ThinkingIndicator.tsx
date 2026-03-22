import { useState } from "react";
import "./ThinkingIndicator.css";

interface ThinkingIndicatorProps {
  thinkingSteps?: string[];
}

export function ThinkingIndicator({ thinkingSteps = [] }: ThinkingIndicatorProps) {
  const [expanded, setExpanded] = useState(false);

  if (thinkingSteps.length === 0) {
    return null;
  }

  return (
    <div className="thinking-indicator">
      <button
        type="button"
        className="thinking-indicator__header"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="thinking-indicator__text">Alice is thinking</span>
      </button>

      {expanded && (
        <div className="thinking-indicator__steps">
          {thinkingSteps.map((step, index) => (
            <div key={index} className="thinking-indicator__step">
              {step}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface TurnMetaBadgeProps {
  tools: string[];
  skills: string[];
}

function ToolIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M14.5 5.5a4.5 4.5 0 0 0-5.8 5.8L3.8 16.2a1.9 1.9 0 0 0 2.7 2.7l4.9-4.9a4.5 4.5 0 0 0 5.8-5.8l-3 3-2.6-2.6 3-3Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SkillIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3.8 14.2 9l5.5.8-4 3.9.9 5.6-4.6-2.4-4.6 2.4.9-5.6-4-3.9L9.8 9 12 3.8Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function TurnMetaBadge({ tools, skills }: TurnMetaBadgeProps) {
  if (tools.length === 0 && skills.length === 0) {
    return null;
  }

  return (
    <aside className="workspace__turn-meta" aria-label="工具与技能">
      <div className="workspace__turn-meta-summary" tabIndex={0}>
        <span className="workspace__turn-meta-count">
          <ToolIcon />
          <span>{`${tools.length} tools`}</span>
        </span>
        <span className="workspace__turn-meta-divider" aria-hidden="true">
          ·
        </span>
        <span className="workspace__turn-meta-count">
          <SkillIcon />
          <span>{`${skills.length} skills`}</span>
        </span>
      </div>
      <div className="workspace__turn-meta-panel" role="tooltip">
        <section className="workspace__turn-meta-section">
          <span className="workspace__turn-meta-label">tools</span>
          <ul className="workspace__turn-meta-list">
            {tools.length > 0 ? (
              tools.map((item) => <li key={item}>{item}</li>)
            ) : (
              <li className="workspace__turn-meta-empty">无</li>
            )}
          </ul>
        </section>
        <section className="workspace__turn-meta-section">
          <span className="workspace__turn-meta-label">skills</span>
          <ul className="workspace__turn-meta-list">
            {skills.length > 0 ? (
              skills.map((item) => <li key={item}>{item}</li>)
            ) : (
              <li className="workspace__turn-meta-empty">无</li>
            )}
          </ul>
        </section>
      </div>
    </aside>
  );
}

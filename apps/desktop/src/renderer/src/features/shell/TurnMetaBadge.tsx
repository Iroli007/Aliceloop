interface TurnMetaBadgeProps {
  memories: string[];
  tools: string[];
  skills: string[];
}

function MemoryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 4.5c-3 0-5.5 2.2-5.5 5 0 1.5.7 2.8 1.8 3.7l-.7 3.1 3-1.8c.5.1.9.2 1.4.2 3 0 5.5-2.2 5.5-5s-2.5-5.2-5.5-5.2Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M9.8 9.5h4.4M10.5 12h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
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

export function TurnMetaBadge({ memories, tools, skills }: TurnMetaBadgeProps) {
  const displayedMemories = memories.slice(0, 5);
  const showMemories = displayedMemories.length > 0;
  const showTools = tools.length > 0;
  const showSkills = skills.length > 0;

  if (!showMemories && !showTools && !showSkills) {
    return null;
  }

  return (
    <aside className="workspace__turn-meta" aria-label="记忆、工具与技能">
      {showMemories ? (
        <>
          <div className="workspace__turn-meta-anchor">
            <button type="button" className="workspace__turn-meta-trigger">
              <MemoryIcon />
              <span>{`${displayedMemories.length} memories`}</span>
            </button>
            <div className="workspace__turn-meta-panel" role="tooltip">
              <section className="workspace__turn-meta-section">
                <h3 className="workspace__turn-meta-title">Retrieved Memories</h3>
                <ul className="workspace__turn-meta-list workspace__turn-meta-list--memories">
                  {displayedMemories.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </section>
            </div>
          </div>
          {showTools || showSkills ? (
            <span className="workspace__turn-meta-divider" aria-hidden="true">
              ·
            </span>
          ) : null}
        </>
      ) : null}
      {showTools ? (
        <>
          <div className="workspace__turn-meta-anchor">
            <button type="button" className="workspace__turn-meta-trigger">
              <ToolIcon />
              <span>{`${tools.length} tools`}</span>
            </button>
            <div className="workspace__turn-meta-panel" role="tooltip">
              <section className="workspace__turn-meta-section">
                <span className="workspace__turn-meta-label">tools</span>
                <ul className="workspace__turn-meta-list">
                  {tools.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </section>
            </div>
          </div>
          {showSkills ? (
            <span className="workspace__turn-meta-divider" aria-hidden="true">
              ·
            </span>
          ) : null}
        </>
      ) : null}
      {showSkills ? (
        <div className="workspace__turn-meta-anchor">
          <button type="button" className="workspace__turn-meta-trigger">
            <SkillIcon />
            <span>{`${skills.length} skills`}</span>
          </button>
          <div className="workspace__turn-meta-panel" role="tooltip">
            <section className="workspace__turn-meta-section">
              <span className="workspace__turn-meta-label">skills</span>
              <ul className="workspace__turn-meta-list">
                {skills.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </section>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

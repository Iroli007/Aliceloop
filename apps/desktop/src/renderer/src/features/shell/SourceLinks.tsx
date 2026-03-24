import { useState, type SyntheticEvent } from "react";

export interface SourceLink {
  label: string;
  url: string;
  iconUrl: string | null;
  domain?: string | null;
}

interface SourceLinksSectionProps {
  links: SourceLink[];
  detailsClassName: string;
  summaryClassName: string;
  listClassName: string;
  linkClassName: string;
}

export function SourceLinksSection({
  links,
  detailsClassName,
  summaryClassName,
  listClassName,
  linkClassName,
}: SourceLinksSectionProps) {
  const [iconsEnabled, setIconsEnabled] = useState(false);

  if (links.length === 0) {
    return null;
  }

  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (event.currentTarget.open) {
      setIconsEnabled(true);
    }
  };

  return (
    <details className={detailsClassName} onToggle={handleToggle}>
      <summary className={summaryClassName}>
        <span>{`Used ${links.length} source${links.length === 1 ? "" : "s"}`}</span>
        <span className="tool-workflow-card__sources-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className={listClassName}>
        {links.map((link) => (
          <a
            key={link.url}
            href={link.url}
            target="_blank"
            rel="noreferrer"
            className={linkClassName}
          >
            <span className="tool-workflow-card__source-link-icon" aria-hidden="true">
              {iconsEnabled && link.iconUrl ? (
                <img
                  src={link.iconUrl}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="tool-workflow-card__source-link-icon-image"
                />
              ) : null}
            </span>
            <span className="tool-workflow-card__source-link-main">
              <span className="tool-workflow-card__source-link-text">{link.label}</span>
              {link.domain ? (
                <span className="tool-workflow-card__source-link-domain">{`(${link.domain})`}</span>
              ) : null}
            </span>
            <span className="tool-workflow-card__source-link-external" aria-hidden="true">↗</span>
          </a>
        ))}
      </div>
    </details>
  );
}

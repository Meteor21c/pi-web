type Translate = (key: string, params?: Record<string, string | number>) => string;

interface Props {
  loading: boolean;
  prompt: string | null;
  translate: Translate;
}

export function SystemPromptPanel({ loading, prompt, translate }: Props) {
  return (
    <section className="system-prompt-panel ui-glass-menu" aria-label={translate("system.prompt")}>
      <header className="system-prompt-heading">
        <span className="top-panel-heading-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="8" y1="13" x2="16" y2="13" />
            <line x1="8" y1="17" x2="13" y2="17" />
          </svg>
        </span>
        <div className="system-prompt-heading-copy top-panel-heading-copy">
          <strong>{translate("system.label")}</strong>
          <small>{translate("system.description")}</small>
        </div>
        <span className="system-prompt-readonly top-panel-heading-badge">{translate("system.readOnly")}</span>
      </header>
      <div className="system-prompt-scroll">
        {prompt ? (
          <div className="system-prompt-text">{prompt}</div>
        ) : (
          <div className="system-prompt-empty">
            {prompt === ""
              ? translate("system.empty")
              : loading
                ? translate("system.loading")
                : translate("system.load")}
          </div>
        )}
      </div>

      <style>{`
        .system-prompt-panel {
          display: flex;
          width: calc(560px * var(--ui-scale, 1));
          height: min(calc(600px * var(--ui-scale, 1)), 72dvh);
          min-height: 220px;
          flex-direction: column;
          overflow: hidden;
        }
        .system-prompt-heading {
          align-items: center;
          justify-content: flex-start;
          gap: 10px;
        }
        .system-prompt-heading-copy {
          flex: 1;
        }
        .system-prompt-scroll {
          min-height: 0;
          flex: 1;
          overflow: auto;
          padding: 12px 16px;
        }
        .system-prompt-text {
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-size: 12px;
          line-height: 1.6;
          overflow-wrap: anywhere;
          white-space: pre-wrap;
        }
        .system-prompt-empty {
          padding: 10px 0;
          color: var(--text-muted);
          font-size: 12px;
          font-style: italic;
        }
      `}</style>
    </section>
  );
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface Props {
  loading: boolean;
  prompt: string | null;
  translate: Translate;
}

export function SystemPromptPanel({ loading, prompt, translate }: Props) {
  return (
    <section className="system-prompt-panel" aria-label={translate("system.prompt")}>
      <header className="system-prompt-heading">
        <div className="system-prompt-heading-copy">
          <strong>{translate("system.label")}</strong>
          <span>{translate("system.description")}</span>
        </div>
        <span className="system-prompt-readonly">{translate("system.readOnly")}</span>
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
          background: color-mix(in srgb, var(--assistant-bg) 76%, transparent);
          -webkit-backdrop-filter: blur(32px) saturate(1.7);
          backdrop-filter: blur(32px) saturate(1.7);
          border: 0.5px solid color-mix(in srgb, var(--border) 72%, transparent);
          border-radius: 18px;
          box-shadow:
            inset 0 1px 0 0 color-mix(in srgb, var(--assistant-bg) 88%, transparent),
            0 24px 64px rgba(0, 0, 0, 0.20),
            0 4px 14px rgba(0, 0, 0, 0.08);
          overflow: hidden;
        }
        .system-prompt-heading {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 14px;
          padding: 12px 16px;
          border-bottom: 0.5px solid color-mix(in srgb, var(--border) 70%, transparent);
          background: transparent;
        }
        .system-prompt-heading-copy {
          display: flex;
          min-width: 0;
          flex-direction: column;
          gap: 4px;
        }
        .system-prompt-heading-copy strong {
          color: var(--text);
          font-size: 12px;
        }
        .system-prompt-heading-copy span {
          color: var(--text-dim);
          font-size: 10px;
          line-height: 1.45;
        }
        .system-prompt-readonly {
          flex-shrink: 0;
          border: 1px solid var(--border);
          border-radius: 999px;
          padding: 2px 7px;
          color: var(--text-dim);
          font-size: 9px;
          line-height: 1.4;
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

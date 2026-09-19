"use client";

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vs } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import { ImagePreview } from "./ImagePreview";

interface MermaidBlockProps {
  code: string;
  isStreaming?: boolean;
  defaultPreview?: boolean;
}

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

/**
 * Return true when a value is a complete, standalone SVG document.
 *
 * Model responses sometimes contain SVG directly instead of an image content
 * block. Keeping this check deliberately strict means an inline icon or a
 * paragraph that merely mentions `<svg>` still goes through Markdown.
 */
export function isSvgMarkup(value: string): boolean {
  const trimmed = value.trim().replace(/^<\?xml[\s\S]*?\?>\s*/i, "");
  return /^<svg(?:\s|>)/i.test(trimmed) && /<\/svg\s*>\s*$/i.test(trimmed);
}

function escapeSvgAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sanitizeSvgCss(value: string): string {
  const withoutImports = value
    .replace(/@import[\s\S]*?;/gi, "")
    .replace(/(?:javascript|vbscript|data|file):/gi, "")
    .replace(/expression\s*\([^)]*\)/gi, "none");

  return withoutImports.replace(/url\(\s*(?:(['"])(.*?)\1|([^)]*?))\s*\)/gi, (match, quote: string | undefined, quoted: string | undefined, unquoted: string | undefined) => {
    const target = (quoted ?? unquoted ?? "").trim();
    // Local fragment references are needed for gradients, masks, filters and
    // clip paths. Every other URL is external input and is removed.
    return /^#[A-Za-z_][\w:.-]*$/.test(target) ? `url(${quote ?? ""}${target}${quote ?? ""})` : "none";
  });
}

/**
 * Make an SVG safe to use as an image data URL.
 *
 * We intentionally render model SVG through `<img>` rather than injecting it
 * into the application DOM. This extra sanitization removes active content
 * and external references while retaining local styles and animations.
 */
export function sanitizeSvgMarkup(markup: string): string {
  let safe = markup.trim()
    .replace(/^<\?xml[\s\S]*?\?>\s*/i, "")
    .replace(/<!DOCTYPE[\s\S]*?(?:>|$)/gi, "");

  safe = safe.replace(/<(script|foreignObject|iframe|object|embed|audio|video|canvas)\b[\s\S]*?<\/\1\s*>/gi, "");
  safe = safe.replace(/<(script|foreignObject|iframe|object|embed|audio|video|canvas)\b[^>]*\/?>/gi, "");
  safe = safe.replace(/\s+on[a-z0-9:_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");

  safe = safe.replace(/\s+((?:xlink:)?href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, (match, name: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, unquoted: string | undefined) => {
    const target = (doubleQuoted ?? singleQuoted ?? unquoted ?? "").trim();
    return /^#[A-Za-z_][\w:.-]*$/.test(target) ? ` ${name}="${escapeSvgAttribute(target)}"` : "";
  });

  safe = safe.replace(/\s+style\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (match, doubleQuoted: string | undefined, singleQuoted: string | undefined) => {
    const style = sanitizeSvgCss(doubleQuoted ?? singleQuoted ?? "");
    return ` style="${escapeSvgAttribute(style)}"`;
  });
  safe = safe.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (match, open: string, css: string, close: string) => `${open}${sanitizeSvgCss(css)}${close}`);

  return safe;
}

function decodeSvgText(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .trim()
    .replace(/\s+/g, " ");
}

/** Extract a short human-readable description from a model-generated SVG. */
export function extractSvgLabel(markup: string): string | undefined {
  const root = markup.match(/<svg\b[^>]*>/i)?.[0] ?? "";
  const aria = root.match(/\baria-label\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  const ariaLabel = decodeSvgText(aria?.[1] ?? aria?.[2] ?? aria?.[3] ?? "");
  if (ariaLabel) return ariaLabel.slice(0, 240);

  const title = markup.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const titleText = decodeSvgText(title?.[1] ?? "");
  if (titleText) return titleText.slice(0, 240);

  const description = markup.match(/<desc\b[^>]*>([\s\S]*?)<\/desc\s*>/i);
  const descriptionText = decodeSvgText(description?.[1] ?? "");
  return descriptionText ? descriptionText.slice(0, 240) : undefined;
}

export function downloadSvgMarkup(markup: string, filename = "image.svg"): void {
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadMermaidSvg(svg: SVGSVGElement): void {
  // Mermaid's HTML serialization can leave void tags such as <br> unclosed.
  const xml = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "mermaid-diagram.svg";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

type RenderState =
  | { key: string; status: "loading" }
  | { key: string; status: "error" }
  | { key: string; status: "ready"; svg: string };

export function MermaidBlock({ code, isStreaming, defaultPreview = false }: MermaidBlockProps) {
  const { isDark } = useTheme();
  const { t } = useI18n();
  const [showPreview, setShowPreview] = useState(defaultPreview);
  const [renderState, setRenderState] = useState<RenderState | null>(null);
  const [zoomOpen, setZoomOpen] = useState(false);
  const previewRef = useRef<HTMLButtonElement>(null);
  const currentKey = `${isDark ? "dark" : "light"}\n${code}`;
  const previewVisible = showPreview && !isStreaming;

  useEffect(() => {
    if (!previewVisible) return;

    let cancelled = false;
    setRenderState({ key: currentKey, status: "loading" });

    const render = async () => {
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: isDark ? "dark" : "default",
      });

      const parsed = await mermaid.parse(code, { suppressErrors: true });
      if (!parsed) throw new Error("Invalid Mermaid diagram");

      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? `mermaid-${crypto.randomUUID()}`
          : `mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const result = await mermaid.render(id, code);
      if (!cancelled) {
        setRenderState({ key: currentKey, status: "ready", svg: result.svg });
      }
    };

    render().catch(() => {
      if (!cancelled) setRenderState({ key: currentKey, status: "error" });
    });

    return () => {
      cancelled = true;
    };
  }, [code, currentKey, isDark, previewVisible]);

  const previewButton = useMemo(() => (
    <button
      type="button"
      onClick={() => setShowPreview((v) => !v)}
      disabled={isStreaming}
      title={isStreaming ? t("i18n.previewAfterStreaming") : (previewVisible ? t("i18n.showMermaidSource") : t("i18n.previewMermaid"))}
      className={["markdown-code-action", previewVisible ? "is-active" : ""].filter(Boolean).join(" ")}
    >
      {previewVisible ? t("i18n.source") : t("i18n.preview")}
    </button>
  ), [isStreaming, previewVisible, t]);

  if (!previewVisible) {
    return <CodeBlock code={code} lang="mermaid" headerAction={previewButton} isStreaming={isStreaming} />;
  }

  const body = renderState?.key === currentKey && renderState.status === "error" ? (
      <div className="mermaid-block mermaid-block-error">{t("i18n.invalidMermaid")}</div>
    ) : renderState?.key !== currentKey || renderState.status !== "ready" ? (
      <div className="mermaid-block mermaid-block-loading" aria-label={t("i18n.renderingMermaid")} />
    ) : (
      <>
        {!zoomOpen && (
          <button
            ref={previewRef}
            type="button"
            className="mermaid-block mermaid-preview-button"
            title={t("i18n.openMermaidViewer")}
            aria-label={t("i18n.openMermaidViewer")}
            onClick={() => setZoomOpen(true)}
            dangerouslySetInnerHTML={{ __html: renderState.svg }}
          />
        )}
        {zoomOpen && <MermaidZoomDialog svg={renderState.svg} onClose={() => setZoomOpen(false)} />}
      </>
    );

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">mermaid</span>
        <div className="markdown-code-actions">
          {renderState?.key === currentKey && renderState.status === "ready" && (
            <button
              type="button"
              className="markdown-code-action"
              title={`${t("i18n.downloadFile")} (SVG)`}
              aria-label={`${t("i18n.downloadFile")} (SVG)`}
              onClick={() => {
                const svg = previewRef.current?.querySelector("svg");
                if (svg) downloadMermaidSvg(svg);
              }}
            >
              SVG
            </button>
          )}
          {previewButton}
        </div>
      </div>
      {body}
    </div>
  );
}

interface SvgBlockProps {
  code: string;
  isStreaming?: boolean;
  defaultPreview?: boolean;
}

/**
 * Preview a complete SVG returned as assistant text while retaining a source
 * view for copying/debugging. This is intentionally separate from Mermaid:
 * arbitrary SVG is already a finished image and does not need a diagram
 * renderer or an HTML injection into the app DOM.
 */
export function SvgBlock({ code, isStreaming, defaultPreview = true }: SvgBlockProps) {
  const { t } = useI18n();
  const [showPreview, setShowPreview] = useState(defaultPreview);
  const previewVisible = showPreview && !isStreaming;
  const safeMarkup = useMemo(() => sanitizeSvgMarkup(code), [code]);
  const label = useMemo(() => extractSvgLabel(code), [code]);
  const imageSrc = useMemo(
    () => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(safeMarkup)}`,
    [safeMarkup],
  );

  const previewButton = useMemo(() => (
    <button
      type="button"
      onClick={() => setShowPreview((value) => !value)}
      disabled={isStreaming}
      title={isStreaming ? t("i18n.previewAfterStreaming") : (previewVisible ? t("i18n.showSvgSource") : t("i18n.previewSvg"))}
      className={["markdown-code-action", previewVisible ? "is-active" : ""].filter(Boolean).join(" ")}
    >
      {previewVisible ? t("i18n.source") : t("i18n.preview")}
    </button>
  ), [isStreaming, previewVisible, t]);

  if (!previewVisible) {
    return <CodeBlock code={code} lang="svg" headerAction={previewButton} isStreaming={isStreaming} />;
  }

  return (
    <div className="markdown-code-block svg-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">svg</span>
        <div className="markdown-code-actions">
          <button
            type="button"
            className="markdown-code-action"
            title={`${t("i18n.downloadFile")} (SVG)`}
            aria-label={`${t("i18n.downloadFile")} (SVG)`}
            onClick={() => downloadSvgMarkup(safeMarkup)}
          >
            SVG
          </button>
          {previewButton}
        </div>
      </div>
      <div className="svg-block">
        <div className="svg-block-caption">{label ?? t("i18n.svgImage")}</div>
        <ImagePreview src={imageSrc} alt={label ?? t("i18n.svgImage")} className="svg-preview-trigger">
          {/* SVG is displayed as an image data URL, never injected into the app DOM. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="svg-block-image" src={imageSrc} alt={label ?? t("i18n.svgImage")} decoding="async" />
        </ImagePreview>
      </div>
    </div>
  );
}

function MermaidZoomDialog({ svg, onClose }: { svg: string; onClose: () => void }) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();

    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="mermaid-zoom-dialog"
      aria-label={t("i18n.mermaidViewer")}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
    >
      <div className="mermaid-zoom-layout">
        <div className="mermaid-zoom-toolbar">
          <span className="mermaid-zoom-title">{t("i18n.mermaidDiagram")}</span>
          <div className="mermaid-zoom-actions">
            <div className="mermaid-zoom-stepper">
              <button
                type="button"
                onClick={() => setZoom((value) => Math.max(ZOOM_MIN, value - ZOOM_STEP))}
                disabled={zoom <= ZOOM_MIN}
                title={t("i18n.zoomOut")}
                aria-label={t("i18n.zoomOut")}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M5 12h14" />
                </svg>
              </button>
              <span className="mermaid-zoom-value">{Math.round(zoom * 100)}%</span>
              <button
                type="button"
                onClick={() => setZoom((value) => Math.min(ZOOM_MAX, value + ZOOM_STEP))}
                disabled={zoom >= ZOOM_MAX}
                title={t("i18n.zoomIn")}
                aria-label={t("i18n.zoomIn")}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </div>
            <button
              type="button"
              className="mermaid-zoom-icon-button"
              onClick={() => setZoom(1)}
              title={t("i18n.fitToWidth")}
              aria-label={t("i18n.fitToWidth")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
              </svg>
            </button>
            <button
              type="button"
              className="mermaid-zoom-icon-button"
              onClick={onClose}
              title={t("i18n.close")}
              aria-label={t("i18n.close")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        </div>
        <div
          className="mermaid-zoom-viewport"
          onClick={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <div
            className="mermaid-zoom-canvas"
            style={{ width: `${zoom * 100}%` }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>
    </dialog>
  );
}

interface CodeBlockProps {
  code: string;
  lang: string;
  headerAction?: ReactNode;
  isStreaming?: boolean;
}

/**
 * Syntax-highlighted code block with copy button.
 * Used as the "source" view for mermaid blocks and for all non-mermaid code fences.
 *
 * Memoized: parent markdown re-renders (e.g. streaming updates elsewhere in
 * the message list) must not re-run Prism tokenization on unchanged code.
 * While the owning message is still streaming, the block renders as plain
 * monospace text — highlighting a growing block re-tokenizes all of it on
 * every chunk, which is the single most expensive part of streamed rendering.
 */
export const CodeBlock = memo(function CodeBlock({ code, lang, headerAction, isStreaming }: CodeBlockProps) {
  const { isDark } = useTheme();
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const lineCount = code ? code.split("\n").length : 0;
  // Keep ordinary snippets immediately readable. Large model-generated files
  // are secondary detail for most users, so they start as one compact row and
  // only pay the syntax-highlighting/rendering cost when explicitly opened.
  const collapsible = lineCount > 18 || code.length > 1_600;
  const codeVisible = !collapsible || expanded;

  const copy = () => {
    copyText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className={["markdown-code-block", !codeVisible ? "is-collapsed" : ""].filter(Boolean).join(" ")}>
      <div className="markdown-code-header">
        <span className="markdown-code-summary">
          <span className="markdown-code-lang">{lang || "text"}</span>
          {collapsible && (
            <span className="markdown-code-size">
              {t("chat.codeLines", { count: lineCount })}
            </span>
          )}
        </span>
        <div className="markdown-code-actions">
          {headerAction}
          <button
            type="button"
            onClick={copy}
            className="markdown-code-action"
          >
            {copied ? t("i18n.copied") : t("i18n.copy")}
          </button>
          {collapsible && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="markdown-code-action markdown-code-toggle"
              aria-expanded={expanded}
            >
              {expanded ? t("i18n.collapse") : t("i18n.expand")}
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className={expanded ? "is-expanded" : undefined}
              >
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {codeVisible && (isStreaming ? (
        <pre
          style={{
            margin: 0,
            padding: "11px 13px",
            fontSize: "calc(12.5px + var(--chat-font-size-offset, 0px))",
            lineHeight: 1.62,
            overflowX: "auto",
            background: "color-mix(in srgb, var(--bg) 92%, var(--bg-panel))",
          }}
        >
          <code style={{ fontFamily: "var(--font-mono)" }}>{code}</code>
        </pre>
      ) : (
        <SyntaxHighlighter
          language={lang || "text"}
          style={isDark ? vscDarkPlus : vs}
          showLineNumbers
          lineNumberStyle={{ color: "var(--text-dim)", fontStyle: "normal" }}
          customStyle={{
            margin: 0,
            padding: "11px 13px",
            fontSize: "calc(12.5px + var(--chat-font-size-offset, 0px))",
            lineHeight: 1.62,
            borderRadius: 0,
            background: "color-mix(in srgb, var(--bg) 92%, var(--bg-panel))",
          }}
          codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
        >
          {code}
        </SyntaxHighlighter>
      ))}
    </div>
  );
});

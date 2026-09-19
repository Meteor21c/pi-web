"use client";

import { useMemo, type MouseEvent } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { useI18n } from "@/hooks/useI18n";
import { looksLikeLocalFileReference, resolveLocalFileHref, resolveLocalFileReference, shouldOpenLocalFileInApp } from "@/lib/file-links";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { markdownRehypePlugins, markdownRemarkPlugins, markdownUrlTransform, normalizeDisplayMath } from "@/lib/markdown";
import { isSvgMarkup, MermaidBlock, CodeBlock, SvgBlock } from "./MermaidBlock";
import { ImagePreview } from "./ImagePreview";

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
}

export function MarkdownBody({ children, className, isStreaming, cwd, onOpenFile }: MarkdownBodyProps) {
  const { t } = useI18n();
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(children), [children]);
  const standaloneSvg = isSvgMarkup(children);
  // Stable renderer identities keep stateful blocks mounted across message hover updates.
  const components = useMemo<Components>(() => ({
    code({ className, children, ...props }) {
      delete props.node;
      const lang = className?.replace("language-", "").toLowerCase() ?? "";
      const raw = String(children);
      const isBlock = className?.includes("language-") || raw.includes("\n");
      if (isBlock) {
        if (lang === "mermaid") {
          return (
            <MermaidBlock
              code={raw.replace(/\n$/, "")}
              isStreaming={isStreaming}
              defaultPreview
            />
          );
        }
        if (isSvgMarkup(raw) && (lang === "svg" || lang === "xml" || lang === "html" || lang === "xhtml" || !lang)) {
          return <SvgBlock code={raw.replace(/\n$/, "")} isStreaming={isStreaming} defaultPreview />;
        }
        return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} isStreaming={isStreaming} />;
      }
      const externalUrl = resolveExternalHttpUrl(raw);
      if (externalUrl) {
        return (
          <a
            href={externalUrl}
            className="markdown-inline-link-code"
            target="_blank"
            rel="noopener noreferrer"
            title={externalUrl}
          >
            <code className="markdown-inline-code">{children}</code>
            <span className="markdown-external-reference-icon" aria-hidden="true">↗</span>
          </a>
        );
      }
      const filePath = onOpenFile && looksLikeLocalFileReference(raw)
        ? resolveLocalFileReference(raw, cwd)
        : null;
      if (filePath && onOpenFile) {
        return (
          <button
            type="button"
            className="markdown-file-reference"
            title={filePath}
            aria-label={t("chat.openFile", { file: filePath })}
            onClick={() => onOpenFile(filePath)}
          >
            <code className="markdown-inline-code">{children}</code>
            <span className="markdown-file-reference-icon" aria-hidden="true">↗</span>
          </button>
        );
      }
      return (
        <code
          className="markdown-inline-code"
          {...props}
        >
          {children}
        </code>
      );
    },
    pre({ children }) {
      return <>{children}</>;
    },
    a({ href, children, ...props }) {
      // `node` is react-markdown metadata, not a DOM attribute.
      delete props.node;
      const filePath = onOpenFile ? resolveLocalFileHref(href, cwd) : null;
      const openFile = onOpenFile;
      if (!filePath || !openFile) {
        return (
          <a href={href} {...props} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      }

      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        if (!shouldOpenLocalFileInApp(event)) return;
        const target = event.currentTarget.getAttribute("target");
        if (target && target !== "_self") return;
        event.preventDefault();
        openFile(filePath);
      };

      return (
        <a href={href} {...props} onClick={handleClick}>
          {children}
        </a>
      );
    },
    img({ src, alt, ...props }) {
      delete props.node;
      const filePath = typeof src === "string" ? resolveLocalFileHref(src, cwd) : null;
      const imageSrc = filePath
        ? `/api/files/${encodeFilePathForApi(filePath)}?type=read`
        : src;
      if (typeof imageSrc !== "string" || !imageSrc) return null;
      // Dynamic local paths are served directly by the file API.
      return (
        <ImagePreview src={imageSrc} alt={alt ?? ""}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            {...props}
            src={imageSrc}
            alt={alt ?? ""}
            loading="lazy"
            decoding="async"
            style={{
              display: "block",
              maxWidth: "min(100%, 420px)",
              maxHeight: 320,
              objectFit: "contain",
              borderRadius: 8,
              border: "1px solid var(--border)",
              ...(props.style as React.CSSProperties | undefined),
            }}
          />
        </ImagePreview>
      );
    },
    table({ children }) {
      return (
        <div className="markdown-table-wrap">
          <table>{children}</table>
        </div>
      );
    },
  }), [cwd, isStreaming, onOpenFile, t]);

  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      {standaloneSvg ? (
        <SvgBlock code={children} isStreaming={isStreaming} defaultPreview />
      ) : (
        <ReactMarkdown
          remarkPlugins={markdownRemarkPlugins}
          rehypePlugins={markdownRehypePlugins}
          urlTransform={onOpenFile ? markdownUrlTransform : undefined}
          components={components}
        >
          {normalizedMarkdown}
        </ReactMarkdown>
      )}
    </div>
  );
}

function resolveExternalHttpUrl(value: string): string | null {
  const candidate = value.trim();
  if (/^https?:\/\//i.test(candidate)) return candidate;
  if (/^www\./i.test(candidate)) return `https://${candidate}`;
  return null;
}

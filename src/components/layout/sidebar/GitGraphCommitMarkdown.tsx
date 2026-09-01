import { useMemo } from "react";
import { message } from "antd";
import { useTranslation } from "react-i18next";
import type { MouseEvent, ReactNode } from "react";
import {
  getMarkdownSourceBlocks,
  type MarkdownSourceBlock,
} from "@/components/markdown/markdownSourceBlocks";
import {
  parseCommitMarkdownCode,
  parseCommitMarkdownHeading,
  parseCommitMarkdownInline,
  parseCommitMarkdownList,
  parseCommitMarkdownQuote,
  type CommitMarkdownInlineToken,
} from "@/lib/gitCommitMarkdown";
import { openInAssociatedApplication } from "@/lib/api";

function renderInlineTokens(tokens: CommitMarkdownInlineToken[], keyPrefix: string): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (token.kind) {
      case "code":
        return (
          <code
            key={key}
            className="rounded px-1 py-0.5 font-mono text-[11px]"
            style={{
              background: "var(--cs-bg-hover)",
              color: "var(--cs-primary)",
              border: "1px solid var(--cs-border-card)",
            }}
          >
            {token.text}
          </code>
        );
      case "strong":
        return (
          <strong key={key} className="font-semibold" style={{ color: "var(--cs-text-primary)" }}>
            {token.text}
          </strong>
        );
      case "em":
        return <em key={key}>{token.text}</em>;
      case "del":
        return (
          <del key={key} style={{ color: "var(--cs-text-tertiary)" }}>
            {token.text}
          </del>
        );
      case "link":
        return (
          <a
            key={key}
            href={token.href}
            className="cursor-pointer break-all underline decoration-[var(--cs-border-card)] underline-offset-2"
            style={{ color: "var(--cs-primary)" }}
          >
            {token.text}
          </a>
        );
      default:
        return <span key={key}>{token.text}</span>;
    }
  });
}

interface GitGraphCommitMarkdownProps {
  source: string;
  className?: string;
}

export function GitGraphCommitMarkdown({ source, className }: GitGraphCommitMarkdownProps) {
  const { t } = useTranslation();
  const blocks = useMemo(() => getMarkdownSourceBlocks(source), [source]);

  // 悬浮卡内的链接不得让 webview 自身导航，外链统一交给系统默认程序
  const handleClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement | null)?.closest("a");
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    if (!/^https?:\/\//i.test(href) && !href.startsWith("www.")) return;
    void openInAssociatedApplication(href).catch(() => {
      message.error(t("fileTabs.openFailed"));
    });
  };

  if (blocks.length === 0) return null;

  const renderBlock = (block: MarkdownSourceBlock) => {
    const key = `block-${block.id}`;
    const inline = (text: string) => renderInlineTokens(parseCommitMarkdownInline(text), key);

    if (block.kind === "heading") {
      const heading = parseCommitMarkdownHeading(block.source);
      if (heading) {
        return (
          <div key={key} className="font-semibold" style={{ color: "var(--cs-text-primary)" }}>
            {inline(heading.text)}
          </div>
        );
      }
    }

    if (block.kind === "list") {
      const items = parseCommitMarkdownList(block.source);
      if (items.length > 0) {
        const ListTag = items[0].ordered ? "ol" : "ul";
        return (
          <ListTag
            key={key}
            className={`m-0 space-y-0.5 pl-4 ${items[0].ordered ? "list-decimal" : "list-disc"}`}
          >
            {items.map((item, itemIndex) => (
              <li key={`${key}-${itemIndex}`} className="break-words">
                {inline(item.text)}
              </li>
            ))}
          </ListTag>
        );
      }
    }

    if (block.kind === "code") {
      return (
        <pre
          key={key}
          className="m-0 overflow-x-auto rounded border px-2 py-1 font-mono text-[11px] leading-[16px]"
          style={{
            background: "var(--cs-bg-hover)",
            color: "var(--cs-text-primary)",
            borderColor: "var(--cs-border-card)",
          }}
        >
          <code>{parseCommitMarkdownCode(block.source)}</code>
        </pre>
      );
    }

    if (block.kind === "quote") {
      return (
        <div
          key={key}
          className="whitespace-pre-wrap break-words border-l-2 pl-2"
          style={{ borderColor: "var(--cs-border-card)" }}
        >
          {inline(parseCommitMarkdownQuote(block.source))}
        </div>
      );
    }

    if (block.kind === "rule") {
      return <div key={key} className="h-px w-full" style={{ background: "var(--cs-border-card)" }} />;
    }

    // paragraph / table / html 统一按纯文本段落呈现，保留换行
    return (
      <div key={key} className="whitespace-pre-wrap break-words">
        {inline(block.source)}
      </div>
    );
  };

  return (
    <div
      className={`flex min-w-0 flex-col gap-1 ${className ?? ""}`}
      onClickCapture={handleClickCapture}
    >
      {blocks.map(renderBlock)}
    </div>
  );
}

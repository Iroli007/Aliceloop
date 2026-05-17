import { isValidElement, memo, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface MessageContentProps {
  content: string;
  renderMarkdown?: boolean;
}

function getNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(getNodeText).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return getNodeText(node.props.children);
  }
  return "";
}

function CopyIcon({ copied }: { copied: boolean }) {
  if (copied) {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path d="M2 7l3.5 3.5L12 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="4.5" y="4.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.5 9.5H3a1.5 1.5 0 01-1.5-1.5V3a1.5 1.5 0 011.5-1.5h5a1.5 1.5 0 011.5 1.5v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const label = language || "text";

  function handleCopy() {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => undefined);
  }

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-block__header">
        <span className="markdown-code-block__language">{label}</span>
        <button
          type="button"
          className={`markdown-code-block__copy${copied ? " markdown-code-block__copy--copied" : ""}`}
          onClick={handleCopy}
          aria-label={copied ? "已复制代码" : "复制代码"}
          title={copied ? "已复制" : "复制"}
        >
          <CopyIcon copied={copied} />
        </button>
      </div>
      <pre className="markdown-code-block__pre">
        <code className={`markdown-code-block__code language-${label}`}>{code}</code>
      </pre>
    </div>
  );
}

function MarkdownPre({ children }: ComponentPropsWithoutRef<"pre">) {
  let language = "text";
  let code = getNodeText(children).replace(/\n$/, "");

  if (isValidElement<{ className?: string; children?: ReactNode }>(children)) {
    const match = /language-([^\s]+)/u.exec(children.props.className ?? "");
    language = match?.[1] ?? language;
    code = getNodeText(children.props.children).replace(/\n$/, "");
  }

  return <CodeBlock language={language} code={code} />;
}

const markdownComponents: Components = {
  pre: MarkdownPre,
};

function normalizePseudoCodeTags(value: string) {
  return value.replace(
    /<(bash|sh|shell|python|py|javascript|js|typescript|ts|json)>\s*([\s\S]*?)\s*<\/\1>/giu,
    (_match, rawLanguage: string, code: string) => {
      const language = rawLanguage === "shell" ? "bash" : rawLanguage;
      return `\`\`\`${language}\n${code.trim()}\n\`\`\``;
    },
  );
}

function MessageContentInner({ content, renderMarkdown = false }: MessageContentProps) {
  if (!renderMarkdown) {
    return <>{content}</>;
  }

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {normalizePseudoCodeTags(content)}
    </ReactMarkdown>
  );
}

export const MessageContent = memo(
  MessageContentInner,
  (prev, next) => prev.content === next.content && prev.renderMarkdown === next.renderMarkdown,
);

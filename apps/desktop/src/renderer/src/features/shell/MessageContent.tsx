import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MessageContentProps {
  content: string;
  renderMarkdown?: boolean;
}

function MessageContentInner({ content, renderMarkdown = false }: MessageContentProps) {
  if (!renderMarkdown) {
    return <>{content}</>;
  }

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]}>
      {content}
    </ReactMarkdown>
  );
}

export const MessageContent = memo(
  MessageContentInner,
  (prev, next) => prev.content === next.content && prev.renderMarkdown === next.renderMarkdown,
);

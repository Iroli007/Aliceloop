import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MessageContentProps {
  content: string;
  renderMarkdown?: boolean;
}

export function MessageContent({ content, renderMarkdown = false }: MessageContentProps) {
  if (!renderMarkdown) {
    return <>{content}</>;
  }

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]}>
      {content}
    </ReactMarkdown>
  );
}

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

interface Props {
  source: string;
  className?: string;
  /**
   * Optional click handler for file-like links. If provided, links whose href
   * looks like a local path (no scheme or protocol-relative) call this with
   * the path string instead of navigating.
   */
  onOpenFile?: (path: string) => void;
}

export function Markdown({ source, className, onOpenFile }: Props) {
  return (
    <div className={`prose-cc ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeHighlight]}
        components={{
          a: ({ node, href, children, ...rest }) => {
            void node;
            const isLocal =
              !!href &&
              !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href);
            if (isLocal && onOpenFile) {
              return (
                <a
                  {...rest}
                  href={href}
                  onClick={(e) => {
                    e.preventDefault();
                    onOpenFile(href!);
                  }}
                >
                  {children}
                </a>
              );
            }
            // Non-local link — open in a new tab as a courtesy.
            const externalProps = isLocal
              ? {}
              : { target: "_blank", rel: "noopener noreferrer" };
            return (
              <a {...rest} {...externalProps} href={href}>
                {children}
              </a>
            );
          },
          // Wide tables would otherwise force the whole page to scroll
          // horizontally on phones. Wrap them in a horizontally-scrollable
          // div so the rest of the layout stays put.
          table: ({ node, ...rest }) => {
            void node;
            return (
              <div className="my-2 overflow-x-auto">
                <table {...rest} />
              </div>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

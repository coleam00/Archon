import type { ReactElement } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
import { StreamCard } from './StreamCard';
import type { Message } from '../primitives/message';

interface MessageItemProps {
  message: Message;
}

const MD_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline decoration-text-tertiary/50 underline-offset-2 transition-colors hover:text-accent-bright hover:decoration-accent-bright"
    >
      {children}
    </a>
  ),
  code: ({ className, children }) => {
    const isBlock = className?.startsWith('language-');
    if (isBlock) {
      return <code className={className}>{children}</code>;
    }
    return (
      <code className="rounded bg-surface-inset px-1 py-[1px] font-mono text-[12px] text-text-primary">
        {children}
      </code>
    );
  },
  h1: ({ children }) => (
    <h1 className="mt-2 mb-1.5 text-[14px] font-semibold text-text-primary">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-2 mb-1 text-[13px] font-semibold text-text-primary">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-1.5 mb-0.5 text-[12px] font-semibold uppercase tracking-wider text-text-secondary">
      {children}
    </h3>
  ),
  p: ({ children }) => <p className="my-1 leading-relaxed">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-1 ml-5 list-disc space-y-0.5 marker:text-text-tertiary">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1 ml-5 list-decimal space-y-0.5 marker:text-text-tertiary">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded border border-border bg-surface-inset p-2 text-[12px] leading-relaxed">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-border pl-2 text-text-secondary">
      {children}
    </blockquote>
  ),
};

const SHORT_USER_THRESHOLD = 140;

/**
 * Single message rendered as a small card. Tool calls are broken out into
 * separate cards (see RunStream / ToolCallItem), so this one only renders
 * prose + error.
 *
 * Short user messages render as compact single-line chips so the initial
 * `Fix issue #1179`-style prompts don't eat the same real estate as a 2000-char
 * agent response.
 */
export function MessageItem({ message }: MessageItemProps): ReactElement {
  const kind = message.role;
  const content = message.content.trim();

  // Compact chip form for short user prompts.
  if (
    kind === 'user' &&
    message.error === null &&
    content.length > 0 &&
    content.length <= SHORT_USER_THRESHOLD &&
    !content.includes('\n')
  ) {
    return (
      <StreamCard
        timestamp={message.timestamp}
        kind="user"
        compact
        headerRight={
          <span className="truncate font-mono text-[12px] text-text-primary">{content}</span>
        }
      />
    );
  }

  return (
    <StreamCard timestamp={message.timestamp} kind={kind}>
      {content.length > 0 ? (
        <div className="max-w-none text-[13px] leading-relaxed text-text-primary">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks]}
            rehypePlugins={[rehypeHighlight]}
            components={MD_COMPONENTS}
          >
            {content}
          </ReactMarkdown>
        </div>
      ) : null}
      {message.error !== null ? (
        <div className="mt-2 rounded border border-error/40 bg-error/10 px-2 py-1.5 font-mono text-[12px] text-error">
          {message.error.message}
        </div>
      ) : null}
    </StreamCard>
  );
}

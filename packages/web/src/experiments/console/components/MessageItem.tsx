import { Paperclip } from 'lucide-react';
import type { ReactElement } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
import { AgentAvatar } from './AgentAvatar';
import { formatClock } from '../lib/format';
import { formatBytes } from '../primitives/file';
import type { Message } from '../primitives/message';

interface MessageItemProps {
  message: Message;
  /**
   * `chat` (default) — Direction-B chat card. `log` — run-log styling
   * (design v3 .log-agent-card): violet left accent + mono body, no avatar.
   */
  variant?: 'chat' | 'log';
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

/**
 * Attachments sent with a message. Rendered only on the user bubble: the server
 * records file metadata on the user's message, so no other role carries any.
 */
const FILE_CHIPS = (files: Message['files']): ReactElement => (
  <div className="mt-[8px] flex flex-wrap justify-end gap-[6px]">
    {files.map((f, i) => (
      <span
        key={`${f.name}-${String(i)}`}
        title={`${f.name} · ${formatBytes(f.size)}`}
        className="flex items-center gap-[6px] rounded-[8px] border bg-[color:var(--surface-elevated)] px-[9px] py-[4px] text-[11.5px]"
        style={{ borderColor: 'var(--border-bright)' }}
      >
        <Paperclip aria-hidden className="h-[12px] w-[12px] text-text-tertiary" />
        <span className="max-w-[180px] truncate text-text-secondary">{f.name}</span>
        <span className="font-mono text-[10px] text-text-tertiary">{formatBytes(f.size)}</span>
      </span>
    ))}
  </div>
);

const ERROR_BLOCK = (msg: string): ReactElement => (
  <div className="mt-2 rounded border border-error/40 bg-error/10 px-2 py-1.5 font-mono text-[12px] text-error">
    {msg}
  </div>
);

/**
 * Direction-B chat row. Role-branched:
 *  - `user` → meta line + right-aligned outlined-magenta bubble (all lengths).
 *  - `assistant`/`system` → meta line + 30px gradient-ring avatar + soft
 *    surface-elevated card containing the markdown body.
 *
 * Borders use inline `style.borderColor` because the console scope has a
 * wildcard `border-color: var(--border)` rule that would repaint Tailwind's
 * border-utility colors otherwise (see `theme.css`, mirrored in
 * `StreamCard.tsx`).
 */
export function MessageItem({ message, variant = 'chat' }: MessageItemProps): ReactElement {
  const kind = message.role;
  const content = message.content.trim();
  const clock = formatClock(message.timestamp);
  const log = variant === 'log';

  if (kind === 'user') {
    return (
      <div className="flex flex-col items-end">
        <header className="mb-2 flex flex-row-reverse items-center gap-[9px] font-mono">
          <span
            className="rounded px-[7px] py-[2px] text-[10px] font-bold uppercase tracking-[0.14em]"
            style={{
              color: 'var(--brand-magenta)',
              background: 'color-mix(in oklch, var(--brand-magenta), transparent 88%)',
            }}
          >
            You
          </span>
          <time
            dateTime={message.timestamp}
            title={clock}
            className="text-[11px] tracking-[0.3px] text-text-tertiary"
          >
            {clock}
          </time>
        </header>
        <div
          className="max-w-[76%] self-end rounded-[14px_14px_4px_14px] px-[17px] py-[13px] text-[14.5px] leading-[1.5] break-words"
          style={{
            background: 'color-mix(in oklch, var(--brand-magenta), transparent 94%)',
            border: '1px solid color-mix(in oklch, var(--brand-magenta), transparent 50%)',
            color: 'color-mix(in oklch, white, var(--brand-magenta) 12%)',
            boxShadow: '0 0 0 4px color-mix(in oklch, var(--brand-magenta), transparent 95%)',
          }}
        >
          {content}
        </div>
        {message.files.length > 0 ? FILE_CHIPS(message.files) : null}
        {message.error !== null ? ERROR_BLOCK(message.error.message) : null}
      </div>
    );
  }

  const label = kind === 'system' ? 'System' : 'Agent';

  return (
    <div className="flex flex-col">
      <header className="mb-2 flex items-center gap-[9px] font-mono">
        <span
          className="rounded px-[7px] py-[2px] text-[10px] font-bold uppercase tracking-[0.14em]"
          style={{
            color: 'var(--brand-teal)',
            background: 'color-mix(in oklch, var(--brand-teal), transparent 88%)',
          }}
        >
          {label}
        </span>
        <time
          dateTime={message.timestamp}
          title={clock}
          className="text-[11px] tracking-[0.3px] text-text-tertiary"
        >
          {clock}
        </time>
      </header>
      <div className="flex max-w-full items-start gap-[13px]">
        {log ? null : (
          <div className="shrink-0">
            <AgentAvatar size={30} />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div
            className="rounded-[12px] border bg-[color:var(--surface-elevated)] px-4 py-[14px]"
            style={
              log
                ? {
                    borderColor: 'var(--border)',
                    borderLeft: '3px solid var(--brand-violet)',
                  }
                : { borderColor: 'var(--border)' }
            }
          >
            {content.length > 0 ? (
              <div
                className={
                  log
                    ? 'max-w-none font-mono text-[12px] leading-[1.7] text-text-secondary'
                    : 'max-w-none text-[14.5px] leading-[1.62] text-text-primary'
                }
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkBreaks]}
                  rehypePlugins={[rehypeHighlight]}
                  components={MD_COMPONENTS}
                >
                  {content}
                </ReactMarkdown>
              </div>
            ) : null}
            {message.error !== null ? ERROR_BLOCK(message.error.message) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

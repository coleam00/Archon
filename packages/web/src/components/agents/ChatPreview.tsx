import { useEffect, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { chatWithAgent, type AgentSource, type AgentStatus } from '@/lib/api';

interface ChatPreviewProps {
  cwd: string | undefined;
  name: string;
  source: AgentSource;
  description: string;
  status: AgentStatus;
}

interface Message {
  role: 'user' | 'agent';
  text: string;
}

export function ChatPreview({
  cwd,
  name,
  source,
  description,
}: ChatPreviewProps): React.ReactElement {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reset on agent change.
  useEffect(() => {
    setMessages([]);
    setInput('');
    setBusy(false);
  }, [name, source]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  async function send(): Promise<void> {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setMessages(m => [...m, { role: 'user', text }]);
    setBusy(true);
    try {
      const res = await chatWithAgent(name, source, text, cwd);
      setMessages(m => [...m, { role: 'agent', text: res.reply }]);
    } catch (e) {
      setMessages(m => [...m, { role: 'agent', text: `(preview error: ${(e as Error).message})` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col items-center gap-2 border-b border-bridges-border-subtle px-8 py-8 text-center">
        <div
          className="h-14 w-14 shrink-0 rounded-full bg-bridges-tag-sky-bg"
          aria-label={`${name} avatar`}
        />
        <div className="text-[18px] font-semibold text-bridges-fg1">{name}</div>
        {description && (
          <div className="max-w-md text-[12.5px] leading-relaxed text-bridges-fg2">
            {description}
          </div>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 py-6">
        {messages.length === 0 && !busy && (
          <div className="text-center text-[12.5px] text-bridges-fg3">
            Send a message to preview the agent's persona and tone.
          </div>
        )}
        {messages.map((m, i) => (
          <ChatBubble key={i} message={m} agentName={name} />
        ))}
        {busy && (
          <div className="flex items-center gap-1.5 py-3 text-bridges-fg3">
            <Dot delay={0} />
            <Dot delay={120} />
            <Dot delay={240} />
          </div>
        )}
      </div>

      <div className="border-t border-bridges-border-subtle px-8 py-4">
        <div className="flex flex-col gap-1.5 rounded-xl border border-bridges-border bg-bridges-surface px-3 py-2.5">
          <textarea
            value={input}
            onChange={e => {
              setInput(e.target.value);
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Ask follow up"
            rows={1}
            className="resize-none border-0 bg-transparent text-[13.5px] text-bridges-fg1 placeholder:text-bridges-fg-placeholder focus:outline-none"
          />
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void send()}
              disabled={busy || !input.trim()}
              className={`inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
                input.trim() && !busy
                  ? 'bg-bridges-action text-white hover:bg-bridges-action-hover'
                  : 'bg-bridges-border text-bridges-fg-placeholder'
              }`}
              aria-label="Send"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({
  message,
  agentName,
}: {
  message: Message;
  agentName: string;
}): React.ReactElement {
  if (message.role === 'user') {
    return (
      <div className="mb-4 flex justify-end">
        <div className="max-w-[75%] rounded-2xl bg-bridges-surface-muted px-3.5 py-2 text-[13.5px] leading-relaxed text-bridges-fg1">
          {message.text}
        </div>
      </div>
    );
  }
  return (
    <div className="mb-5">
      <div className="mb-1.5 flex items-center gap-2">
        <div className="h-4 w-4 rounded-full bg-bridges-tag-sky-bg" />
        <span className="text-[11.5px] font-medium text-bridges-fg1">{agentName}</span>
      </div>
      <div className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-bridges-fg1">
        {message.text}
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: number }): React.ReactElement {
  return (
    <span
      className="inline-block h-1.5 w-1.5 rounded-full bg-bridges-fg3"
      style={{
        animation: 'agent-dot 1.2s infinite ease-in-out',
        animationDelay: `${String(delay)}ms`,
      }}
    />
  );
}

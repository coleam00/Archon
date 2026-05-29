import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useParams } from 'react-router';
import { ChatStream } from '../components/ChatStream';
import { ChatComposer } from '../components/ChatComposer';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import { EmptyState } from '../components/EmptyState';
import { StreamContextProvider } from '../lib/stream-context';
import { useConversationSSE } from '../lib/sse';
import { useEntity, invalidate } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import type { Project } from '../primitives/project';
import type { Message } from '../primitives/message';
import type { ConversationSummary } from '../primitives/conversation';

/**
 * Project-scoped agent chat. A tab peer of the runs view under a project.
 *
 * MVP conversation model: one active conversation per project — the most-recent
 * web conversation, or created lazily on first send. No multi-conversation
 * sidebar yet (spike decision #3, deferred).
 *
 * Data flow mirrors RunDetailPage: load messages via useEntity(K.messages),
 * keep live via useConversationSSE (invalidate → refetch), render with the
 * shared MessageItem/ToolCallItem cards inside a StreamContextProvider.
 */
export function ChatPage(): ReactElement {
  const { projectId } = useParams<{ projectId: string }>();

  const { data: project } = useEntity<Project | null>(
    projectId !== undefined ? K.project(projectId) : 'noop:no-project',
    () => (projectId !== undefined ? skill.getProject(projectId) : Promise.resolve(null))
  );

  const { data: conversations } = useEntity<ConversationSummary[]>(
    projectId !== undefined ? K.conversations(projectId) : 'noop:no-project-convs',
    () => (projectId !== undefined ? skill.listConversations(projectId) : Promise.resolve([]))
  );

  // Active conversation: most-recent web conversation, else null until first send.
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  useEffect(() => {
    if (activeConvId !== null) return;
    const web = (conversations ?? []).find(c => c.platformType === 'web');
    if (web !== undefined) setActiveConvId(web.id);
  }, [conversations, activeConvId]);

  const { data: messages } = useEntity<Message[]>(
    activeConvId !== null ? K.messages(activeConvId) : 'noop:no-conv',
    () => (activeConvId !== null ? skill.listMessages(activeConvId) : Promise.resolve([]))
  );

  const [locked, setLocked] = useState(false);
  useConversationSSE(activeConvId, setLocked);

  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSend = (text: string): void => {
    if (projectId === undefined) return;
    setError(null);
    setSending(true);
    void (async (): Promise<void> => {
      try {
        if (activeConvId === null) {
          const conv = await skill.createConversation(projectId, text);
          setActiveConvId(conv.conversationId);
          invalidate(K.conversations(projectId));
          invalidate(K.messages(conv.conversationId));
        } else {
          await skill.sendMessage(activeConvId, text);
          invalidate(K.messages(activeConvId));
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Send failed.');
      } finally {
        setSending(false);
      }
    })();
  };

  // Inline auto-scroll: stick to bottom on new messages if already near it.
  // Mirrors RunDetailPage's variant.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    lastBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  });
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || !lastBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages?.length]);

  if (projectId === undefined) {
    return <EmptyState title="No project selected." />;
  }

  const messageList = messages ?? [];

  return (
    <section className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-6 py-4">
        <div className="flex items-baseline justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-base font-medium text-text-primary">
              {project?.name ?? 'Project'}
            </h1>
            <p className="text-xs text-text-tertiary">{project?.path ?? 'Loading…'}</p>
          </div>
        </div>
        <ProjectViewTabs projectId={projectId} active="chat" />
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {messageList.length === 0 ? (
          <EmptyState
            title="No messages yet."
            hint="Ask the agent about this project, or tell it what to run."
          />
        ) : (
          <StreamContextProvider value={{ runStartedAt: null }}>
            <ChatStream messages={messageList} />
          </StreamContextProvider>
        )}
      </div>

      {error !== null ? (
        <div className="shrink-0 border-t border-error/30 bg-error/[0.06] px-6 py-2 font-mono text-[11px] text-error">
          {error}
        </div>
      ) : null}

      <ChatComposer onSend={onSend} disabled={locked || sending} />
    </section>
  );
}

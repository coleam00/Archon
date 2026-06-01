import { Fragment, type ReactElement } from 'react';
import { MessageItem } from './MessageItem';
import { ToolCallItem } from './ToolCallItem';
import { isSystemCategory, type Message } from '../primitives/message';

interface ChatStreamProps {
  messages: Message[];
  /**
   * When false (default) the chat reads like a conversation: only user/assistant
   * prose, no raw tool-call cards, no framework/system rows. The "agent is
   * working" indicator stands in for tool activity. When true (toggled from that
   * indicator) the full trace is revealed inline.
   */
  showTools?: boolean;
}

/**
 * Message-only stream for the chat view. A pure chat has no RunEvent[] to merge
 * (unlike RunStream); each message renders as a MessageItem. Tool calls and
 * framework chatter are hidden by default to keep the chat conversational.
 *
 * Wrap in <StreamContextProvider> upstream (ChatPage) so StreamCard timestamps
 * resolve — pass runStartedAt: null for wall-clock display.
 */
export function ChatStream({ messages, showTools = false }: ChatStreamProps): ReactElement {
  const visible = showTools
    ? messages
    : messages.filter(m => !isSystemCategory(m.category) && m.content.trim().length > 0);

  return (
    <div className="flex flex-col gap-1.5">
      {visible.map(message => (
        <Fragment key={message.id}>
          <MessageItem message={message} />
          {showTools
            ? message.toolCalls.map((call, i) => (
                <ToolCallItem
                  key={`${message.id}:tool:${i.toString()}`}
                  call={call}
                  timestamp={message.timestamp}
                />
              ))
            : null}
        </Fragment>
      ))}
    </div>
  );
}

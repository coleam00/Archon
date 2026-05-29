import { Fragment, type ReactElement } from 'react';
import { MessageItem } from './MessageItem';
import { ToolCallItem } from './ToolCallItem';
import type { Message } from '../primitives/message';

interface ChatStreamProps {
  messages: Message[];
}

/**
 * Message-only stream for the chat view. A pure chat has no RunEvent[] to merge
 * (unlike RunStream), so each message renders as a MessageItem, with its inline
 * tool calls broken out into ToolCallItem cards directly after it.
 *
 * Wrap in <StreamContextProvider> upstream (ChatPage) so StreamCard timestamps
 * resolve — pass runStartedAt: null for wall-clock display.
 */
export function ChatStream({ messages }: ChatStreamProps): ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      {messages.map(message => (
        <Fragment key={message.id}>
          <MessageItem message={message} />
          {message.toolCalls.map((call, i) => (
            <ToolCallItem
              key={`${message.id}:tool:${i.toString()}`}
              call={call}
              timestamp={message.timestamp}
            />
          ))}
        </Fragment>
      ))}
    </div>
  );
}

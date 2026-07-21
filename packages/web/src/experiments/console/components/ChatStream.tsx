import { Fragment, type ReactElement } from 'react';
import { MessageItem } from './MessageItem';
import { ToolCallItem } from './ToolCallItem';
import { ConsoleWorkflowResultCard } from './ConsoleWorkflowResultCard';
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
  // `workflow_result` messages are normally swept up by `isSystemCategory` (the
  // `workflow_` prefix), but they carry the run summary + a completion card — let
  // them through explicitly. Other `workflow_*` narration stays suppressed.
  const visible = showTools
    ? messages
    : messages.filter(
        m =>
          m.category === 'workflow_result' ||
          (!isSystemCategory(m.category) && m.content.trim().length > 0)
      );

  return (
    <div className="flex flex-col gap-[14px]">
      {visible.map(message => (
        <Fragment key={message.id}>
          {message.category === 'workflow_result' && message.workflowResult !== null ? (
            <ConsoleWorkflowResultCard
              runId={message.workflowResult.runId}
              workflowName={message.workflowResult.workflowName}
              summary={message.content}
            />
          ) : (
            <MessageItem message={message} />
          )}
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

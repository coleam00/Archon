import type { ReactElement } from 'react';
import { ArrowRight, MessageCircleQuestion } from 'lucide-react';
import { AskGroup } from '../components/ask-card/AskGroup';
import type { AnsweredHold } from '../components/ask-card/useAnsweredHold';
import type { AskNaming } from '../lib/ask-naming';
import { formatDateTime } from '../lib/format';
import type { NeedsYouItem } from '../lib/needs-you';
import type { AttentionQueue } from '../skills/runs';
import { IdTag, Panel } from './document';
import type { AnsweredAsk } from './lib/item-story';

/**
 * An ask a stage left, answered, where it happened in the story (owner change 8): the question,
 * the option chosen in plain words with its id as a tag, who chose it and when, and what that
 * started ("Build started again", "Nothing started", or the view's sentence for the option).
 */
export function AnsweredAskBlock({ ask }: { ask: AnsweredAsk }): ReactElement {
  return (
    <Panel inset as="article" className="flex flex-col gap-2 p-3" aria-label="An ask you answered">
      <p className="flex items-start gap-2 text-console-14 text-text-primary">
        <MessageCircleQuestion aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
        <span className="min-w-0 break-words">{ask.question}</span>
      </p>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-console-13 text-text-secondary">
        <span>
          You said <span className="font-semibold text-text-primary">{ask.chosen}</span>
        </span>
        {ask.optionId === null ? null : <IdTag id={ask.optionId} />}
        <span className="text-text-tertiary">
          {ask.by === null ? '' : `by ${ask.by} · `}
          {formatDateTime(ask.at)}
        </span>
      </p>
      {ask.does === null ? null : (
        <p className="break-words text-console-13 text-text-secondary">{ask.does}</p>
      )}
      <p
        data-started={ask.started}
        className="flex items-center gap-1.5 text-console-13 font-medium text-text-primary"
      >
        <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-text-tertiary" />
        {ask.started}
      </p>
    </Panel>
  );
}

/** Open asks in the story: the ask card Needs you draws, answerable in place. */
export function OpenAsks({
  projectId,
  asks,
  hold,
  queue,
  naming,
}: {
  projectId: string;
  asks: readonly NeedsYouItem[];
  hold: AnsweredHold;
  queue: Pick<AttentionQueue, 'runs'>;
  naming: Pick<AskNaming, 'where' | 'starts'>;
}): ReactElement | null {
  if (asks.length === 0) return null;
  return (
    <AskGroup
      projectId={projectId}
      asks={asks}
      hold={hold}
      queue={queue}
      where={naming.where}
      starts={naming.starts}
    />
  );
}

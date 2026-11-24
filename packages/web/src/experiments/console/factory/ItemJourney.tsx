import type { ReactElement } from 'react';
import { CircleStop, Hourglass, Undo2 } from 'lucide-react';
import { Panel } from './document';
import { durationWords } from './lib/duration';
import type { Journey, JourneySegment } from './lib/item-journey';
import { cardTone, toneColor } from './tones';

/**
 * The journey strip across the item page (owner change 8): one segment per board column in its
 * colour with the time the item spent there, the column it is in now lit as the map lights a
 * card, each send-back to an earlier column as a loop with its count, each ask it waited on as
 * a pause with how long, and, for an item parked, ended or failed, where it stopped. Every mark
 * carries words, never a colour alone. On a phone the strip scrolls sideways.
 */
export function ItemJourney({ journey }: { journey: Journey }): ReactElement {
  return (
    <Panel as="section" aria-label="Journey" className="p-4 lg:col-span-2">
      <div className="overflow-x-auto">
        <ol className="flex w-full min-w-max gap-3">
          {journey.segments.map(segment => (
            <Segment key={segment.id} segment={segment} />
          ))}
        </ol>
      </div>
    </Panel>
  );
}

/** What the segment's figure says: its time, or that the item never got there. */
function figureWords(segment: JourneySegment): string {
  if (!segment.reached) return 'Not reached';
  if (segment.tone === 'merged') return segment.lit ? 'Merged' : durationWords(segment.ms);
  return durationWords(segment.ms);
}

function Segment({ segment }: { segment: JourneySegment }): ReactElement {
  return (
    <li
      data-journey-segment={segment.id}
      data-lit={segment.lit ? '' : undefined}
      data-static=""
      style={cardTone(toneColor(segment.tone))}
      className={`factory-card relative flex min-w-40 flex-1 flex-col gap-1.5 overflow-hidden rounded-console-12 border bg-surface-inset px-3 pb-3 pt-4 ${
        segment.reached ? '' : 'opacity-60'
      }`}
    >
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-0.75"
        style={{ backgroundColor: segment.reached ? toneColor(segment.tone) : 'var(--border)' }}
      />
      <span className="text-console-12 font-medium uppercase tracking-console-label text-text-tertiary">
        {segment.label}
      </span>
      <span
        className={`text-console-17 font-semibold tabular-nums ${segment.reached ? 'text-text-primary' : 'text-text-tertiary'}`}
      >
        {figureWords(segment)}
      </span>
      {segment.lit ? (
        <span className="text-console-12 text-text-secondary">It is here now</span>
      ) : null}
      {segment.stopped === null ? null : (
        <span className="flex items-center gap-1.5 text-console-12 font-medium text-text-secondary">
          <CircleStop aria-hidden="true" className="size-4 shrink-0" />
          Stopped here: {segment.stopped}
        </span>
      )}
      {segment.loops.map(loop => (
        <span
          key={loop.to}
          data-journey-loop={loop.count}
          className="flex items-center gap-1.5 rounded-full border border-dashed border-[color:var(--node-approval)] px-2 py-0.5 text-console-12 text-[color:var(--node-approval)]"
        >
          <Undo2 aria-hidden="true" className="size-3.5 shrink-0" />
          sent back {loop.count}x to {loop.to}
        </span>
      ))}
      {segment.pauses.map((pause, index) => (
        <span
          // Pauses carry no id; their order is the answers' and stable.
          key={index}
          data-journey-pause={pause.open ? 'open' : 'answered'}
          className={`flex items-center gap-1.5 text-console-12 ${pause.open ? 'text-warning' : 'text-text-tertiary'}`}
        >
          <Hourglass aria-hidden="true" className="size-3.5 shrink-0" />
          {pause.open ? 'waiting on you' : 'waited on you'} {durationWords(pause.ms)}
        </span>
      ))}
    </li>
  );
}

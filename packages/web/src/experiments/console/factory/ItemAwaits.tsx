import type { ReactElement } from 'react';
import { Hourglass } from 'lucide-react';
import type { FactoryItem } from '../skills/factory';
import { Panel, SectionHeading } from './document';

export type Awaits = NonNullable<NonNullable<FactoryItem['progress']>['awaits']>;

/**
 * What an item waiting on a person with no ask open waits on (a declared `awaits` outcome): the
 * reason its run gave, what to do to move it on (the view's `next`, since nothing here is
 * answered in place), then the questions to settle, each on its own line. The item page's panel
 * and Needs you's both draw it.
 */
export function AwaitsBody({ awaits }: { awaits: Awaits }): ReactElement {
  return (
    <div className="flex flex-col gap-3">
      {awaits.why === null ? null : (
        <p className="max-w-3xl text-console-14 text-text-secondary">{awaits.why}</p>
      )}
      {awaits.next === null ? null : (
        <p data-awaits-next="" className="max-w-3xl text-console-14 text-text-primary">
          <span className="mr-2 text-console-12 font-medium uppercase tracking-console-label text-warning">
            What to do
          </span>{' '}
          {awaits.next}
        </p>
      )}
      {awaits.questions.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <h4 className="text-console-12 font-medium uppercase tracking-console-label text-text-tertiary">
            Questions to settle
          </h4>
          <ul data-awaits-questions="" className="flex flex-col gap-2">
            {awaits.questions.map(question => (
              <li
                key={question}
                className="rounded-console-12 bg-surface-inset px-3 py-2 text-console-14 text-text-primary"
              >
                {question}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The item page's panel for an item waiting on you with no ask open, at the top of its story:
 * the needs-you colour as its left bar and eyebrow, never the ping, which only an open ask has
 * (Visual standard, rules 5 and 7); its heading the declared label ("Needs shaping").
 */
export function ItemAwaitsPanel({ awaits }: { awaits: Awaits }): ReactElement {
  return (
    <Panel
      as="section"
      tone="var(--warning)"
      bar="left"
      aria-labelledby="story-awaits"
      data-awaits=""
      className="flex flex-col gap-3 py-4 pl-6 pr-5"
    >
      <SectionHeading
        id="story-awaits"
        icon={Hourglass}
        eyebrow="Waiting on you"
        title={awaits.label}
        tone="var(--warning)"
      />
      <AwaitsBody awaits={awaits} />
    </Panel>
  );
}

import type { ReactElement } from 'react';
import { displayKeyOf } from './lib/work-orders';
import { Link } from 'react-router';
import { RunningDot } from '../components/LiveDot';
import type { ItemOnStep } from './lib/items-on-step';
import { readFailure } from './lib/read-failure';
import { ReadFailure } from './ReadFailure';
import { roundOfStep, stepLabel } from './lib/step-label';
import { factoryPath, type FactoryViewListed } from './lib/views';

/**
 * The items a run works now, each linking to its item page, with the step it is on. The dot
 * is still: the items read says a run is running, not that its owner still answers.
 */
export function RunningItemLinks({
  view,
  projectId,
  items,
}: {
  view: FactoryViewListed['declaration'];
  projectId: string;
  items: readonly ItemOnStep[];
}): ReactElement {
  return (
    <ul className="flex flex-col gap-1">
      {items.map(({ item, running }) => (
        // The title wraps beside the key on a narrow screen rather than under it.
        <li key={item.item.id} className="flex items-start gap-2 text-console-12 leading-4">
          <span className="mt-1 flex">
            <RunningDot live={false} />
          </span>
          <Link
            to={factoryPath(projectId, `/items/${encodeURIComponent(item.item.key)}`)}
            className="shrink-0 font-mono text-accent-bright hover:underline"
          >
            {displayKeyOf(item)}
          </Link>
          <span className="min-w-0">
            {item.progress?.title == null ? null : (
              <span className="mr-2 text-text-primary">{item.progress.title}</span>
            )}
            <span className="whitespace-nowrap text-text-tertiary">
              {running.step === null ? (
                'between steps'
              ) : (
                <span title={running.step}>
                  on{' '}
                  {stepLabel(
                    view,
                    running.workflow,
                    running.step,
                    roundOfStep(
                      view,
                      running.workflow,
                      running.step,
                      item.progress?.round,
                      running.runId
                    )
                  )}
                </span>
              )}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A failed items read, said where the running items would show. */
export function RunningItemsFailure({
  error,
  retry,
}: {
  error: Error;
  /** Reads the items again. */
  retry: () => void;
}): ReactElement {
  return (
    <ReadFailure retry={retry}>
      Could not load which items are running: {readFailure(error)}
    </ReadFailure>
  );
}

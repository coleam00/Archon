/**
 * Everything that waits on the operator across the install's projects: paused runs that need
 * input and the asks completed runs left on items. It is the runs page's pending-input list
 * on a page of its own, drawn by the same component and answered the same way.
 */
import type { ReactElement } from 'react';
import { EmptyState } from '../components/EmptyState';
import { PendingInputList } from '../components/PendingInputBanner';
import { usePendingInput } from '../lib/pending-input';
import { ALL_SCOPE } from '../store/keys';

export function NeedsYouPage(): ReactElement {
  const pending = usePendingInput([], ALL_SCOPE);
  const count = pending.visible.length + pending.ownerLost.length + pending.itemAsks.asks.length;
  const shown = count + pending.itemAsks.answered.length;
  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border px-4 py-4 md:px-6">
        <h1 className="text-base font-medium text-text-primary">Needs you</h1>
        <p role="status" className="text-xs text-text-tertiary">
          {pending.error !== undefined
            ? pending.error.message
            : `${String(count)} waiting, across every project`}
        </p>
      </header>
      <div
        data-needs-you
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-8 pt-4 md:px-6"
      >
        {shown === 0 && pending.error === undefined ? (
          <EmptyState title="Nothing needs you." />
        ) : (
          <PendingInputList
            runs={pending.visible}
            ownerLost={pending.ownerLost}
            showProject
            onDismiss={pending.dismiss}
            itemAsks={pending.itemAsks}
          />
        )}
      </div>
    </section>
  );
}

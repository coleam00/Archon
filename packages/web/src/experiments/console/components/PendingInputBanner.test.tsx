import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { NO_ITEM_ASKS } from './ItemAsksSection';
import { PendingInputBanner } from './PendingInputBanner';

test('the attention banner shows a run holding its item after its owner is gone, with resume and abandon', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <PendingInputBanner
        runs={[]}
        ownerLost={[
          {
            runId: 'holder-1',
            workflow: 'build',
            projectId: 'cb-1',
            projectName: 'demo',
            itemKey: 'issue-1',
            observedStatus: 'running',
            start: null,
            dueWithoutWaker: false,
          },
        ]}
        showProject={false}
        onDismiss={() => undefined}
        itemAsks={NO_ITEM_ASKS}
      />
    </MemoryRouter>
  );
  expect(html).toContain('data-owner-lost-run-id="holder-1"');
  expect(html).toContain('issue-1');
  expect(html).toContain('>Resume<');
  expect(html).toContain('>Abandon<');
});

test('a pending start no process runs names its start command and offers abandon, not resume', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <PendingInputBanner
        runs={[]}
        ownerLost={[
          {
            runId: 'start-1',
            workflow: 'build',
            projectId: null,
            projectName: null,
            itemKey: null,
            observedStatus: 'pending',
            start: { requestId: 'start-1', hostId: 'h1' },
            dueWithoutWaker: false,
          },
        ]}
        showProject={false}
        onDismiss={() => undefined}
        itemAsks={NO_ITEM_ASKS}
      />
    </MemoryRouter>
  );
  expect(html).toContain('archon trigger execute start-1 --host h1');
  expect(html).not.toContain('>Resume<');
  expect(html).toContain('>Abandon<');
});

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
          },
        ]}
        showProject={false}
        onDismiss={() => undefined}
        itemAsks={NO_ITEM_ASKS}
      />
    </MemoryRouter>
  );
  expect(html).toContain('data-owner-lost-run-id="holder-1"');
  expect(html).toContain('<span class="font-mono">#1</span>');
  expect(html).toContain('>Resume<');
  expect(html).toContain('>Abandon<');
});

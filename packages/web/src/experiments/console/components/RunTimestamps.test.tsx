import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { ensureUtc } from '../lib/format';
import { toRun } from '../primitives/run';
import { detailFixture } from '../primitives/run.test-fixtures';
import { ActiveRunCard } from './ActiveRunCard';
import { RecentRunRow } from './RecentRunRow';
import { RunDetailHeader } from './RunDetailHeader';
import { RunStartedLine } from './RunLifecycle';

const originalTimezone = process.env.TZ;
const now = Date.UTC(2026, 5, 14, 0, 22, 53);
let clock: ReturnType<typeof spyOn<typeof Date, 'now'>>;

beforeEach(() => {
  process.env.TZ = 'Pacific/Kiritimati';
  clock = spyOn(Date, 'now').mockReturnValue(now);
});

afterEach(() => {
  clock.mockRestore();
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

const starts = [
  { started: '2026-06-13 23:22:53', day: 'Jun 14', relative: '1h ago' },
  { started: '2026-06-12T23:22:53Z', day: 'Jun 13', relative: '1d ago' },
  { started: '2026-06-06T18:22:53-05:00', day: 'Jun 7', relative: '7d ago' },
];

for (const { started, day, relative } of starts) {
  test(`run surfaces show the local start date for ${day}`, () => {
    const run = toRun({
      ...detailFixture.run,
      started_at: started,
      completed_at: new Date(new Date(ensureUtc(started)).getTime() + 252000).toISOString(),
    });
    for (const row of [
      <RecentRunRow run={run} />,
      <ActiveRunCard run={{ ...run, status: 'running', finishedAt: null }} />,
    ]) {
      const html = renderToStaticMarkup(<MemoryRouter>{row}</MemoryRouter>);
      expect(html).toContain(relative);
      expect(html).toMatch(/title="Started [^"]*2026[^"]*13:22:53/);
      expect(html).toContain(day);
    }
    const row = renderToStaticMarkup(
      <MemoryRouter>
        <RecentRunRow run={run} />
      </MemoryRouter>
    );
    expect(row).toContain('04:12');

    for (const surface of [
      <RunDetailHeader run={run} projectName="Archon" projectId={undefined} />,
      <RunStartedLine run={run} />,
    ]) {
      const html = renderToStaticMarkup(<MemoryRouter>{surface}</MemoryRouter>);
      expect(html).toContain(day);
      expect(html).toContain('2026');
      expect(html).toContain('13:22:53');
    }
  });
}

test.each(['completed', 'failed', 'cancelled'] as const)(
  'the header shows start, finish and duration for %s runs',
  status => {
    const run = toRun({
      ...detailFixture.run,
      status,
      started_at: '2026-06-13 23:22:53',
      completed_at: '2026-06-14 23:27:05',
    });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <RunDetailHeader run={run} projectName="Archon" projectId={undefined} />
      </MemoryRouter>
    );
    expect(html).toMatch(/Started[^<]*<time[^>]*>Jun 14, 2026\D+13:22:53/);
    expect(html).toMatch(/Finished[^<]*<time[^>]*>Jun 15, 2026\D+13:27:05/);
    expect(html).toContain('24:04:12');
  }
);

test.each(['running', 'paused'] as const)('the header omits finish time for %s runs', status => {
  const run = toRun({
    ...detailFixture.run,
    status,
    started_at: '2026-06-13 23:22:53',
    completed_at: null,
  });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RunDetailHeader run={run} projectName="Archon" projectId={undefined} />
    </MemoryRouter>
  );
  expect(html).toContain('Started');
  expect(html).toContain('13:22:53');
  expect(html).not.toContain('Finished');
  expect(html).toContain('01:00:00');
});

import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { collectFindings, defaultRoots, formatReport, tallyLenses } from './lens-yield';

const trackTempRoot = trackTempRoots();

/** Write one run's `review/findings.json` under an artifacts root, as a real run does. */
function writeRun(artifacts: string, runId: string, body: string): void {
  const dir = join(artifacts, 'runs', runId, 'review');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'findings.json'), body);
}

function artifactsRoot(): string {
  return trackTempRoot(mkdtempSync(join(tmpdir(), 'lens-yield-')));
}

test('tallies lens attribution across runs', async () => {
  const root = artifactsRoot();
  writeRun(
    root,
    'run-1',
    JSON.stringify([
      { id: 'R1', severity: 'Important', sources: ['code', 'seams'], claim: 'a', status: 'open' },
      { id: 'R2', severity: 'Suggestion', sources: ['tests'], claim: 'b', status: 'open' },
    ])
  );
  writeRun(
    root,
    'run-2',
    JSON.stringify([
      { id: 'R1', severity: 'Critical', sources: ['seams'], claim: 'c', status: 'fixed' },
      { id: 'R2', severity: 'Important', sources: ['docs'], claim: 'd', status: 'disproved' },
      { id: 'R3', severity: 'Important', sources: ['errors'], claim: 'e', status: 'declined' },
    ])
  );

  const { files, unreadable } = await collectFindings([root]);
  expect(files).toHaveLength(2);
  expect(unreadable).toEqual([]);

  const tallies = tallyLenses(files);
  expect(tallies.find(t => t.lens === 'seams')).toEqual({
    lens: 'seams',
    findings: 2,
    sole: 1,
    blocking: 2,
    disproved: 0,
  });
  // The measure that retires a lens: sourced a finding, never on its own.
  expect(tallies.find(t => t.lens === 'code')).toMatchObject({ findings: 1, sole: 0 });
  // A disproved finding is yield the lens does not get credit for.
  expect(tallies.find(t => t.lens === 'docs')).toMatchObject({
    findings: 1,
    blocking: 0,
    disproved: 1,
  });
  // So is one the owner declined with a reason synthesis accepted.
  expect(tallies.find(t => t.lens === 'errors')).toMatchObject({ blocking: 0, disproved: 1 });
  expect(formatReport(files, tallies, unreadable)).toContain('2 review(s), 5 finding(s)');
});

test('reports an unreadable findings file instead of dropping it', async () => {
  const root = artifactsRoot();
  writeRun(root, 'run-1', '[{"id":"R1","severity":"Important","sources":["code"],"claim":"a"}]');
  writeRun(root, 'run-2', '{"id":"R1"}');
  writeRun(root, 'run-3', '[{"id":"R1","severity":"Important","claim":"no sources"}]');

  const { files, unreadable } = await collectFindings([root]);
  expect(files).toHaveLength(1);
  // Ordered by path, which `collectFindings` guarantees by sorting each root's matches —
  // do not relax this to an order-insensitive check: unsorted output was a Windows-only
  // failure, and the ordering is the operator-facing behavior it was hiding.
  expect(unreadable.map(entry => entry.reason)).toEqual([
    'expected a JSON array of finding records',
    "record 0 has no 'sources' string array",
  ]);
  expect(formatReport(files, tallyLenses(files), unreadable)).toContain('could not be read');
});

test('derives one artifacts root per project that has one', async () => {
  const workspaces = trackTempRoot(mkdtempSync(join(tmpdir(), 'lens-yield-ws-')));
  mkdirSync(join(workspaces, 'coleam00', 'Archon', 'artifacts'), { recursive: true });
  mkdirSync(join(workspaces, '_folder', 'notes', 'artifacts'), { recursive: true });
  // A project that never ran anything: no artifacts directory, and scanning it threw.
  mkdirSync(join(workspaces, 'coleam00', 'never-run', 'source'), { recursive: true });

  // Not re-sorted here: the sort is the function's job, so readdir order cannot leak out.
  expect(await defaultRoots(workspaces)).toEqual([
    join(workspaces, '_folder', 'notes', 'artifacts'),
    join(workspaces, 'coleam00', 'Archon', 'artifacts'),
  ]);
});

test('reports a root that does not exist rather than counting it as clean', async () => {
  const missing = join(tmpdir(), 'lens-yield-missing-root');
  const { files, unreadable } = await collectFindings([missing]);
  expect(files).toEqual([]);
  expect(unreadable).toEqual([{ path: missing, reason: 'no such directory' }]);
});

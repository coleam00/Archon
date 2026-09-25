import { describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { writeNodeArtifactsListing } from '../packages/workflows/src/artifacts-index';
import { caveats } from '../.archon/workflows/sdlc/.shared/report';

/**
 * The SDLC pack's terminal-report module, tested where the pack lives in this
 * repository. The listing these tests pass in is produced by the engine's own
 * writer, so the JSON contract the pack consumes cannot drift from the contract
 * the engine emits without one of these failing.
 */
const track = trackTempRoots();

function artifactsDir(): string {
  const dir = track(join(tmpdir(), `sdlc-report-${Math.random().toString(36).slice(2)}`));
  mkdirSync(join(dir, 'nodes'), { recursive: true });
  return dir;
}

/** A gate's typed artifact as the engine writes it: the result under nodes/ and its sidecar. */
function gate(
  dir: string,
  stem: string,
  producedAt: string,
  result: Record<string, unknown> | string
): void {
  writeFileSync(
    join(dir, 'nodes', `${stem}.md`),
    typeof result === 'string' ? result : JSON.stringify(result)
  );
  writeFileSync(
    join(dir, 'nodes', `${stem}.meta.json`),
    JSON.stringify({
      nodeId: stem,
      outputType: 'green-gate',
      path: `nodes/${stem}.md`,
      runId: 'run',
      producedAt,
      size: 1,
    })
  );
}

/** The report as a tail composes it: with the engine listing this node received. */
async function report(dir: string, failed: boolean): Promise<string> {
  const listingFile = await writeNodeArtifactsListing(dir, 'run');
  return caveats(dir, { failed, listingFile });
}

describe("the terminal report reads passed reds from the gates' typed artifacts", () => {
  it('lists every gate that passed red, in the order the gates ran', async () => {
    const dir = artifactsDir();
    gate(dir, 'zz-gate-validated', '2026-09-10T10:00:00.000Z', {
      gate: 'green',
      red_cause: 'inherited',
      stage: 'The project gate',
      summary: 'e2e-smoke was red at the starting commit',
    });
    gate(dir, 'aa-gate-green', '2026-09-10T09:00:00.000Z', {
      gate: 'green',
      red_cause: 'environment',
      stage: 'The implementation',
      summary: 'the database was held by a parallel run',
    });
    gate(dir, 'gate-correction-green', '2026-09-10T09:30:00.000Z', {
      gate: 'green',
      red_cause: '',
      stage: 'The correction',
      summary: '',
    });

    const text = await report(dir, false);
    expect(text).toContain('Delivered on red (2)');
    expect(text.indexOf('The implementation: environment red')).toBeLessThan(
      text.indexOf('The project gate: inherited red')
    );
    expect(text).toContain('the database was held by a parallel run');
    expect(text).not.toContain('The correction');
  });

  it('says nothing when no gate passed red, and nothing when no gate ran', async () => {
    const dir = artifactsDir();
    expect(await report(dir, false)).toBe('');
    gate(dir, 'gate-green', '2026-09-10T09:00:00.000Z', {
      gate: 'green',
      red_cause: '',
      stage: 'The implementation',
      summary: '',
    });
    expect(await report(dir, false)).toBe('');
  });

  it('names a gate record it cannot read instead of dropping it', async () => {
    const dir = artifactsDir();
    gate(dir, 'gate-green', '2026-09-10T09:00:00.000Z', 'not json');
    const text = await report(dir, false);
    expect(text).toContain("could not read the gate's record");
    expect(text).toContain(join(dir, 'nodes', 'gate-green.md'));
  });

  it('shows a corrupt sidecar the engine could not read alongside a red gate', async () => {
    const dir = artifactsDir();
    gate(dir, 'gate-red', '2026-09-10T09:00:00.000Z', {
      gate: 'green',
      red_cause: 'inherited',
      stage: 'The project gate',
      summary: '',
    });
    writeFileSync(join(dir, 'nodes', 'gate-green.md'), JSON.stringify({ gate: 'green' }));
    writeFileSync(join(dir, 'nodes', 'gate-green.meta.json'), 'not json');

    const text = await report(dir, false);
    expect(text).toContain('Delivered on red (1)');
    expect(text).toContain('The project gate: inherited red');
    expect(text).toContain('nodes/gate-green.meta.json');
    expect(text).toContain('invalid_metadata');
  });

  it('names a missing or unreadable listing instead of reading as no gates', async () => {
    const dir = artifactsDir();
    gate(dir, 'gate-red', '2026-09-10T09:00:00.000Z', {
      gate: 'green',
      red_cause: 'inherited',
      stage: 'The project gate',
      summary: '',
    });
    expect(caveats(dir, { failed: false, listingFile: undefined })).toContain(
      'could not be verified'
    );
    expect(caveats(dir, { failed: false, listingFile: join(dir, 'nope.json') })).toContain(
      'could not be verified'
    );
  });

  it('names a shape-invalid listing instead of reading as no gates', () => {
    const dir = artifactsDir();
    gate(dir, 'gate-red', '2026-09-10T09:00:00.000Z', {
      gate: 'green',
      red_cause: 'inherited',
      stage: 'The project gate',
      summary: '',
    });

    const malformedEnvelopes: Record<string, unknown>[] = [
      { runId: 'run', artifactsByType: 'corrupt', errors: [] },
      { runId: 'run', artifactsByType: [], errors: [] },
      { runId: 'run', artifactsByType: { 'green-gate': 'corrupt' }, errors: [] },
      { runId: 'run', artifactsByType: { 'green-gate': ['corrupt'] }, errors: [] },
    ];
    malformedEnvelopes.forEach((envelope, index) => {
      const listingFile = join(dir, `malformed-${String(index)}.json`);
      writeFileSync(listingFile, JSON.stringify(envelope));
      const text = caveats(dir, { failed: false, listingFile });
      expect(text).toContain('could not be verified');
      expect(text).toContain('malformed');
    });

    const badErrors = join(dir, 'bad-errors.json');
    writeFileSync(
      badErrors,
      JSON.stringify({ runId: 'run', artifactsByType: { 'green-gate': [] }, errors: 'also' })
    );
    expect(caveats(dir, { failed: false, listingFile: badErrors })).toContain(
      '`errors` value is not an array'
    );
  });

  it('ignores typed artifacts of other kinds', async () => {
    const dir = artifactsDir();
    writeFileSync(join(dir, 'nodes', 'triage.md'), 'a report');
    writeFileSync(
      join(dir, 'nodes', 'triage.meta.json'),
      JSON.stringify({
        nodeId: 'triage',
        outputType: 'work-triage',
        path: 'nodes/triage.md',
        runId: 'run',
        producedAt: '2026-09-10T09:00:00.000Z',
        size: 8,
      })
    );
    expect(await report(dir, false)).toBe('');
  });
});

describe('discoveries', () => {
  it('reports a consolidated file that is not an array with its path', async () => {
    const dir = artifactsDir();
    writeFileSync(join(dir, 'discoveries.json'), '{}');
    const text = await report(dir, false);
    expect(text).toContain('is not a JSON array of records');
    expect(text).toContain(join(dir, 'discoveries.json'));
  });

  it('on a failed run, reports raw producer sidecars and names a malformed one', async () => {
    const dir = artifactsDir();
    mkdirSync(join(dir, 'discoveries'));
    writeFileSync(
      join(dir, 'discoveries', 'code.json'),
      JSON.stringify([{ title: 'Unused export', relation: 'adjacent', claim: 'dead code' }])
    );
    writeFileSync(join(dir, 'discoveries', 'seams.json'), '{"title":"not a list"}');
    const text = await report(dir, true);
    expect(text).toContain('Unconsolidated discoveries (1)');
    expect(text).toContain('- Unused export [adjacent]');
    expect(text).toContain('seams.json: not a JSON array of records');
  });
});

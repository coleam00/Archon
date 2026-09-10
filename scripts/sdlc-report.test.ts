import { describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { caveats } from '../.archon/workflows/sdlc/.shared/report';

/**
 * The SDLC pack's terminal-report module, tested where the pack lives in this
 * repository. A dry run never writes typed artifacts, so no fixture reaches the
 * directory scan below; this is the only place its behaviour is proved.
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

describe("the terminal report reads passed reds from the gates' typed artifacts", () => {
  it('lists every gate that passed red, in the order the gates ran', () => {
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

    const text = caveats(dir, { failed: false });
    expect(text).toContain('Delivered on red (2)');
    expect(text.indexOf('The implementation: environment red')).toBeLessThan(
      text.indexOf('The project gate: inherited red')
    );
    expect(text).toContain('the database was held by a parallel run');
    expect(text).not.toContain('The correction');
  });

  it('says nothing when no gate passed red, and nothing when no gate ran', () => {
    const dir = artifactsDir();
    expect(caveats(dir, { failed: false })).toBe('');
    gate(dir, 'gate-green', '2026-09-10T09:00:00.000Z', {
      gate: 'green',
      red_cause: '',
      stage: 'The implementation',
      summary: '',
    });
    expect(caveats(dir, { failed: false })).toBe('');
  });

  it('names a gate record it cannot read instead of dropping it', () => {
    const dir = artifactsDir();
    gate(dir, 'gate-green', '2026-09-10T09:00:00.000Z', 'not json');
    const text = caveats(dir, { failed: false });
    expect(text).toContain("could not read the gate's record");
    expect(text).toContain(join(dir, 'nodes', 'gate-green.md'));
  });

  it('ignores typed artifacts of other kinds', () => {
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
    expect(caveats(dir, { failed: false })).toBe('');
  });
});

describe('discoveries', () => {
  it('reports a consolidated file that is not an array with its path', () => {
    const dir = artifactsDir();
    writeFileSync(join(dir, 'discoveries.json'), '{}');
    const text = caveats(dir, { failed: false });
    expect(text).toContain('is not a JSON array of records');
    expect(text).toContain(join(dir, 'discoveries.json'));
  });

  it('on a failed run, reports raw producer sidecars and names a malformed one', () => {
    const dir = artifactsDir();
    mkdirSync(join(dir, 'discoveries'));
    writeFileSync(
      join(dir, 'discoveries', 'code.json'),
      JSON.stringify([{ title: 'Unused export', relation: 'adjacent', claim: 'dead code' }])
    );
    writeFileSync(join(dir, 'discoveries', 'seams.json'), '{"title":"not a list"}');
    const text = caveats(dir, { failed: true });
    expect(text).toContain('Unconsolidated discoveries (1)');
    expect(text).toContain('- Unused export [adjacent]');
    expect(text).toContain('seams.json: not a JSON array of records');
  });
});

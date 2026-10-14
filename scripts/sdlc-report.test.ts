import { describe, expect, it } from 'bun:test';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { writeNodeArtifactsListing } from '../packages/workflows/src/artifacts-index';
import { caveats, failed } from '../.archon/workflows/sdlc/.shared/report';

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

/** A typed artifact as the engine writes it: the result under nodes/ and its sidecar. */
function typed(
  dir: string,
  stem: string,
  outputType: string,
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
      outputType,
      path: `nodes/${stem}.md`,
      runId: 'run',
      producedAt,
      size: 1,
    })
  );
}

/** The report as a tail composes it: with the engine listing this node received. */
async function report(dir: string): Promise<string> {
  const listingFile = await writeNodeArtifactsListing(dir, 'run');
  return caveats(dir, { listingFile });
}

describe('discoveries', () => {
  const record = (title: string) => ({
    title,
    claim: `${title} is real`,
    evidence: ['a.ts:1'],
    relation: 'unrelated',
    source_nodes: ['seams'],
  });

  it('adds raw records written after the last review, and never ones it consolidated', async () => {
    const dir = artifactsDir();
    mkdirSync(join(dir, 'discoveries'));
    writeFileSync(
      join(dir, 'discoveries', 'review-code.json'),
      JSON.stringify([record('Seen by review')])
    );
    utimesSync(join(dir, 'discoveries', 'review-code.json'), 1, 1);
    typed(dir, 'review__publish', 'review-report', '2026-09-10T09:00:00.000Z', {
      discoveries: [record('Stale mock type')],
    });
    utimesSync(join(dir, 'nodes', 'review__publish.md'), 2, 2);
    writeFileSync(
      join(dir, 'discoveries', 'review-simplify.json'),
      JSON.stringify([record('Found after review')])
    );
    const text = await report(dir);
    expect(text).toContain('- Stale mock type [unrelated]');
    expect(text).toContain('- Found after review [unreviewed]');
    expect(text).not.toContain('Seen by review');
    expect(text).toContain('If you are an agent reading this');
  });

  it('relays every raw record when no review ran', async () => {
    const dir = artifactsDir();
    mkdirSync(join(dir, 'discoveries'));
    writeFileSync(
      join(dir, 'discoveries', 'plan.json'),
      JSON.stringify([record('Planner found it')])
    );
    expect(await report(dir)).toContain('- Planner found it [unreviewed]');
  });

  it("lists the latest verdict's discoveries with the relay", async () => {
    const dir = artifactsDir();
    typed(dir, 'review__publish', 'review-report', '2026-09-10T09:00:00.000Z', {
      discoveries: [record('Old')],
    });
    typed(dir, 'recheck__publish', 'review-report', '2026-09-10T10:00:00.000Z', {
      discoveries: [record('Flaky timeout')],
    });
    const text = await report(dir);
    expect(text).toContain('- Flaky timeout [unrelated]');
    expect(text).not.toContain('- Old');
    expect(text).toContain('If you are an agent reading this');
  });

  it('says nothing when the final verdict recorded no discoveries', async () => {
    const dir = artifactsDir();
    typed(dir, 'review__publish', 'review-report', '2026-09-10T09:00:00.000Z', {
      discoveries: [],
    });
    expect(await report(dir)).toBe('');
  });

  it('names a missing listing instead of reading as no discoveries', () => {
    const dir = artifactsDir();
    expect(caveats(dir, { listingFile: undefined })).toContain('Discoveries could not be listed');
  });
});

describe('failed', () => {
  it('claims no result and still relays the discoveries the run recorded', async () => {
    const dir = artifactsDir();
    mkdirSync(join(dir, 'discoveries'));
    writeFileSync(
      join(dir, 'discoveries', 'implement.json'),
      JSON.stringify([{ title: 'Guard refuses an empty diff', relation: 'note' }])
    );
    const listingFile = await writeNodeArtifactsListing(dir, 'run');
    const text = failed(dir, { listingFile });
    expect(text.startsWith('Not done:')).toBe(true);
    expect(text).toContain('- Guard refuses an empty diff [unreviewed]');
    expect(text).not.toContain('Ready');
  });
});

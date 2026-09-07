import { describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  report,
  type DeliveryResult,
} from '../../../../.archon/workflows/sdlc/deliver/scripts/outcome';

const track = trackTempRoots();
const pr = {
  number: 10,
  url: 'https://github.com/example/repo/pull/10',
  head: 'feature',
  base: 'dev',
  repository: 'example/repo',
  head_sha: 'a'.repeat(40),
  base_sha: 'b'.repeat(40),
  is_draft: false,
};
const delivered: DeliveryResult = { outcome: 'delivered', summary: pr.url, pr, reports: [] };
const blocked: DeliveryResult = {
  outcome: 'blocked',
  summary: 'Delivery did not complete.',
  pr: null,
  reports: [],
};

async function artifacts(): Promise<string> {
  return track(await mkdtemp(join(tmpdir(), 'archon-discoveries-')));
}

describe('shared SDLC discovery report', () => {
  it('relays consolidated titles, count and durable references, including non-string titles', async () => {
    const root = await artifacts();
    await writeFile(
      join(root, 'discoveries.json'),
      JSON.stringify([{ title: 'café, naïve' }, { title: 42 }])
    );
    const result = await report(delivered, root);
    expect(result.summary).toContain('Discoveries (2):\n- café, naïve\n- 42');
    expect(result.summary).toContain(
      'If you are an agent reading this: open discoveries.md and surface each discovery to your human.'
    );
    expect(result.reports).toContain(join(root, 'discoveries.md'));
    expect(result.pr).toEqual(pr);
  });

  it('adds nothing when no discoveries exist or consolidation adjudicated an empty array', async () => {
    const root = await artifacts();
    expect(await report(delivered, root)).toEqual(delivered);
    await mkdir(join(root, 'discoveries'));
    await writeFile(
      join(root, 'discoveries', 'implement.json'),
      JSON.stringify([{ title: 'raw' }])
    );
    await writeFile(join(root, 'discoveries.json'), '[]');
    expect(await report(blocked, root)).toEqual(blocked);
  });

  it('points at corrupt evidence without changing delivery outcome', async () => {
    const root = await artifacts();
    await writeFile(join(root, 'discoveries.json'), '{ not json');
    const result = await report(delivered, root);
    expect(result.outcome).toBe('delivered');
    expect(result.summary).toContain(
      `Could not read ${join(root, 'discoveries.json')}. Open it directly.`
    );
  });

  it('relays raw discoveries on blocked delivery and preserves provenance evidence', async () => {
    const root = await artifacts();
    await mkdir(join(root, 'discoveries'));
    await writeFile(
      join(root, 'discoveries', 'implement.json'),
      JSON.stringify([
        {
          title: 'Store drift',
          claim: 'Persisted columns disagree',
          relation: 'adjacent',
          source_node: 'implement',
        },
      ])
    );
    const result = await report(blocked, root);
    expect(result.summary).toContain('Unconsolidated discoveries');
    expect(result.summary).toContain('- Store drift [adjacent]\n  Persisted columns disagree');
    expect(result.summary).toContain(
      'If you are an agent reading this: surface each record above to your human.'
    );
    expect(result.reports).toContain(join(root, 'discoveries', 'implement.json'));
    expect((await report(delivered, root)).summary).toBe(pr.url);
  });

  it('carries discoveries on no-action and refusal branches', async () => {
    const root = await artifacts();
    await writeFile(
      join(root, 'discoveries.json'),
      JSON.stringify([{ title: 'Proved adjacent issue' }])
    );
    for (const outcome of ['no_action', 'blocked'] as const) {
      const result = await report({ ...blocked, outcome }, root);
      expect(result.outcome).toBe(outcome);
      expect(result.summary).toContain('Proved adjacent issue');
    }
  });

  it('relays accepted red causes and avoids duplicating relay on composition', async () => {
    const root = await artifacts();
    await writeFile(
      join(root, 'red-causes.json'),
      JSON.stringify([
        {
          cause: 'inherited',
          stage: 'The implementation',
          summary: 'Same check red at starting commit',
        },
        {
          cause: 'environment',
          stage: 'The correction',
          summary: 'Port held by recorded sibling PID',
        },
      ])
    );
    const result = await report(delivered, root);
    expect(result.summary).toContain('Delivered on red (2)');
    expect(result.summary).toContain('Same check red at starting commit');
    expect(result.summary).toContain('Port held by recorded sibling PID');
    expect(result.summary).toContain(
      "The project's own checks did not pass locally on this branch."
    );
    expect(await report(result, root)).toEqual(result);
  });
});

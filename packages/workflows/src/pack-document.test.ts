import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { groupProblems, loadPackDocument } from './pack-document';

const track = trackTempRoots();

const MANIFEST = {
  schemaVersion: 1,
  kind: 'workflow-pack',
  name: 'flow',
  description: 'A pack.',
  entrypoints: { plan: 'plan/plan.yaml' },
};

async function pack(document: string | undefined, text?: string): Promise<string> {
  const dir = track(await mkdtemp(join(tmpdir(), 'archon-pack-document-')));
  await writeFile(
    join(dir, 'archon-plugin.json'),
    JSON.stringify(document === undefined ? MANIFEST : { ...MANIFEST, document })
  );
  if (text !== undefined) {
    await mkdir(join(dir, 'docs'), { recursive: true });
    await writeFile(join(dir, 'docs', 'how.md'), text);
  }
  return dir;
}

describe("a pack's document", () => {
  test('its frontmatter gives the groups, in order, and the text below is left alone', async () => {
    const dir = await pack(
      'docs/how.md',
      '---\ngroups:\n  - name: Make\n    stages: [plan, build]\n  - name: Check\n    stages: [check]\n---\n# How it works\n\n---\nnot frontmatter\n'
    );
    expect(await loadPackDocument(dir)).toEqual({
      document: 'docs/how.md',
      groups: [
        { name: 'Make', stages: ['plan', 'build'] },
        { name: 'Check', stages: ['check'] },
      ],
      problems: [],
    });
  });

  test('a pack that names no document, or a document without frontmatter, declares no groups', async () => {
    expect(await loadPackDocument(await pack(undefined))).toEqual({
      document: null,
      groups: [],
      problems: [],
    });
    expect((await loadPackDocument(await pack('docs/how.md', '# How it works\n'))).groups).toEqual(
      []
    );
  });

  test('a named document that is missing or does not read is a problem, with no groups', async () => {
    const missing = await loadPackDocument(await pack('docs/how.md'));
    expect([missing.groups, missing.problems.length]).toEqual([[], 1]);
    const malformed = await loadPackDocument(
      await pack('docs/how.md', '---\ngroups:\n  - name: Make\n---\n')
    );
    expect([malformed.groups, malformed.problems.length]).toEqual([[], 1]);
  });

  test('a group may name only stages of the flow, each once', () => {
    const stages = ['plan', 'build', 'check'];
    const groups = [
      { name: 'Make', stages: ['plan', 'built'] },
      { name: 'Check', stages: ['check', 'plan'] },
    ];
    expect(groupProblems(groups, stages)).toEqual([
      expect.stringContaining('built'),
      expect.stringContaining('plan'),
    ]);
    expect(groupProblems([{ name: 'Make', stages: ['plan', 'build'] }], stages)).toEqual([]);
  });
});

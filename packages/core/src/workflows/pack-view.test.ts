import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { providerRegistry } from '@archon/providers';
import { readPackView } from './pack-view';

const track = trackTempRoots();

/** A project whose `chain` pack holds one stage, `chain-a`, and `view` as its factory view file. */
async function packProject(view: string): Promise<string> {
  const project = track(await mkdtemp(join(tmpdir(), 'archon-pack-view-')));
  const pack = join(project, '.archon', 'workflows', 'chain');
  await mkdir(join(pack, 'chain-a'), { recursive: true });
  await writeFile(
    join(pack, 'chain-a', 'chain-a.yaml'),
    'name: chain-a\ndescription: a\nnodes:\n  - id: work\n    bash: "true"\n'
  );
  await mkdir(join(pack, '.shared'), { recursive: true });
  await writeFile(join(pack, '.shared', 'factory-view.json'), view);
  await mkdir(join(project, 'triggers'), { recursive: true });
  return project;
}

const read = (project: string) =>
  readPackView(project, 'chain', {
    loadConfig: async () => ({
      assistant: 'claude' as const,
      assistants: { claude: {}, codex: {} },
      commands: {},
    }),
    providers: providerRegistry,
    projectOf: async () => null,
    triggersDirectory: () => join(project, 'triggers'),
    projectKeyOf: async () => null,
  });

const view = (stage: string) => ({
  version: 1,
  summary: 'One stage.',
  howItWorks: {
    title: 'How it works',
    caption: 'One stage.',
    root: 'top',
    views: {
      top: {
        cards: [
          {
            id: 'one',
            title: 'One',
            text: 'x',
            icon: 'hammer',
            kind: 'stage',
            col: 1,
            row: 1,
            stages: [stage],
          },
          { id: 'two', title: 'Two', text: 'x', icon: 'hammer', kind: 'stage', col: 2, row: 1 },
        ],
        edges: [{ from: 'two', to: 'one', kind: 'loops-back' }],
      },
    },
  },
});

describe('readPackView', () => {
  test('a file that is not JSON, or whose envelope does not read, has its path and no view', async () => {
    for (const body of ['{ not json', JSON.stringify({ version: 1, placement: {} })]) {
      const result = await read(await packProject(body));
      expect(result.path).toEndWith(join('.shared', 'factory-view.json'));
      expect(result.view).toBeNull();
      expect(result.problems.length).toBeGreaterThan(0);
      expect(result.problems.every(problem => problem.kind === 'unreadable')).toBe(true);
    }
  });

  test("a file is reconciled with the pack's graph when it is read, a stale stage dropped alone", async () => {
    const good = await read(await packProject(JSON.stringify(view('chain-a'))));
    expect([good.view?.summary, good.problems]).toEqual(['One stage.', []]);
    const stale = await read(await packProject(JSON.stringify(view('chain-z'))));
    expect(stale.view?.summary).toBe('One stage.');
    expect(stale.view?.howItWorks.views.top?.cards[0]).not.toHaveProperty('stages');
    expect(stale.problems.map(problem => [problem.kind, problem.path.join('.')])).toEqual([
      ['dropped', 'howItWorks.views.top.cards.0.stages.0'],
    ]);
  });
});

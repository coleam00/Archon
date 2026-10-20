import { beforeEach, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { execFileAsync } from './exec';
import { resolvePushDestinations } from './push-destinations';

const roots = trackTempRoots();
let repo: string;
async function git(...args: string[]): Promise<string> {
  return (await execFileAsync('git', ['-C', repo, ...args])).stdout;
}
beforeEach(async () => {
  repo = roots(await mkdtemp(join(tmpdir(), 'archon-push-config-')));
  await git('init', '--bare', '-q');
});

type Setting = readonly [string, string];
const cases: { name: string; settings: Setting[] }[] = [
  ...(['insteadOf', 'pushInsteadOf'] as const).map(kind => ({
    name: `remote-name alias through ${kind}`,
    settings: [
      ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
      [`url.destination:.${kind}`, 'origin'],
    ] satisfies Setting[],
  })),
  ...(['insteadOf', 'pushInsteadOf'] as const).flatMap(kind =>
    [false, true].map(reset => ({
      name: `remote-name ${kind} alias with explicit pushurls (reset=${reset})`,
      settings: [
        ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
        ...(reset
          ? ([
              ['remote.origin.url', 'old'],
              ['remote.origin.url', ''],
            ] satisfies Setting[])
          : []),
        ['remote.origin.pushurl', 'explicit:'],
        ['remote.origin.pushurl', 'second:'],
        [`url.destination:.${kind}`, 'origin'],
        ['url.rewritten:.insteadOf', 'explicit:'],
      ] satisfies Setting[],
    }))
  ),
  {
    name: 'remote-name alias with empty generated push URL and explicit pushurl',
    settings: [
      ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
      ['remote.origin.pushurl', 'explicit:'],
      ['url..pushInsteadOf', 'origin'],
    ],
  },
  {
    name: 'remote-name fallback without rewrite keeps only explicit pushurl',
    settings: [
      ['remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
      ['remote.origin.pushurl', 'explicit:'],
    ],
  },
  {
    name: 'configured fetch URL suppresses generated pushInsteadOf with explicit pushurl',
    settings: [
      ['remote.origin.url', 'source:'],
      ['remote.origin.pushurl', 'explicit:'],
      ['url.generated:.pushInsteadOf', 'source:'],
    ],
  },
  {
    name: 'remote-name fallback after URL reset',
    settings: [
      ['remote.origin.url', 'old'],
      ['remote.origin.url', ''],
      ['url.destination:.pushInsteadOf', 'origin'],
    ],
  },
  {
    name: 'empty generated push URL falls back to original URL',
    settings: [
      ['remote.origin.url', 'source:'],
      ['url..pushInsteadOf', 'source:'],
    ],
  },
  {
    name: 'empty generated push URL does not join nonempty destinations',
    settings: [
      ['remote.origin.url', 'source:'],
      ['remote.origin.url', 'other:'],
      ['url..pushInsteadOf', 'source:'],
      ['url.destination:.pushInsteadOf', 'other:'],
    ],
  },
  {
    name: 'empty generated push URL resets preceding generated destinations',
    settings: [
      ['remote.origin.url', 'other:'],
      ['remote.origin.url', 'source:'],
      ['url..pushInsteadOf', 'source:'],
      ['url.destination:.pushInsteadOf', 'other:'],
    ],
  },
  {
    name: 'empty rewrite base preserves a nonempty suffix',
    settings: [
      ['remote.origin.url', 'source:path'],
      ['url..pushInsteadOf', 'source:'],
    ],
  },
  {
    name: 'multiple fallback URLs',
    settings: [
      ['remote.origin.url', 'first'],
      ['remote.origin.url', 'second'],
    ],
  },
  {
    name: 'explicit pushurls',
    settings: [
      ['remote.origin.url', 'fetch'],
      ['remote.origin.pushurl', 'first= '],
      ['remote.origin.pushurl', 'second'],
    ],
  },
  {
    name: 'longest insteadOf',
    settings: [
      ['remote.origin.url', 'source:long/path'],
      ['url.short/.insteadOf', 'source:'],
      ['url.long/.insteadOf', 'source:long/'],
    ],
  },
  {
    name: 'single insteadOf pass',
    settings: [
      ['remote.origin.url', 'source:'],
      ['url.middle:.insteadOf', 'source:'],
      ['url.wrong:.insteadOf', 'middle:'],
    ],
  },
  {
    name: 'pushInsteadOf precedes insteadOf',
    settings: [
      ['remote.origin.url', 'source:'],
      ['url.push:.pushInsteadOf', 'source:'],
      ['url.fetch:.insteadOf', 'source:'],
      ['url.wrong:.insteadOf', 'push:'],
    ],
  },
  {
    name: 'explicit pushurl ignores pushInsteadOf',
    settings: [
      ['remote.origin.url', 'source:'],
      ['remote.origin.pushurl', 'push:'],
      ['url.wrong:.pushInsteadOf', 'push:'],
      ['url.right:.insteadOf', 'push:'],
    ],
  },
  {
    name: 'partial pushInsteadOf matches',
    settings: [
      ['remote.origin.url', 'source:'],
      ['remote.origin.url', 'other:'],
      ['url.push:.pushInsteadOf', 'source:'],
    ],
  },
  {
    name: 'rewrite ties follow base order',
    settings: [
      ['remote.origin.url', 'source:'],
      ['url.first:.insteadOf', 'unused:'],
      ['url.second:.insteadOf', 'source:'],
      ['url.first:.insteadOf', 'source:'],
    ],
  },
  {
    name: 'rewrite without a subsection is ignored',
    settings: [
      ['remote.origin.url', 'source:'],
      ['url.insteadOf', 'source:'],
    ],
  },
  {
    name: 'URL resets',
    settings: [
      ['remote.origin.url', 'old'],
      ['remote.origin.url', ''],
      ['remote.origin.url', 'new'],
    ],
  },
  {
    name: 'push URL resets',
    settings: [
      ['remote.origin.url', 'fetch'],
      ['remote.origin.pushurl', 'old'],
      ['remote.origin.pushurl', ''],
    ],
  },
];

test.each(cases)('snapshot resolution conforms to Git: $name', async ({ settings }) => {
  for (const [key, value] of settings) await git('config', '--add', key, value);
  const expected = (await git('remote', 'get-url', '--push', '--all', 'origin'))
    .split('\n')
    .filter(Boolean);
  expect(await resolvePushDestinations(repo, 'origin')).toEqual(expected);
});

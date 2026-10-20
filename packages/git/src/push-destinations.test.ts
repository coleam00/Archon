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

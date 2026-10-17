import { expect, test } from 'bun:test';
import { defaultBaselines, SCHEMA_REPO_PATH } from './schema-upgrade-baselines';

test('PostgreSQL automatic baselines exclude prereleases with distinct schema blobs', () => {
  const blobs = new Map([
    [`v0.11.1:${SCHEMA_REPO_PATH}`, 'released-schema'],
    [`v0.12.0-rehearsal.1:${SCHEMA_REPO_PATH}`, 'rehearsal-schema'],
    [`v0.12.0-rc.1:${SCHEMA_REPO_PATH}`, 'rc-schema'],
  ]);
  const git = (...args: string[]): { ok: boolean; stdout: string } => {
    if (args[0] === 'tag') {
      return { ok: true, stdout: 'v0.11.1\nv0.12.0-rehearsal.1\nv0.12.0-rc.1\n' };
    }
    const blob = blobs.get(args[1]);
    if (args[0] !== 'rev-parse' || blob === undefined) {
      throw new Error(`unexpected git command: ${args.join(' ')}`);
    }
    return { ok: true, stdout: `${blob}\n` };
  };

  expect(defaultBaselines(git)).toEqual(['v0.11.1']);
});

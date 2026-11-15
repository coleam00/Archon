import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempTree } from '@archon/paths/test-utils';
import { cliStartStore, shouldReportCliStart } from './cli-start-telemetry';

describe('shouldReportCliStart', () => {
  test.each([[[]], [['--help']], [['version']], [['workflow', 'run', 'x']], [['--bogus']]])(
    'reports %p',
    args => {
      expect(shouldReportCliStart(args, {})).toBe(true);
    }
  );

  test('leaves serve to the server surface, wherever the command sits', () => {
    expect(shouldReportCliStart(['serve'], {})).toBe(false);
    expect(shouldReportCliStart(['--cwd', '/tmp/x', 'serve', '--port', '3090'], {})).toBe(false);
  });

  test('counts a serve that never boots the server', () => {
    expect(shouldReportCliStart(['serve', '--help'], {})).toBe(true);
    expect(shouldReportCliStart(['serve', '--download-only'], {})).toBe(true);
  });

  test('a flag value named serve is not the serve command', () => {
    expect(shouldReportCliStart(['--cwd', 'serve', 'version'], {})).toBe(true);
  });

  test('a detached run owner leaves the report to its parent', () => {
    expect(shouldReportCliStart(['workflow', 'run', 'x'], { ARCHON_DETACHED_RUN_OWNER: '1' })).toBe(
      false
    );
  });
});

describe('cliStartStore', () => {
  let home: string;
  let saved: { home?: string; db?: string };

  beforeEach(() => {
    saved = { home: process.env.ARCHON_HOME, db: process.env.DATABASE_URL };
    home = mkdtempSync(join(tmpdir(), 'archon-cli-start-store-'));
    process.env.ARCHON_HOME = home;
    delete process.env.DATABASE_URL;
  });

  afterEach(async () => {
    for (const [key, value] of [
      ['ARCHON_HOME', saved.home],
      ['DATABASE_URL', saved.db],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeTempTree(home);
  });

  test('reports the database the CLI would open when no store is selected', async () => {
    expect(await cliStartStore()).toBe('sqlite');
    process.env.DATABASE_URL = 'postgres://db';
    expect(await cliStartStore()).toBe('postgresql');
  });

  test('reports the file store when config selects it', async () => {
    writeFileSync(join(home, 'config.yaml'), 'store: files\n');
    expect(await cliStartStore()).toBe('files');
  });

  test('an ambiguous selection reports no store instead of failing the command', async () => {
    writeFileSync(join(home, 'config.yaml'), 'store: files\n');
    process.env.DATABASE_URL = 'postgres://db';
    expect(await cliStartStore()).toBeUndefined();
  });
});

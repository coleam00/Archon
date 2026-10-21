import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots, testTimeout } from '@archon/paths/test-utils';
import { quoteCommandArg } from '@archon/core/utils/command-args';

const track = trackTempRoots();

test.each([false, true])(
  'CLI chat keeps project selection across turns (initial message: %s)',
  initial => {
    const root = track(mkdtempSync(join(tmpdir(), 'archon-chat-session-')));
    const home = join(root, 'home');
    const alpha = join(root, 'alpha');
    const beta = join(root, 'beta');
    for (const path of [home, alpha, beta]) mkdirSync(path);
    const registerAlpha = `/register-project --folder alpha ${quoteCommandArg(alpha)}`;
    const args = [join(import.meta.dir, '..', 'cli.ts'), 'chat'];
    if (initial) args.push(registerAlpha);
    const result = spawnSync(process.execPath, args, {
      cwd: root,
      env: {
        ...process.env,
        ARCHON_HOME: home,
        DEFAULT_AI_ASSISTANT: 'claude',
        DATABASE_URL: '',
        ARCHON_TELEMETRY_DISABLED: '1',
      },
      input: [
        ...(initial ? [] : [registerAlpha]),
        '/setproject alpha',
        '/status',
        `/register-project --folder beta ${quoteCommandArg(beta)}`,
        '/setproject beta',
        '/status',
        ...(initial ? [] : ['/exit', '/setproject alpha']),
        '',
      ].join('\n'),
      encoding: 'utf8',
      timeout: testTimeout(15_000),
    });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('error');
    expect(result.stdout).toContain('alpha (folder');
    expect(result.stdout).toContain('beta (folder');
    const db = new Database(join(home, 'archon.db'), { readonly: true });
    try {
      const conversations = db
        .query('SELECT platform_type, codebase_id FROM remote_agent_conversations')
        .all();
      const project = db
        .query<{ id: string }, []>("SELECT id FROM remote_agent_codebases WHERE name = 'beta'")
        .get();
      expect(conversations).toEqual([{ platform_type: 'cli', codebase_id: project?.id }]);
    } finally {
      db.close();
    }
  },
  testTimeout(20_000)
);

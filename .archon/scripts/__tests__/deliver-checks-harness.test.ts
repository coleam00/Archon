import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgePrRecord, packScriptRunner } from './deliver-checks-harness';
import { trackTempRoots } from './temp-roots';

const { runPackScript } = packScriptRunner();
const track = trackTempRoots();

test('pack script inputs come from fixtures, including when Bun finds an env file', () => {
  const cwd = track(mkdtempSync(join(tmpdir(), 'archon-pack-env-')));
  writeFileSync(join(cwd, '.env'), 'INPUTS_NUMBER=9000\nINPUTS_ENV_ONLY=env-file\n');
  const parent = {
    INPUTS_NUMBER: '4807',
    INPUTS_EXTRA: 'parent-extra',
    INPUTS_EXPLICIT: 'parent-value',
  };
  const saved = Object.fromEntries(Object.keys(parent).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, parent);
    const result = runPackScript('build-queue/scripts/facts', {
      cwd,
      inputs: { INPUTS_EXPLICIT: 'fixture-value' },
      preload: `console.log(JSON.stringify({
        inputs: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('INPUTS_'))),
        path: process.env.PATH,
        home: process.env.HOME,
        execPath: process.execPath,
      })); process.exit(0);`,
    });
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual({
      inputs: {
        INPUTS_PR: JSON.stringify(forgePrRecord()),
        INPUTS_EXPECTED: '[]',
        INPUTS_EXPLICIT: 'fixture-value',
      },
      path: process.env.PATH,
      home: process.env.HOME,
      execPath: process.execPath,
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

import { existsSync } from 'node:fs';
import { expect, test } from 'bun:test';

// Writes through `git config --global` and reports where the write landed, for
// test-preload.test.ts.
test('reports the global config git writes', () => {
  const result = Bun.spawnSync(['git', 'config', '--global', 'archon.probe', '1'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode).toBe(0);
  const gitGlobalConfig = process.env.GIT_CONFIG_GLOBAL ?? '';
  expect({ gitGlobalConfig, exists: existsSync(gitGlobalConfig) }).toMatchObject({ exists: true });
  console.log(JSON.stringify({ gitGlobalConfig }));
});

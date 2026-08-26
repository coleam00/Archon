import { expect, test } from 'bun:test';

test('capability matrix ignores ambient OpenCode V2 opt-in', async () => {
  const child = Bun.spawn(
    [process.execPath, 'run', 'scripts/generate-capability-matrix.ts', '--check'],
    {
      cwd: import.meta.dir + '/..',
      env: { ...process.env, OPENCODE_V2: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(stderr).toBe('');
  expect(stdout).toContain('check:capability-matrix OK');
  expect(exitCode).toBe(0);
});

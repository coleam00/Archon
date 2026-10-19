import { expect, test } from 'bun:test';
import { execFileAsync, resolveBashPath } from '@archon/git';
import { bashScriptCommand } from './bash-script';

for (const size of [0, 32_768, 200_000]) {
  test(`preserves Bash identity and output with ${size} padding bytes`, async () => {
    const script = `#${'x'.repeat(size)}\nprintf '%s|%s|%s' "$0" "\${BASH_SOURCE[0]}" "$#"`;
    const command = bashScriptCommand(script);
    expect(Buffer.byteLength(command.args.join(''))).toBeLessThan(200);
    const { stdout } = await execFileAsync(resolveBashPath(), command.args, {
      input: command.input,
    });
    const baseline = await execFileAsync(resolveBashPath(), ['-c', script.slice(size + 2)]);
    expect(stdout).toBe(baseline.stdout);
  });
}

test('delivers large multibyte source without artifact files', async () => {
  const value = 'é'.repeat(100_000);
  const command = bashScriptCommand(`value='${value}'; printf '%s' "$value"`);
  const { stdout } = await execFileAsync(resolveBashPath(), command.args, { input: command.input });
  expect(stdout).toBe(value);
});

test('preserves authored completion exit codes', async () => {
  for (const code of [1, 7]) {
    const command = bashScriptCommand(`exit ${code}`);
    try {
      await execFileAsync(resolveBashPath(), command.args, { input: command.input });
      expect.unreachable('expected a failed predicate');
    } catch (error) {
      expect(error).toMatchObject({ code });
    }
  }
});

test('rejects NUL source before a completion predicate can run', () => {
  expect(() => bashScriptCommand('exit 0\0exit 1')).toThrow('NUL');
});

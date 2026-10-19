import { describe, expect, it } from 'bun:test';
import { execFileAsync, resolveBashPath } from '@archon/git';
import { bashInvocation } from './bash-invocation';

describe('Bash stdin evaluator', () => {
  it('rejects NUL before a body can execute', () => {
    expect(() => bashInvocation("printf before # '\0'\nexit 7")).toThrow('NUL');
  });

  it('preserves trailing newlines in an EOF-terminated heredoc', async () => {
    const script = 'cat <<EOF\nhello\n\n';
    const invocation = bashInvocation(script);
    const native = await execFileAsync(resolveBashPath(), ['-c', script]);
    const delivered = await execFileAsync(resolveBashPath(), invocation.args, {
      input: invocation.input,
    });
    expect(delivered.stdout).toBe(native.stdout);
    expect(delivered.stdout).toBe('hello\n\n');
  });

  it.each([
    '',
    'printf "0=%s source=%s flags=%s\\n" "$0" "${BASH_SOURCE[*]}" "$-"; f() { printf "function=%s" "${BASH_SOURCE[*]}"; }; f',
    "cat <<'END'\nheredoc\nEND\n",
    "value='apostrophe'\\'' backslash\\ $() `hi`; *\nembedded\n\n'; printf '%s' \"$value\"",
    'printf out; printf err >&2; exit 7',
  ])('preserves native -c results for %j', async script => {
    const invocation = bashInvocation(script);
    const run = async (args: string[], input?: string) => {
      try {
        return await execFileAsync(resolveBashPath(), args, { input });
      } catch (error) {
        const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
        return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
      }
    };
    expect(await run(invocation.args, invocation.input)).toEqual(await run(['-c', script]));
  });

  it('exposes EOF and the fixed evaluator, without a loader variable', async () => {
    const invocation = bashInvocation(
      'if IFS= read -r line; then exit 9; fi; test -z "${__archon_bash_body+x}" || exit 10; printf \'%s\' "$BASH_EXECUTION_STRING"'
    );
    expect(
      (await execFileAsync(resolveBashPath(), invocation.args, { input: invocation.input })).stdout
    ).toBe(invocation.args[1]);
  });

  it('loads with only builtins and startup errexit', async () => {
    const invocation = bashInvocation('printf loaded');
    const bashPath = Bun.which(resolveBashPath());
    if (!bashPath) throw new Error('Bash is unavailable');
    expect(
      await execFileAsync(bashPath, ['-e', ...invocation.args], {
        input: invocation.input,
        env: { ...process.env, PATH: '/nonexistent' },
      })
    ).toEqual({ stdout: 'loaded', stderr: '' });
  });
});

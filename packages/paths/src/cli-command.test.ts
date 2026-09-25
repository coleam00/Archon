import { describe, expect, it } from 'bun:test';
import { existsSync } from 'fs';
import { join } from 'path';
import { archonCliInvocation, publishArchonCliCommand } from './cli-command';

describe('archon CLI host command', () => {
  it('re-enters the source checkout CLI entry through the running Bun', () => {
    const [runtime, flag, entry, ...rest] = archonCliInvocation();
    expect(runtime).toBe(process.execPath);
    expect(flag).toBe('--no-env-file');
    expect(entry).toBe(join(import.meta.dir, '..', '..', 'cli', 'src', 'cli.ts'));
    expect(existsSync(entry ?? '')).toBe(true);
    expect(rest).toEqual([]);
  });

  it('publishes the invocation as a JSON argv array', () => {
    const env: NodeJS.ProcessEnv = {};
    publishArchonCliCommand(env);
    expect(JSON.parse(env.ARCHON_CLI_COMMAND ?? 'null')).toEqual(archonCliInvocation());
  });
});

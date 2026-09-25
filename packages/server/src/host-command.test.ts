/**
 * Runs from a directly started server (`bun run start`, `bun run dev`, Docker)
 * execute bundled scripts that call back into the CLI. Loading the server entry
 * must publish that host command, the same way the CLI does for its own runs.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { removeTempTree } from '@archon/paths/test-utils';
import { archonCliInvocation } from '@archon/paths/cli-command';

const home = mkdtempSync(join(tmpdir(), 'archon-server-host-command-'));
process.env.ARCHON_HOME = home;
delete process.env.ARCHON_CLI_COMMAND;

afterAll(async () => {
  await removeTempTree(home);
});

test('loading the server publishes the CLI host command', async () => {
  await import('./index');
  expect(JSON.parse(process.env.ARCHON_CLI_COMMAND ?? 'null')).toEqual(archonCliInvocation());
});

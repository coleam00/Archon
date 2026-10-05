import { mock, spyOn } from 'bun:test';
import { appendFileSync } from 'node:fs';
import * as git from '@archon/git';

mock.module('@archon/core/services/title-generator', () => ({
  generateAndSetTitle: async (): Promise<void> => undefined,
}));

const logPath = process.env.ARCHON_TEST_GIT_LOG;
if (!logPath) throw new Error('ARCHON_TEST_GIT_LOG is required');
const original = git.execFileAsync;
spyOn(git, 'execFileAsync').mockImplementation(async (command, args, options) => {
  appendFileSync(logPath, JSON.stringify({ command, args }) + '\n');
  return original(command, args, options);
});

await import('../../cli');

import { mock } from 'bun:test';
import { join } from 'node:path';

mock.module('@archon/core/services/title-generator', () => ({
  generateAndSetTitle: async (): Promise<void> => undefined,
}));

// The Claude provider process runs a stand-in for Claude Code whose agent shell
// commits state; the CLI, engine, provider process and provider stay real.
const { getSourceProviderEntry } = await import('@archon/paths');
const paths = await import('@archon/paths');
const agentShell = join(
  import.meta.dir,
  '../../../../providers/src/claude/fixtures/agent-shell.ts'
);
mock.module('@archon/paths', () => ({
  ...paths,
  getSourceProviderEntry: (id: string): string =>
    id === 'claude' ? agentShell : getSourceProviderEntry(id),
}));

await import('../../cli');

import { mock } from 'bun:test';

// Keep the public CLI, its detached forwarding, and execution real. Title generation
// is unrelated background AI work, so deterministic CLI fixtures suppress only it.
mock.module('@archon/core/services/title-generator', () => ({
  generateAndSetTitle: async (): Promise<void> => undefined,
}));

await import('../../cli');

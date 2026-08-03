import { describe, expect, it, mock } from 'bun:test';

const commandName = '__archon_pack__bundled:test-pack:test-flow::blank';

mock.module('./defaults/bundled-defaults', () => ({
  BUNDLED_COMMANDS: { [commandName]: '   \n' },
  isBinaryBuild: () => true,
}));

import { loadCommandPrompt } from './executor-shared';
import type { WorkflowDeps } from './deps';

describe('loadCommandPrompt — bundled packaged commands', () => {
  it('reports whitespace-only embedded commands as empty files', async () => {
    const deps = {
      loadConfig: async () => ({ defaults: { loadDefaultCommands: true } }),
    } as unknown as WorkflowDeps;

    const result = await loadCommandPrompt(deps, '/repo', commandName);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('empty_file');
  });
});

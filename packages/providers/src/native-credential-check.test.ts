import { expect, mock, test } from 'bun:test';
import type { IAgentProvider } from './types';
import { CopilotProvider } from './community/copilot/provider';
import { OpencodeProvider } from './community/opencode/provider';

const startRuntime = mock(() => {
  throw new Error('Native credential check must not start a runtime');
});
mock.module('@github/copilot-sdk', () => ({ CopilotClient: startRuntime }));
mock.module('@opencode-ai/sdk', () => ({
  createOpencode: startRuntime,
  createOpencodeClient: startRuntime,
}));

for (const Provider of [CopilotProvider, OpencodeProvider]) {
  test(`${Provider.name} native login is not checked without starting a runtime`, async () => {
    const provider: IAgentProvider = new Provider();
    expect(
      await provider.checkCredential({ env: {}, signal: new AbortController().signal })
    ).toEqual({ state: 'not_checked', source: 'native' });
    expect(startRuntime).not.toHaveBeenCalled();
  });
}

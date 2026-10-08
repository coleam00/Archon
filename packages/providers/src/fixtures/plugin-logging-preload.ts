import type { ProviderDiagnostics } from '@archon/provider-contract';
import { createLogger } from '@archon/paths';
import { ClaudeProvider } from '../claude/provider';
import { CodexProvider } from '../codex/provider';
import { PiProvider } from '../community/pi/provider';

for (const providerClass of [ClaudeProvider, CodexProvider, PiProvider]) {
  providerClass.prototype.diagnose = async (): Promise<ProviderDiagnostics> => {
    createLogger(`provider.${providerClass.name}`).error(
      {
        err: new Error('credential-secret'),
        text: 'message-text',
        token: 'token-secret',
        input: { prompt: 'message-text' },
        count: 2,
        resultReported: false,
        failureClass: 'auth',
      },
      'query_error'
    );
    return { checks: [{ id: 'fixture', label: 'Fixture', status: 'ok', message: 'Ready' }] };
  };
}

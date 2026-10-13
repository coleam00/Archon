import { mock } from 'bun:test';
import { serveProvider } from '@archon/provider-contract/plugin';
import { installProviderLogSink } from '../../shared/plugin-logging';

const sdk = await import('@anthropic-ai/claude-agent-sdk');
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...sdk,
  query: ({ options = {} }: Parameters<typeof sdk.query>[0]) =>
    (async function* () {
      const continuing = options.resume !== undefined;
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: options.forkSession ? `${options.resume}-fork` : (options.resume ?? 'source'),
        total_cost_usd: continuing ? 0.35 : 0.13,
        modelUsage: {
          'claude-sonnet-4-6': { outputTokens: continuing ? 300 : 100 },
          'claude-haiku-4-5': { outputTokens: 10 },
        },
        result: String(process.pid),
      };
    })(),
}));
const { ClaudeProvider } = await import('@archon/providers/claude/provider');
const { descriptor } = await import('@archon/providers/claude/descriptor');
await serveProvider({
  descriptor,
  create: log => {
    installProviderLogSink(log);
    return new ClaudeProvider();
  },
});

import { mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { serveProvider } from '@archon/provider-contract/plugin';
import { installProviderLogSink } from '../../shared/plugin-logging';

const sdk = await import('@anthropic-ai/claude-agent-sdk');
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...sdk,
  query: ({ options = {} }: Parameters<typeof sdk.query>[0]) =>
    (async function* () {
      const continuing = options.resume !== undefined;
      const sessionId = options.forkSession ? randomUUID() : (options.resume ?? randomUUID());
      const total = continuing ? 0.35 : 0.13;
      const modelUsage = {
        'claude-sonnet-4-6': { outputTokens: continuing ? 300 : 100 },
        'claude-haiku-4-5': { outputTokens: 10 },
      };
      const configRoot = options.env?.CLAUDE_CONFIG_DIR;
      if (configRoot === undefined) throw new Error('fixture needs CLAUDE_CONFIG_DIR');
      const project = join(configRoot, 'projects', 'custom-project-slug');
      mkdirSync(project, { recursive: true });
      appendFileSync(
        join(project, sessionId + '.jsonl'),
        JSON.stringify({
          type: 'cost-state',
          sessionId,
          totalCostUSD: total,
          modelUsage,
        }) + '\n'
      );
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: sessionId,
        total_cost_usd: total,
        modelUsage,
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

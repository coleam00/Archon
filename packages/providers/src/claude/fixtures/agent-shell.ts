import { mock } from 'bun:test';
import { serveProvider } from '@archon/provider-contract/plugin';
import { installProviderLogSink } from '../../shared/plugin-logging';

// Stands in for Claude Code: the agent runs `archon state patch` from its shell, a
// child process holding the environment the provider spawns Claude Code with. The
// preflight account check sees a logged-in user, so no real Claude login is needed.
const sdk = await import('@anthropic-ai/claude-agent-sdk');
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...sdk,
  query: ({ options = {} }: Parameters<typeof sdk.query>[0]) =>
    Object.assign(
      (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'agent-shell-session', plugins: [] };
        const env = Object.fromEntries(
          Object.entries(options.env ?? {}).filter(
            (entry): entry is [string, string] => entry[1] !== undefined
          )
        );
        const command = JSON.parse(env.ARCHON_CLI_COMMAND ?? 'null') as string[];
        const shell = Bun.spawn([...command, 'state', 'patch', 'agent/notes'], {
          cwd: options.cwd,
          env,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        });
        shell.stdin.write('{"ops":[{"op":"set","path":"/noted","value":true}]}');
        shell.stdin.end();
        const [code, stderr] = await Promise.all([shell.exited, new Response(shell.stderr).text()]);
        yield {
          type: 'result',
          subtype: code === 0 ? 'success' : 'error_during_execution',
          is_error: code !== 0,
          session_id: 'agent-shell-session',
          total_cost_usd: 0,
          result: code === 0 ? 'noted' : stderr,
        };
      })(),
      {
        accountInfo: async () => ({
          email: 'agent-shell@example.com',
          subscriptionType: 'Claude Max',
          apiProvider: 'firstParty',
        }),
        close: (): void => undefined,
      }
    ),
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

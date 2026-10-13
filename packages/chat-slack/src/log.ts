// SDK errors can embed API request bodies, credentials and platform identities. A run id is
// Archon's own identifier, logged only where the operator must find the run outside Slack.
export function logFailure(operation: string, error: unknown, runId?: string): void {
  const err = { name: error instanceof Error ? error.name : 'Error' };
  console.error(JSON.stringify({ err, platform: 'slack', operation, ...(runId ? { runId } : {}) }));
}

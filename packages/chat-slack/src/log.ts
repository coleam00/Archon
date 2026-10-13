// SDK errors can embed API request bodies, credentials and platform identities.
export function logFailure(operation: string, error: unknown): void {
  const err = { name: error instanceof Error ? error.name : 'Error' };
  console.error(JSON.stringify({ err, platform: 'slack', operation }));
}

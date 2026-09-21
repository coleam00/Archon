export function consoleReturnDestination(state: unknown): string {
  if (typeof state !== 'object' || state === null || !('returnTo' in state)) return '/console';
  const { returnTo } = state;
  if (typeof returnTo !== 'string' || !returnTo.startsWith('/')) return '/console';

  // Login returns only to the local console, never to an external URL or itself.
  const origin = 'https://archon.invalid';
  try {
    const destination = new URL(returnTo, origin);
    if (
      destination.origin === origin &&
      (destination.pathname === '/console' || destination.pathname.startsWith('/console/'))
    ) {
      return destination.pathname + destination.search + destination.hash;
    }
  } catch {
    // Invalid navigation state has no destination to restore.
  }
  return '/console';
}

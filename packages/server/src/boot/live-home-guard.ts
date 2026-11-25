import { resolve } from 'node:path';
import { getArchonHome } from '@archon/paths';

/**
 * The factory that builds this console runs on its own Archon home. Its launcher sets
 * ARCHON_FACTORY_LIVE_HOME to that home, and every agent it starts inherits it. A server
 * an agent starts in its worktree to check its work must not open that home: it would share
 * the live factory's database with a second server. Only the operator's own server sets
 * ARCHON_FACTORY_LIVE_SERVE=1. Agents use a throwaway home (`bun run dev:console`).
 */
export function liveHomeRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  const live = env.ARCHON_FACTORY_LIVE_HOME;
  if (!live || env.ARCHON_FACTORY_LIVE_SERVE === '1') return null;
  if (resolve(getArchonHome()).toLowerCase() !== resolve(live).toLowerCase()) return null;
  return (
    `Refusing to start: ARCHON_HOME is the live factory's home (${live}). ` +
    'Start the server with a throwaway home instead: `bun run dev:console`.'
  );
}

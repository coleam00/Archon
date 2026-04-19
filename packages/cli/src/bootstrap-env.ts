import { homedir } from 'os';
import { join } from 'path';

function expandTilde(path: string): string {
  if (!path.startsWith('~')) {
    return path;
  }

  const pathAfterTilde = path.slice(1).replace(/^[/\\]/, '');
  return join(homedir(), pathAfterTilde);
}

export function resolveCliArchonHome(env: NodeJS.ProcessEnv = process.env): string {
  const envHome = env.ARCHON_HOME;
  if (envHome) {
    return expandTilde(envHome);
  }

  return join(env.HOME ?? homedir(), '.archon');
}

export function resolveCliGlobalEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveCliArchonHome(env), '.env');
}

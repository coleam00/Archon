import { parseArgs } from 'node:util';
import { releaseAsset } from './release-asset';

export interface ServerLaunchOptions {
  cliVersion: string;
  port?: number;
  webDistPath?: string;
}

export const SERVER_LAUNCH_REQUIRED = 'archon-server is started by `archon serve`';

export function serverReleaseAsset(target: string): string {
  return releaseAsset('archon-server', target);
}

export function serverLaunchArgv(options: ServerLaunchOptions): string[] {
  const argv = ['--cli-version', options.cliVersion];
  if (options.port !== undefined) argv.push('--port', String(options.port));
  if (options.webDistPath !== undefined) argv.push('--web-dist', options.webDistPath);
  return argv;
}

export function parseServerLaunchArgv(args: readonly string[]): ServerLaunchOptions {
  const { values, tokens } = parseArgs({
    args: [...args],
    strict: true,
    tokens: true,
    allowPositionals: false,
    options: {
      'cli-version': { type: 'string' },
      port: { type: 'string' },
      'web-dist': { type: 'string' },
    },
  });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new Error(`--${token.name} may only be supplied once`);
    seen.add(token.name);
  }
  if (!values['cli-version']) throw new Error(SERVER_LAUNCH_REQUIRED);
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('--port must be an integer between 1 and 65535');
  }
  return { cliVersion: values['cli-version'], port, webDistPath: values['web-dist'] };
}

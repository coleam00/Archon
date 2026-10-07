import { parseArgs } from 'node:util';

export interface ServerLaunchOptions {
  cliVersion: string;
  port?: number;
  webDistPath?: string;
}

export const SERVER_LAUNCH_REQUIRED = 'archon-server is started by `archon serve`';

export function serverReleaseAsset(target: string): string {
  const match = /^bun-(darwin|linux|windows)-(x64|arm64)$/.exec(target);
  if (!match) throw new Error(`Unsupported server target: ${target}`);
  return `archon-server-${match[1]}-${match[2]}${match[1] === 'windows' ? '.exe' : ''}`;
}

export function serverLaunchArgv(options: ServerLaunchOptions): string[] {
  const argv = ['--cli-version', options.cliVersion];
  if (options.port !== undefined) argv.push('--port', String(options.port));
  if (options.webDistPath !== undefined) argv.push('--web-dist', options.webDistPath);
  return argv;
}

export function parseServerLaunchArgv(args: readonly string[]): ServerLaunchOptions {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      'cli-version': { type: 'string' },
      port: { type: 'string' },
      'web-dist': { type: 'string' },
    },
  });
  if (!values['cli-version']) throw new Error(SERVER_LAUNCH_REQUIRED);
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('--port must be an integer between 1 and 65535');
  }
  return { cliVersion: values['cli-version'], port, webDistPath: values['web-dist'] };
}

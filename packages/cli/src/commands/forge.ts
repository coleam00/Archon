import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { archonCliCommand } from '@archon/paths/cli-launch';
import { getArchonHome } from '@archon/paths/archon-paths';
import {
  ForgeDispatcher,
  DuplicateHostClaimError,
  createGitHubPlugin,
  forgeHostsConfigSchema,
  prRefSchema,
} from '@archon/forge';
import { writeJsonLine } from '../utils/stdout';

export async function forgeCommand(args: string[]): Promise<number> {
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    // The maintained plugin speaks the same stateless stdio protocol as an external executable.
    if (args[0] === '__github') {
      const plugin = createGitHubPlugin();
      if (args[1] === 'metadata') {
        await writeJsonLine(plugin.metadata());
        return 0;
      }
      const request: unknown = JSON.parse(readFileSync(0, 'utf8'));
      const result = await plugin.execOp(args[2] ?? '', request, process.env, controller.signal);
      await writeJsonLine(
        result.kind === 'ok' ? result.value : result.kind === 'op_error' ? result.raw : result
      );
      return result.kind === 'ok' ? 0 : result.kind === 'op_error' ? 1 : 2;
    }
    const { positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean' },
        ref: { type: 'string' },
        config: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
    if (values.help) {
      await writeJsonLine({
        usage: 'archon forge resolve --json | archon forge checks --ref <PrRef JSON> --json',
        config:
          'Optional --config <file> containing {"hosts":{...}}; defaults to ~/.archon/forge.json',
      });
      return 0;
    }
    if (positionals.length !== 1 || !['resolve', 'checks'].includes(positionals[0])) {
      await writeJsonLine({ kind: 'unsupported_op', op: positionals.join('.') });
      return 1;
    }
    let config: unknown = {};
    try {
      const document: unknown = JSON.parse(
        await readFile(values.config ?? join(getArchonHome(), 'forge.json'), 'utf8')
      );
      if (!document || typeof document !== 'object' || !('hosts' in document))
        throw new Error('Expected hosts mapping');
      config = document.hosts;
    } catch (error) {
      if (values.config || (error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Cannot load forge configuration');
    }
    const launch = archonCliCommand();
    const dispatcher = new ForgeDispatcher(
      [
        {
          source: 'builtin:github',
          command: launch.command,
          args: [...launch.args, 'forge', '__github'],
        },
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        configuredHosts: forgeHostsConfigSchema.parse(config),
        signal: controller.signal,
        // The engine retains stderr in its existing exec_output transcript row (#2967).
        audit: (event): void => {
          process.stderr.write(`${JSON.stringify({ type: 'forge_op', ...event })}\n`);
        },
      }
    );
    const result =
      positionals[0] === 'resolve'
        ? await dispatcher.resolve()
        : await dispatcher.checksState(prRefSchema.parse(JSON.parse(values.ref ?? 'null')));
    await writeJsonLine(
      result.kind === 'ok' ? result.value : result.kind === 'error' ? result.error : result
    );
    return result.kind === 'ok' ? 0 : result.kind === 'error' ? 1 : 2;
  } catch (error) {
    // Never echo argv, config values, remote URLs, or parser diagnostics containing input.
    await writeJsonLine({
      kind: 'invalid_request',
      detail:
        error instanceof DuplicateHostClaimError
          ? error.message
          : 'Forge invocation or configuration failed; check the ref, executable, and host claims',
    });
    return 2;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

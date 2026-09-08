import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonLine } from '../utils/stdout';
import type { PluginCandidate } from '@archon/forge/dispatch';

export async function forgeCommand(
  args: string[],
  githubPlugin?: PluginCandidate
): Promise<number> {
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort();
  };
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    // The maintained plugin speaks the same stateless stdio protocol as an external executable.
    if (args[0] === '__github') {
      const { createGitHubPlugin } = await import('@archon/forge/github');
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
        request: { type: 'string' },
        'request-file': { type: 'string' },
        config: { type: 'string' },
        help: { type: 'boolean' },
      },
    });
    if (values.help) {
      await writeJsonLine({
        usage:
          'archon forge resolve --json | checks --ref <PrRef JSON> --json | pr view/create/edit-body/ready/merge-pinned | work-item view | comment upsert --request <JSON or -> | --request-file <file or -> --json',
        config:
          'Optional --config <file> containing {"hosts":{...}}; defaults to ~/.archon/forge.json',
      });
      return 0;
    }
    const { archonCliCommand } = await import('@archon/paths/cli-launch');
    const { getArchonHome } = await import('@archon/paths/archon-paths');
    const forge = await import('@archon/forge');
    const op = positionals.join('.').replace('work-item.', 'workitem.');
    if (
      !['resolve', 'checks', forge.PINNED_MERGE_OP].includes(op) &&
      !Object.hasOwn(forge.publicResultSchemas, op)
    ) {
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
    const dispatcher = new forge.ForgeDispatcher(
      [
        githubPlugin ?? {
          source: 'builtin:github',
          command: launch.command,
          args: [...launch.args, 'forge', '__github'],
        },
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        resolveCredential: async (host): Promise<string | undefined> => {
          const { isPerUserGitHubEnabled } = await import('@archon/core');
          // A shared service account's keyring must never stand in for an Archon user.
          if (isPerUserGitHubEnabled()) return undefined;
          return forge.nativeGitHubCredential(process.env, host);
        },
        configuredHosts: forge.forgeHostsConfigSchema.parse(config),
        signal: controller.signal,
        // The engine retains stderr in its existing exec_output transcript row (#2967).
        audit: (event): void => {
          process.stderr.write(`${JSON.stringify({ type: 'forge_op', ...event })}\n`);
        },
      }
    );
    const readRequest = async (): Promise<unknown> => {
      if (values['request-file'] !== undefined && values.request !== undefined)
        throw new Error('Choose one request source');
      const source = values['request-file'];
      return JSON.parse(
        source !== undefined
          ? source === '-'
            ? readFileSync(0, 'utf8')
            : await readFile(source, 'utf8')
          : values.request === '-'
            ? readFileSync(0, 'utf8')
            : (values.request ?? 'null')
      );
    };
    const result =
      op === 'resolve'
        ? await dispatcher.resolve()
        : op === 'checks'
          ? await dispatcher.checksState(forge.prRefSchema.parse(JSON.parse(values.ref ?? 'null')))
          : op === forge.PINNED_MERGE_OP
            ? await dispatcher.mergePinned(
                forge.pinnedMergeRequestSchema.parse(await readRequest())
              )
            : await dispatcher.publicOperation(
                forge.publicRequestSchema.parse(Object.assign({}, await readRequest(), { op }))
              );
    await writeJsonLine(
      result.kind === 'ok' ? result.value : result.kind === 'error' ? result.error : result
    );
    return result.kind === 'ok' ? 0 : result.kind === 'error' ? 1 : 2;
  } catch (error) {
    const forge = await import('@archon/forge');
    // Never echo argv, config values, remote URLs, or parser diagnostics containing input.
    await writeJsonLine({
      kind: 'invalid_request',
      detail:
        error instanceof forge.DuplicateHostClaimError
          ? error.message
          : 'Forge invocation or configuration failed; check the ref, executable, and host claims',
    });
    return 2;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

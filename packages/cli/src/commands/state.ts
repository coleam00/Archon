import { relative } from 'node:path';
import { z } from '@hono/zod-openapi';
import * as git from '@archon/git';
import {
  getArchonWorkspacesPath,
  getProjectStoragePaths,
  resolveProjectStorageKey,
  resolveRunStorageRoot,
} from '@archon/paths';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { registerRepository } from '@archon/core/handlers/clone';
import { findCodebaseForCheckoutPath } from '@archon/core/services/codebase-checkout-resolver';
import { nodeExecutionMetadataSchema } from '@archon/workflows/schemas/node-execution';
import {
  stateDocumentNameSchema,
  stateRevisionNumberSchema,
  statePatchSchema,
  stateValueSchema,
  StateRevisionConflictError,
  StateDocumentTooLargeError,
  StatePatchError,
  type StateWriter,
} from '@archon/workflows/state-document-store';
import { resolveCliUserId } from '../utils/cli-user';
import { writeJsonLine } from '../utils/stdout';

export class StateProjectResolutionError extends Error {}
export class StateStoreMismatchError extends Error {}
export interface StateCommandOptions {
  cwd: string;
  ifRevision?: string;
  limit?: string;
}

// Windows CI: `Bun.stdin.text()` on a piped stdin stayed pending without holding the
// event loop open, so the CLI exited 0 having written nothing. The Node stream keeps
// the pipe handle alive until EOF.
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

export async function stateCommand(
  host: Pick<WorkflowHost, 'deps' | 'records'>,
  subcommand: string | undefined,
  args: string[],
  options: StateCommandOptions,
  dependencies: {
    env?: NodeJS.ProcessEnv;
    readInput?: () => Promise<string>;
    write?: typeof writeJsonLine;
    storeKind?: string;
  } = {}
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const write = dependencies.write ?? writeJsonLine;
  const store = host.deps.store;
  const readInput = dependencies.readInput ?? readStdin;
  try {
    if (!subcommand || !['get', 'put', 'patch', 'log', 'delete'].includes(subcommand))
      throw new Error('Expected state get|put|patch|log|delete');
    if (args.length !== 1) throw new Error('Expected one document name');
    if (options.ifRevision !== undefined && !['put', 'delete'].includes(subcommand))
      throw new Error('--if-revision is only valid for put or delete');
    if (options.limit !== undefined && subcommand !== 'log')
      throw new Error('--limit is only valid for log');
    const name = stateDocumentNameSchema.parse(args[0]);
    const integer = (text: string): number => {
      if (!/^(0|[1-9][0-9]*)$/u.test(text)) throw new Error('Expected a nonnegative integer');
      return stateRevisionNumberSchema.parse(Number(text));
    };
    const ifRevision = options.ifRevision === undefined ? undefined : integer(options.ifRevision);

    const limit =
      options.limit === undefined
        ? undefined
        : z.number().int().positive().parse(integer(options.limit));
    let root: string;
    let writer: StateWriter;
    if (env.WORKFLOW_ID) {
      const run = await store.getWorkflowRun(env.WORKFLOW_ID);
      if (!run)
        throw new StateStoreMismatchError(
          `The CLI opened a different store than the engine: ${dependencies.storeKind ?? 'database'} does not know WORKFLOW_ID ${env.WORKFLOW_ID}`
        );
      const codebase = run.codebase_id ? await store.getCodebase(run.codebase_id) : null;
      const resolved = resolveRunStorageRoot(run, codebase);
      if (!resolved)
        throw new StateProjectResolutionError('The run has no resolvable project root');
      root = resolved;
      let supplied: unknown = null;
      try {
        supplied = JSON.parse(env.ARCHON_NODE_EXECUTION || 'null');
      } catch {
        // Reported below with the same message as a missing identity.
      }
      const parsedIdentity = nodeExecutionMetadataSchema
        .pick({ runId: true, path: true })
        .safeParse(supplied);
      if (!parsedIdentity.success)
        throw new Error('WORKFLOW_ID requires ARCHON_NODE_EXECUTION as JSON with runId and path');
      const identity = parsedIdentity.data;
      if (identity.runId !== run.id)
        throw new Error('ARCHON_NODE_EXECUTION does not match WORKFLOW_ID');
      writer = { kind: 'run', runId: run.id, nodePath: identity.path };
    } else {
      if (env.ARCHON_NODE_EXECUTION) throw new Error('ARCHON_NODE_EXECUTION requires WORKFLOW_ID');
      const repoRoot = await git.findRepoRoot(options.cwd);
      let codebase = repoRoot
        ? await findCodebaseForCheckoutPath(repoRoot, host.records.codebases)
        : ((await host.records.codebases.findCodebaseByDefaultCwd(options.cwd)) ??
          (await host.records.codebases.findCodebaseByPathPrefix(options.cwd)));
      if (repoRoot && !codebase) {
        const registered = await registerRepository(host.records.codebases, repoRoot);
        codebase = await host.records.codebases.getCodebase(registered.codebaseId);
        if (!codebase)
          throw new StateProjectResolutionError('Registered project is missing from the store');
      }
      root = getProjectStoragePaths(
        resolveProjectStorageKey(codebase, repoRoot ?? options.cwd)
      ).root;
      const identity = resolveCliUserId(env);
      if (!identity) throw new Error('Set ARCHON_USER_ID (or USER) for operator attribution');
      writer = { kind: 'operator', identity };
    }
    const project = relative(getArchonWorkspacesPath(), root).split('\\').join('/');
    const input = { project, name, writer };
    let output: unknown;
    switch (subcommand) {
      case 'get': {
        const row = await store.getStateDocument(project, name);
        output = { name, revision: row?.revision ?? 0, value: row?.value ?? null };
        break;
      }
      case 'put': {
        if (ifRevision === undefined) throw new Error('put requires --if-revision');
        const value = stateValueSchema.parse(JSON.parse(await readInput()) as unknown);
        if (value === null) throw new StatePatchError(name, 0, 'Use delete for a tombstone');
        output = await store.putStateDocument({ ...input, value, ifRevision });
        break;
      }
      case 'patch': {
        const source = await readInput();
        let supplied: unknown;
        try {
          supplied = JSON.parse(source);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          throw new StatePatchError(name, 0, 'Invalid JSON patch input');
        }
        const parsed = statePatchSchema.pick({ ops: true }).strict().safeParse(supplied);
        if (!parsed.success)
          throw new StatePatchError(
            name,
            0,
            'Invalid patch; expected {ops:[set|remove|append]} with JSON Pointer paths'
          );
        output = await store.patchStateDocument({ ...input, ops: parsed.data.ops });
        break;
      }
      case 'delete':
        output = await store.deleteStateDocument({
          ...input,
          ...(ifRevision !== undefined ? { ifRevision } : {}),
        });
        break;
      case 'log':
        output = await store.listStateRevisions(
          project,
          name,
          limit === undefined ? {} : { limit }
        );
        break;
    }
    await write(output);
    return 0;
  } catch (error) {
    const code =
      error instanceof StateRevisionConflictError
        ? 3
        : error instanceof StateDocumentTooLargeError || error instanceof StatePatchError
          ? 4
          : 1;
    await write({
      ok: false,
      error:
        error instanceof z.ZodError
          ? 'Invalid state command arguments'
          : error instanceof SyntaxError
            ? 'Invalid JSON input'
            : error instanceof Error
              ? error.message
              : String(error),
      code,
    });
    return code;
  }
}

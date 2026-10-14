import { z } from '@hono/zod-openapi';
import {
  canonicalizeProjectPath,
  projectKeyForCodebase,
  projectKeyForStorageRoot,
  resolveRunStorageRoot,
} from '@archon/paths';
import type { WorkflowHost } from '@archon/core/workflows/host-store';
import { registerRepository } from '@archon/core/handlers/clone';
import { resolveCodebaseForPath } from '@archon/core/services/codebase-checkout-resolver';
import { nodeExecutionMetadataSchema } from '@archon/workflows/schemas/node-execution';
import {
  stateDocumentNameSchema,
  stateNamePrefixSchema,
  stateProjectKeySchema,
  stateRevisionNumberSchema,
  statePatchSchema,
  stateValueSchema,
  StateRevisionConflictError,
  StateDocumentTooLargeError,
  StatePatchError,
  type StateScope,
  type StateWriter,
} from '@archon/workflows/state-document-store';
import { writeJsonLine } from '../utils/stdout';

export class StateProjectResolutionError extends Error {}
export class StateStoreMismatchError extends Error {}
/** `get --raw` on a document whose value is not a string. */
export class StateValueNotTextError extends Error {}
export interface StateCommandOptions {
  cwd: string;
  ifRevision?: string;
  limit?: string;
  prefix?: string;
  /** Workspace-relative project key (`owner/repo`); outside a run only. */
  project?: string;
  install?: boolean;
  raw?: boolean;
}

// Scripts branch on these, never on message text.
const EXIT = { usage: 1, conflict: 3, invalid: 4, storeMismatch: 5 } as const;
const commands = ['get', 'put', 'patch', 'log', 'delete', 'list'] as const;

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
    writeRaw?: (text: string) => Promise<void>;
    storeKind?: string;
  } = {}
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const write = dependencies.write ?? writeJsonLine;
  const store = host.deps.store;
  const readInput = dependencies.readInput ?? readStdin;
  const writeRaw =
    dependencies.writeRaw ??
    (async (text: string): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(text, error => (error ? reject(error) : resolve()));
      });
    });
  try {
    const command = commands.find(candidate => candidate === subcommand);
    if (!command) throw new Error(`Expected state ${commands.join('|')}`);
    if (args.length !== (command === 'list' ? 0 : 1))
      throw new Error(
        command === 'list' ? 'state list takes no document name' : 'Expected one document name'
      );
    if (options.ifRevision !== undefined && !['put', 'patch', 'delete'].includes(command))
      throw new Error('--if-revision is only valid for put, patch or delete');
    if (options.limit !== undefined && command !== 'log')
      throw new Error('--limit is only valid for log');
    if (options.prefix !== undefined && command !== 'list')
      throw new Error('--prefix is only valid for list');
    if (options.raw && !['get', 'put'].includes(command))
      throw new Error('--raw is only valid for get or put');
    if (options.install && options.project !== undefined)
      throw new Error('Use --install or --project, not both');
    const name = command === 'list' ? '' : stateDocumentNameSchema.parse(args[0]);
    const prefix =
      options.prefix === undefined ? undefined : stateNamePrefixSchema.parse(options.prefix);
    const integer = (text: string): number => {
      if (!/^(0|[1-9][0-9]*)$/u.test(text)) throw new Error('Expected a nonnegative integer');
      return stateRevisionNumberSchema.parse(Number(text));
    };
    const ifRevision = options.ifRevision === undefined ? undefined : integer(options.ifRevision);

    const limit =
      options.limit === undefined
        ? undefined
        : z.number().int().positive().parse(integer(options.limit));
    let projectKey: string | undefined;
    let writer: StateWriter;
    if (env.WORKFLOW_ID) {
      // Inside a run a node reaches its own project or, explicitly, the install scope.
      if (options.project !== undefined)
        throw new Error('--project is only valid outside a run; a run writes to its own project');
      const run = await store.getWorkflowRun(env.WORKFLOW_ID);
      if (!run)
        throw new StateStoreMismatchError(
          `The CLI opened a different store than the engine: ${dependencies.storeKind ?? 'database'} does not know WORKFLOW_ID ${env.WORKFLOW_ID}`
        );
      const codebase = run.codebase_id ? await store.getCodebase(run.codebase_id) : null;
      const resolved = resolveRunStorageRoot(run, codebase);
      if (resolved) projectKey = projectKeyForStorageRoot(resolved);
      else if (!options.install)
        throw new StateProjectResolutionError('The run has no resolvable project root');
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
    } else if (options.project !== undefined || options.install) {
      if (env.ARCHON_NODE_EXECUTION) throw new Error('ARCHON_NODE_EXECUTION requires WORKFLOW_ID');
      if (options.project !== undefined) projectKey = stateProjectKeySchema.parse(options.project);
      writer = { kind: 'surface', via: 'cli' };
    } else {
      if (env.ARCHON_NODE_EXECUTION) throw new Error('ARCHON_NODE_EXECUTION requires WORKFLOW_ID');
      // Folder registration stores the canonical path (#2927), so look up the same
      // spelling: a symlinked or Windows 8.3 cwd would otherwise miss its project.
      const cwd = await canonicalizeProjectPath(options.cwd);
      let { codebase, repoRoot } = await resolveCodebaseForPath(cwd, host.records.codebases);
      if (repoRoot && !codebase) {
        const registered = await registerRepository(host.records.codebases, repoRoot);
        codebase = await host.records.codebases.getCodebase(registered.codebaseId);
        if (!codebase)
          throw new StateProjectResolutionError('Registered project is missing from the store');
      }
      projectKey = projectKeyForCodebase(codebase, repoRoot ?? cwd);
      writer = { kind: 'surface', via: 'cli' };
    }
    const scope: StateScope = options.install
      ? { kind: 'install' }
      : { kind: 'project', key: stateProjectKeySchema.parse(projectKey) };
    const input = { scope, name, writer };
    let output: unknown;
    switch (command) {
      case 'get': {
        const row = await store.getStateDocument(scope, name);
        if (options.raw) {
          if (typeof row?.value !== 'string')
            throw new StateValueNotTextError(`State document '${name}' has no text value`);
          await writeRaw(row.value);
          return 0;
        }
        if (row) {
          output = { scope, name, revision: row.revision, value: row.value };
          break;
        }
        // A deleted document's tombstone is the revision a recreating put must name.
        const [tombstone] = await store.listStateRevisions(scope, name, { limit: 1 });
        output = tombstone
          ? { scope, name, revision: tombstone.revision, value: null, deleted: true }
          : { scope, name, revision: 0, value: null };
        break;
      }
      case 'put': {
        if (ifRevision === undefined) throw new Error('put requires --if-revision');
        const source = await readInput();
        const value = options.raw ? source : stateValueSchema.parse(JSON.parse(source) as unknown);
        if (value === null) throw new StatePatchError(name, 0, 'Use delete for a tombstone');
        output = { scope, ...(await store.putStateDocument({ ...input, value, ifRevision })) };
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
        output = {
          scope,
          ...(await store.patchStateDocument({
            ...input,
            ops: parsed.data.ops,
            ...(ifRevision !== undefined ? { ifRevision } : {}),
          })),
        };
        break;
      }
      case 'delete':
        output = {
          scope,
          ...(await store.deleteStateDocument({
            ...input,
            ...(ifRevision !== undefined ? { ifRevision } : {}),
          })),
        };
        break;
      case 'log':
        output = {
          scope,
          name,
          revisions: await store.listStateRevisions(
            scope,
            name,
            limit === undefined ? {} : { limit }
          ),
        };
        break;
      case 'list':
        output = {
          scope,
          documents: await store.listStateDocuments(scope, prefix === undefined ? {} : { prefix }),
        };
        break;
    }
    await write(output);
    return 0;
  } catch (error) {
    const code =
      error instanceof StateRevisionConflictError
        ? EXIT.conflict
        : error instanceof StateDocumentTooLargeError ||
            error instanceof StatePatchError ||
            error instanceof StateValueNotTextError
          ? EXIT.invalid
          : error instanceof StateStoreMismatchError
            ? EXIT.storeMismatch
            : EXIT.usage;
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

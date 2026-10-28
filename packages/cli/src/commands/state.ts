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
  type stateWriteScopeSchema,
  StateRevisionConflictError,
  StateDocumentTooLargeError,
  StatePatchError,
  type IStateDocumentStore,
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
  values?: boolean;
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

type StateHost = Pick<WorkflowHost, 'deps' | 'records'>;
type StateCommand = (typeof commands)[number];
type StateInput = z.infer<typeof stateWriteScopeSchema>;

function validateStateOptions(command: StateCommand, options: StateCommandOptions): void {
  if (options.ifRevision !== undefined && !['put', 'patch', 'delete'].includes(command))
    throw new Error('--if-revision is only valid for put, patch or delete');
  if (options.limit !== undefined && command !== 'log')
    throw new Error('--limit is only valid for log');
  if (options.prefix !== undefined && command !== 'list')
    throw new Error('--prefix is only valid for list');
  if (options.values && command !== 'list') throw new Error('--values is only valid for list');
  if (options.raw && !['get', 'put'].includes(command))
    throw new Error('--raw is only valid for get or put');
  if (options.install && options.project !== undefined)
    throw new Error('Use --install or --project, not both');
}

function parseRevision(text: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(text)) throw new Error('Expected a nonnegative integer');
  return stateRevisionNumberSchema.parse(Number(text));
}

function parseStateArguments(
  subcommand: string | undefined,
  args: string[],
  options: StateCommandOptions
) {
  const command = commands.find(candidate => candidate === subcommand);
  if (!command) throw new Error(`Expected state ${commands.join('|')}`);
  if (args.length !== (command === 'list' ? 0 : 1))
    throw new Error(
      command === 'list' ? 'state list takes no document name' : 'Expected one document name'
    );
  validateStateOptions(command, options);
  const name = command === 'list' ? '' : stateDocumentNameSchema.parse(args[0]);
  const prefix =
    options.prefix === undefined ? undefined : stateNamePrefixSchema.parse(options.prefix);
  const ifRevision =
    options.ifRevision === undefined ? undefined : parseRevision(options.ifRevision);

  const limit =
    options.limit === undefined
      ? undefined
      : z.number().int().positive().parse(parseRevision(options.limit));
  return { command, name, prefix, ifRevision, limit };
}

function resolveRunWriter(runId: string, env: NodeJS.ProcessEnv): StateWriter {
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
  if (identity.runId !== runId) throw new Error('ARCHON_NODE_EXECUTION does not match WORKFLOW_ID');
  return { kind: 'run', runId, nodePath: identity.path };
}

async function resolveRunContext(
  store: StateHost['deps']['store'],
  runId: string,
  options: StateCommandOptions,
  env: NodeJS.ProcessEnv,
  storeKind: string | undefined
): Promise<{ projectKey: string | undefined; writer: StateWriter }> {
  let projectKey: string | undefined;
  // Inside a run a node reaches its own project or, explicitly, the install scope.
  if (options.project !== undefined)
    throw new Error('--project is only valid outside a run; a run writes to its own project');
  const run = await store.getWorkflowRun(runId);
  if (!run)
    throw new StateStoreMismatchError(
      `The CLI opened a different store than the engine: ${storeKind ?? 'database'} does not know WORKFLOW_ID ${env.WORKFLOW_ID}`
    );
  const codebase = run.codebase_id ? await store.getCodebase(run.codebase_id) : null;
  const resolved = resolveRunStorageRoot(run, codebase);
  if (resolved) projectKey = projectKeyForStorageRoot(resolved);
  else if (!options.install)
    throw new StateProjectResolutionError('The run has no resolvable project root');
  return { projectKey, writer: resolveRunWriter(run.id, env) };
}

async function resolveOperatorProjectKey(
  host: StateHost,
  options: StateCommandOptions
): Promise<string> {
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
  return projectKeyForCodebase(codebase, repoRoot ?? cwd);
}

async function resolveStateContext(
  host: StateHost,
  options: StateCommandOptions,
  env: NodeJS.ProcessEnv,
  storeKind: string | undefined
): Promise<{ scope: StateScope; writer: StateWriter }> {
  let projectKey: string | undefined;
  let writer: StateWriter;
  if (env.WORKFLOW_ID) {
    ({ projectKey, writer } = await resolveRunContext(
      host.deps.store,
      env.WORKFLOW_ID,
      options,
      env,
      storeKind
    ));
  } else {
    if (env.ARCHON_NODE_EXECUTION) throw new Error('ARCHON_NODE_EXECUTION requires WORKFLOW_ID');
    if (options.project !== undefined) projectKey = stateProjectKeySchema.parse(options.project);
    else if (!options.install) projectKey = await resolveOperatorProjectKey(host, options);
    writer = { kind: 'surface', via: 'cli' };
  }
  const scope: StateScope = options.install
    ? { kind: 'install' }
    : { kind: 'project', key: stateProjectKeySchema.parse(projectKey) };
  return { scope, writer };
}

async function getStateDocument(store: IStateDocumentStore, scope: StateScope, name: string) {
  const row = await store.getStateDocument(scope, name);
  if (row) return { scope, name, revision: row.revision, value: row.value };
  // A deleted document's tombstone is the revision a recreating put must name.
  const [tombstone] = await store.listStateRevisions(scope, name, { limit: 1 });
  return tombstone
    ? { scope, name, revision: tombstone.revision, value: null, deleted: true }
    : { scope, name, revision: 0, value: null };
}

async function putStateDocument(
  store: IStateDocumentStore,
  input: StateInput,
  ifRevision: number | undefined,
  raw: boolean | undefined,
  readInput: () => Promise<string>
) {
  const { scope, name } = input;
  if (ifRevision === undefined) throw new Error('put requires --if-revision');
  const source = await readInput();
  const value = raw ? source : stateValueSchema.parse(JSON.parse(source) as unknown);
  if (value === null) throw new StatePatchError(name, 0, 'Use delete for a tombstone');
  return { scope, ...(await store.putStateDocument({ ...input, value, ifRevision })) };
}

async function patchStateDocument(
  store: IStateDocumentStore,
  input: StateInput,
  ifRevision: number | undefined,
  readInput: () => Promise<string>
) {
  const { scope, name } = input;
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
  return {
    scope,
    ...(await store.patchStateDocument({
      ...input,
      ops: parsed.data.ops,
      ...(ifRevision !== undefined ? { ifRevision } : {}),
    })),
  };
}

async function executeStateCommand(
  store: IStateDocumentStore,
  input: StateInput,
  parsed: ReturnType<typeof parseStateArguments>,
  options: StateCommandOptions,
  readInput: () => Promise<string>
): Promise<object> {
  const { scope, name } = input;
  const { command, ifRevision, limit, prefix } = parsed;
  switch (command) {
    case 'get':
      return getStateDocument(store, scope, name);
    case 'put':
      return putStateDocument(store, input, ifRevision, options.raw, readInput);
    case 'patch':
      return patchStateDocument(store, input, ifRevision, readInput);
    case 'delete':
      return {
        scope,
        ...(await store.deleteStateDocument({
          ...input,
          ...(ifRevision !== undefined ? { ifRevision } : {}),
        })),
      };
    case 'log':
      return {
        scope,
        name,
        revisions: await store.listStateRevisions(
          scope,
          name,
          limit === undefined ? {} : { limit }
        ),
      };
    case 'list': {
      const filter = prefix === undefined ? {} : { prefix };
      return {
        scope,
        documents: options.values
          ? (await store.getStateDocuments(scope, filter)).map(row => ({
              name: row.name,
              revision: row.revision,
              value: row.value,
            }))
          : await store.listStateDocuments(scope, filter),
      };
    }
  }
  throw new Error(`Unhandled state subcommand: ${command satisfies never}`);
}

function stateErrorCode(error: unknown): number {
  if (error instanceof StateRevisionConflictError) return EXIT.conflict;
  if (
    error instanceof StateDocumentTooLargeError ||
    error instanceof StatePatchError ||
    error instanceof StateValueNotTextError
  )
    return EXIT.invalid;
  if (error instanceof StateStoreMismatchError) return EXIT.storeMismatch;
  return EXIT.usage;
}

function stateErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return 'Invalid state command arguments';
  if (error instanceof SyntaxError) return 'Invalid JSON input';
  return error instanceof Error ? error.message : String(error);
}

export async function stateCommand(
  host: StateHost,
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
    const parsed = parseStateArguments(subcommand, args, options);
    const context = await resolveStateContext(host, options, env, dependencies.storeKind);
    const input = { ...context, name: parsed.name };
    if (parsed.command === 'get' && options.raw) {
      const row = await store.getStateDocument(input.scope, input.name);
      if (typeof row?.value !== 'string')
        throw new StateValueNotTextError(`State document '${input.name}' has no text value`);
      await writeRaw(row.value);
    } else {
      await write(await executeStateCommand(store, input, parsed, options, readInput));
    }
    return 0;
  } catch (error) {
    const code = stateErrorCode(error);
    await write({ ok: false, error: stateErrorMessage(error), code });
    return code;
  }
}

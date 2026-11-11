/// <reference path="./archon-script.d.ts" />
/**
 * The script API: what a workflow `script:` node running under Bun imports as
 * `archon:script`. The host hands this file's text to the script's process, so it may
 * import only Node and Bun built-ins; its type imports are erased.
 *
 * It is a thin wrapper over the wire every runtime shares: `INPUTS_*` and the engine's
 * environment, JSON on stdout, exit codes, and the host CLI named by `ARCHON_CLI_COMMAND`.
 * A script in another language uses that wire directly.
 *
 * Every export here is public contract for workflow authors. The declaration beside
 * this file is the reviewed record of that surface: it carries these signatures and the
 * contract types they use. Run `bun run generate:script-api-types` after a change.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ForgeFailure,
  ForgeOperations,
  NodeOutcomesListing,
  StartDisposition,
  StateClaimResult,
  StateConflict,
  StateDocumentSummary,
  StateLease,
  StatePatchOp,
  StateRevision,
} from 'archon:script';

function engineEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '')
    throw new Error(`${name} is not set; the engine supplies it to the script nodes that have one`);
  return value;
}

/**
 * A `with:` binding or workflow input by its declared name, as text; empty when nothing
 * bound it. Pass the name as a string literal: the load-time check that every input a
 * script reads is provided sees only `input('<name>')` written out in the node's own script.
 */
export function input(name: string): string {
  return process.env[`INPUTS_${name.replace(/-/g, '_').toUpperCase()}`] ?? '';
}

/** This run's id. */
export function runId(): string {
  return engineEnv('WORKFLOW_ID');
}

/** This run's artifact directory. */
export function artifactsDir(): string {
  return engineEnv('ARTIFACTS_DIR');
}

/** The directory of the pack the running workflow belongs to. Throws outside a pack. */
export function packDir(): string {
  return engineEnv('PACK_DIR');
}

/** The node's result: one JSON document on stdout. Call it once. */
export function emit(value: unknown): void {
  console.log(JSON.stringify(value));
}

/**
 * The node's refusal: the reason on stderr and exit code 1. Return after calling it.
 *
 * It sets the exit code instead of exiting, and a script must do the same: Bun's
 * `process.exit()` does not drain stdout, so a large result written to a pipe arrives
 * cut short and reads as a complete one.
 */
export function refuse(reason: string): void {
  console.error(reason);
  process.exitCode = 1;
}

/**
 * The host CLI gave no usable answer: it could not be started, or it exited without the
 * JSON its command prints. After a write, the write may or may not have happened.
 */
export class HostCommandError extends Error {
  constructor(
    /** The command without its arguments, such as `forge pr.view` or `state put`. */
    readonly command: string,
    readonly exitCode: number | null,
    detail: string
  ) {
    const what = exitCode === null ? 'could not run' : `failed (exit ${String(exitCode)})`;
    super(`archon ${command} ${what}${detail === '' ? '' : `: ${detail}`}`);
    this.name = 'HostCommandError';
  }
}

interface HostAnswer {
  readonly code: number | null;
  /** The JSON document on stdout; undefined when stdout held none. */
  readonly value: unknown;
  readonly stderr: string;
}

function archon(command: string, args: readonly string[], stdin?: string): HostAnswer {
  let argv: unknown;
  try {
    argv = JSON.parse(process.env.ARCHON_CLI_COMMAND ?? '');
  } catch {
    argv = undefined;
  }
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(part => typeof part === 'string'))
    throw new HostCommandError(
      command,
      null,
      'ARCHON_CLI_COMMAND is not a JSON string array; the host sets it for script nodes of a host run, and a container run does not receive it'
    );
  const run = Bun.spawnSync([...(argv as string[]), ...command.split(' '), ...args], {
    // Bun spawns with the environment the process started with unless given the live one.
    env: process.env,
    stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let value: unknown;
  try {
    value = JSON.parse(run.stdout.toString());
  } catch {
    value = undefined;
  }
  return { code: run.exitCode, value, stderr: run.stderr.toString().trim() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The host's own account of a failure: the `error` it printed, else its stderr. */
function failed(command: string, answer: HostAnswer): HostCommandError {
  const error = isRecord(answer.value) ? answer.value.error : undefined;
  return new HostCommandError(
    command,
    answer.code,
    typeof error === 'string' ? error : answer.stderr
  );
}

/** Runs `use` with a private file holding `value` as JSON, which keeps it out of every argv. */
function withJsonFile<T>(value: unknown, use: (path: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'archon-script-'));
  try {
    const path = join(directory, 'request.json');
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    return use(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * The host answered that a forge operation failed. `kind` is the typed reason. `mutation`
 * is set for a write and says whether it was refused, applied but unverified, or left
 * with an unknown outcome; never retry a write past an unknown outcome.
 */
export class ForgeError extends Error {
  readonly kind: ForgeFailure['error']['kind'];
  readonly mutation: ForgeFailure['mutation'];
  constructor(
    readonly op: keyof ForgeOperations,
    readonly failure: ForgeFailure
  ) {
    super(`forge ${op} ${failure.mutation?.outcome ?? 'failed'}: ${failure.error.message}`);
    this.name = 'ForgeError';
    this.kind = failure.error.kind;
    this.mutation = failure.mutation;
  }
}

/**
 * Run one forge operation through the host and return its result.
 *
 * Throws {@link ForgeError} when the host answers with a failure, and
 * {@link HostCommandError} when it gives no answer, in which case a write may or may not
 * have happened. The host validates the request and the result against the forge contract.
 */
export function forge<Op extends keyof ForgeOperations>(
  op: Op,
  request: ForgeOperations[Op]['request']
): ForgeOperations[Op]['result'] {
  const command = `forge ${op}`;
  const answer = withJsonFile(request, path => archon(command, ['--json', '--data-file', path]));
  const response = answer.value;
  if (!isRecord(response) || typeof response.ok !== 'boolean') throw failed(command, answer);
  if (!response.ok) throw new ForgeError(op, response as ForgeFailure);
  const result = response.result;
  if (!isRecord(result) || result.op !== op) throw failed(command, answer);
  // Exit 2 with a result: the operation completed and the host could not record it in
  // the run's audit log. Reporting a performed write as a failure would invite a retry.
  if (answer.code === 2)
    console.error(
      `forge ${op} completed, but the host could not record it in the run's audit log.`
    );
  else if (answer.code !== 0) throw failed(command, answer);
  return result.value as ForgeOperations[Op]['result'];
}

/** A state document as a read reports it. `revision` is 0 for a name never written. */
export interface StateDocument {
  readonly name: string;
  readonly revision: number;
  /** Null for a deleted or never-written document. */
  readonly value: unknown;
  readonly lease: StateLease | null;
  /** Present on `get` of a deleted document, whose `revision` a recreating put must name. */
  readonly deleted?: true;
}

/** A write's outcome: the revision it made, or why the store refused it without writing. */
export type StateWrite =
  | { readonly ok: true; readonly revision: StateRevision }
  | { readonly ok: false; readonly conflict: StateConflict };

export interface StateWriteOptions {
  /** Refuse the write unless the document is at this revision. */
  readonly ifRevision?: number;
  /** Take the document's lease for this run, or give it back, in the same write. */
  readonly lease?: 'take' | 'release';
  /** Refuse the write unless this run holds the document's live lease. */
  readonly held?: boolean;
}

function stateWrite(command: string, args: readonly string[], stdin?: string): StateWrite {
  const answer = archon(command, args, stdin);
  if (answer.code === 0 && isRecord(answer.value))
    return { ok: true, revision: answer.value as StateRevision };
  // Exit 3 is the store refusing the write; `reason` says which condition did.
  const reason = isRecord(answer.value) ? answer.value.reason : undefined;
  if (answer.code === 3 && typeof reason === 'string')
    return { ok: false, conflict: reason as StateConflict };
  throw failed(command, answer);
}

function writeFlags(options: StateWriteOptions): string[] {
  return [
    ...(options.ifRevision === undefined ? [] : ['--if-revision', String(options.ifRevision)]),
    ...(options.lease === 'take' ? ['--lease'] : []),
    ...(options.lease === 'release' ? ['--release-lease'] : []),
    ...(options.held ? ['--held'] : []),
  ];
}

function stateRead(command: string, args: readonly string[], field?: string): unknown {
  const answer = archon(command, args);
  if (answer.code !== 0 || !isRecord(answer.value)) throw failed(command, answer);
  return field === undefined ? answer.value : answer.value[field];
}

function prefixFlag(prefix: string | undefined): string[] {
  return prefix === undefined ? [] : ['--prefix', prefix];
}

/** The project's state documents (`archon state`), written as this run and node. */
export const state = {
  get(name: string): StateDocument {
    return stateRead('state get', [name]) as StateDocument;
  },
  /** Replace the document. `ifRevision` is required: 0 creates it. */
  put(
    name: string,
    value: unknown,
    options: StateWriteOptions & { readonly ifRevision: number }
  ): StateWrite {
    return stateWrite('state put', [name, ...writeFlags(options)], JSON.stringify(value));
  },
  /** Apply `set`, `remove` and `append` operations; without `ifRevision`, to the latest revision. */
  patch(name: string, ops: readonly StatePatchOp[], options: StateWriteOptions = {}): StateWrite {
    return stateWrite('state patch', [name, ...writeFlags(options)], JSON.stringify({ ops }));
  },
  delete(name: string, options: Pick<StateWriteOptions, 'ifRevision' | 'held'> = {}): StateWrite {
    return stateWrite('state delete', [name, ...writeFlags(options)]);
  },
  /** Every document under the prefix, without values. Includes deleted documents. */
  list(prefix?: string): StateDocumentSummary[] {
    return stateRead('state list', prefixFlag(prefix), 'documents') as StateDocumentSummary[];
  },
  /** Every live document under the prefix with its value, in one read. */
  listValues(prefix?: string): StateDocument[] {
    return stateRead(
      'state list',
      [...prefixFlag(prefix), '--values'],
      'documents'
    ) as StateDocument[];
  },
  /**
   * Take the lease of the first candidate whose revision still matches and whose lease
   * is free, ended or this run's own. `claimed` is null when none could be taken;
   * `skipped` says why each earlier candidate was passed over.
   */
  claim(
    candidates: readonly { readonly name: string; readonly ifRevision: number }[]
  ): StateClaimResult {
    const answer = archon('state claim', [], JSON.stringify(candidates));
    // Exit 2 is "nothing claimable", an answer with its own code.
    if ((answer.code !== 0 && answer.code !== 2) || !isRecord(answer.value))
      throw failed('state claim', answer);
    return answer.value as StateClaimResult;
  },
};

/**
 * What every node of this run has recorded so far (`$NODE_OUTCOMES_FILE`), as the engine
 * listed it when this node started.
 */
export function outcomes(): NodeOutcomesListing {
  return JSON.parse(readFileSync(engineEnv('NODE_OUTCOMES_FILE'), 'utf8')) as NodeOutcomesListing;
}

/**
 * Tell whoever watches the attention stream what this run did (`archon workflow notice`):
 * one short line, with labels a reader filters and counts by. It asks nothing of anyone:
 * the run does not pause and nobody can answer. Emit one when something real happened,
 * not for a pass that found nothing to do. Throws `HostCommandError` when the host
 * refuses it: text over the length bound or with a line break, or a run past its notice limit.
 */
export function notice(text: string, labels: Readonly<Record<string, string>> = {}): void {
  const pairs = Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
  // After `--`, so text that starts with a dash is not read as a flag.
  const answer = archon('workflow notice', ['--json', ...pairs, '--', text]);
  if (answer.code !== 0) throw failed('workflow notice', answer);
}

export interface TriggerFireOptions {
  /** One delivery id starts at most one run; build it from values a retry repeats. */
  readonly deliveryId?: string;
}

/** A fire's receipt and the admission its binding's request got; null when it got none. */
export interface TriggerFired {
  readonly receiptId: string;
  readonly disposition: StartDisposition | null;
}

export const trigger = {
  /**
   * Fire a trigger binding (`archon trigger fire`): `binding` is the binding's config
   * file, `inputs` its event inputs. The run starts under the binding's resource,
   * capacity and overlap policy, and records this run and node as its source.
   */
  fire(
    binding: string,
    inputs: Readonly<Record<string, unknown>> = {},
    options: TriggerFireOptions = {}
  ): TriggerFired {
    // Stable key order: a delivery's receipt digest covers the inputs as written.
    const sorted = Object.fromEntries(
      Object.entries(inputs).sort(([left], [right]) => (left < right ? -1 : 1))
    );
    const delivery = options.deliveryId === undefined ? [] : ['--delivery-id', options.deliveryId];
    const answer = withJsonFile(sorted, path =>
      archon('trigger fire', ['--config', binding, ...delivery, '--inputs', path])
    );
    const receipt = answer.value;
    if (answer.code !== 0 || !isRecord(receipt) || typeof receipt.id !== 'string')
      throw failed('trigger fire', answer);
    const fired: unknown = Array.isArray(receipt.bindings) ? receipt.bindings[0] : undefined;
    const disposition = isRecord(fired) && isRecord(fired.disposition) ? fired.disposition : null;
    return { receiptId: receipt.id, disposition: disposition as StartDisposition | null };
  },
};

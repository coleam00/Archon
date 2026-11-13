/**
 * The Archon CLI, reached from inside a run.
 *
 * Every exec node receives the CLI's argv as the JSON string array in
 * `ARCHON_CLI_COMMAND`. Invoking that, instead of assuming `archon` is on PATH, keeps a
 * write attributed to this run and refuses a store that does not know it (exit 5).
 * God mode's memory lives in state documents written this way, so the engine's audit
 * log records which run and node changed what the system believes.
 */

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function cliArgv(): string[] {
  const raw = process.env.ARCHON_CLI_COMMAND;
  if (raw === undefined || raw.trim() === '') {
    throw new Error('ARCHON_CLI_COMMAND is empty: god mode needs a host-side node (not a container run)');
  }
  const argv = JSON.parse(raw) as unknown;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string')) {
    throw new Error('ARCHON_CLI_COMMAND is not a non-empty JSON string array');
  }
  return argv as string[];
}

export function cli(args: string[], stdin?: string): CliResult {
  const proc = Bun.spawnSync([...cliArgv(), ...args], {
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** Run the CLI and parse its JSON answer, failing with the CLI's own evidence. */
export function cliJson(args: string[], stdin?: string): unknown {
  const result = cli(args, stdin);
  if (result.code !== 0) {
    throw new Error(`archon ${args.join(' ')} exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return JSON.parse(result.stdout) as unknown;
}

export interface StateDoc<T> {
  revision: number;
  value: T | null;
}

export function stateGet<T>(name: string): StateDoc<T> {
  const doc = cliJson(['state', 'get', name]) as { revision: number; value: T | null };
  return { revision: doc.revision, value: doc.value };
}

export type PatchOp =
  | { op: 'set'; path: string; value: unknown }
  | { op: 'append'; path: string; value: unknown }
  | { op: 'remove'; path: string };

export function statePatch(name: string, ops: PatchOp[], ifRevision?: number): void {
  const args = ['state', 'patch', name];
  if (ifRevision !== undefined) args.push('--if-revision', String(ifRevision));
  cliJson(args, JSON.stringify({ ops }));
}

/** Replace a whole document, guarded by the revision it was computed from. */
export function statePut(name: string, value: unknown, ifRevision: number): void {
  cliJson(['state', 'put', name, '--if-revision', String(ifRevision)], JSON.stringify(value));
}

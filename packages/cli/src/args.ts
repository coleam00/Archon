import type { ParseArgsConfig } from 'util';

type CliArgOptions = NonNullable<ParseArgsConfig['options']>;

// The single options map for the top-level CLI parse. Kept in its own module
// so tests can import it without executing cli.ts (whose import runs main).
export const cliArgOptions: CliArgOptions = {
  cwd: { type: 'string', default: process.cwd() },
  help: { type: 'boolean', short: 'h' },
  branch: { type: 'string', short: 'b' },
  from: { type: 'string' },
  'from-branch': { type: 'string' },
  base: { type: 'string' },
  'workflow-source': { type: 'string' },
  'no-worktree': { type: 'boolean' },
  folder: { type: 'boolean' },
  container: { type: 'boolean' },
  resume: { type: 'boolean' },
  // Between-run continuation (#2747). Run-id only — no name-based newest-wins.
  adopt: { type: 'string' },
  supersedes: { type: 'string' },
  open: { type: 'boolean' },
  spawn: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  verbose: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' },
  events: { type: 'boolean' },
  'run-id': { type: 'string' },
  type: { type: 'string' },
  data: { type: 'string' },
  comment: { type: 'string' },
  reason: { type: 'string' },
  text: { type: 'string' },
  port: { type: 'string' },
  'download-only': { type: 'boolean' },
  scope: { type: 'string' },
  node: { type: 'string' },
  yes: { type: 'boolean' },
  force: { type: 'boolean' },
  merged: { type: 'boolean' },
  'include-closed': { type: 'boolean' },
  'conversation-id': { type: 'string' },
  detach: { type: 'boolean' },
  all: { type: 'boolean' },
  status: { type: 'string' },
  limit: { type: 'string' },
  timeout: { type: 'string' },
  follow: { type: 'boolean' },
  effort: { type: 'string' },
  full: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  stubs: { type: 'string' },
  'stubs-init': { type: 'string' },
  'default-stubs': { type: 'boolean' },
  'exec-code': { type: 'boolean' },
  'pause-at-gates': { type: 'boolean' },
  // Repeatable: `--input a=1 --input b=2` yields ['a=1', 'b=2'] (#2554).
  input: { type: 'string', multiple: true },
  // Repeatable sparse tier/@alias rebinding for one workflow invocation (#2481).
  model: { type: 'string', multiple: true },
  config: { type: 'string' },
  // Private sealed handoff appended by the parent of a detached workflow run.
  'internal-detached-run-config': { type: 'string' },
  // Private handoff: the run row the detached parent created before forking (#2872).
  'internal-detached-run-id': { type: 'string' },
};

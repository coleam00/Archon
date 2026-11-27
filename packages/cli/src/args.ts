import type { ParseArgsConfig } from 'util';
import { CHAT_PROJECT_ID_ARG } from '@archon/paths/workflow-scope';

type CliArgOptions = NonNullable<ParseArgsConfig['options']>;

// The single options map for the top-level CLI parse. Kept in its own module
// so tests can import it without executing cli.ts (whose import runs main).
export const cliArgOptions: CliArgOptions = {
  [CHAT_PROJECT_ID_ARG]: { type: 'string' },
  cwd: { type: 'string', default: process.cwd() },
  help: { type: 'boolean', short: 'h' },
  branch: { type: 'string', short: 'b' },
  from: { type: 'string' },
  'from-branch': { type: 'string' },
  base: { type: 'string' },
  'base-branch': { type: 'string' },
  'workflow-source': { type: 'string' },
  'no-worktree': { type: 'boolean' },
  folder: { type: 'boolean' },
  container: { type: 'boolean' },
  // Between-run continuation (#2747). Run-id only — no name-based newest-wins.
  adopt: { type: 'string' },
  supersedes: { type: 'string' },
  open: { type: 'boolean' },
  spawn: { type: 'boolean' },
  providers: { type: 'string' },
  quiet: { type: 'boolean', short: 'q' },
  verbose: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' },
  throughput: { type: 'boolean' },
  events: { type: 'boolean' },
  watch: { type: 'boolean' },
  // `workflow wake --sources <file>`: the sources file for this process; the wake job passes it.
  sources: { type: 'string' },
  event: { type: 'string' },
  'resume-at': { type: 'string' },
  interval: { type: 'string' },
  'run-id': { type: 'string' },
  type: { type: 'string' },
  data: { type: 'string' },
  'data-file': { type: 'string' },
  comment: { type: 'string' },
  reason: { type: 'string' },
  text: { type: 'string' },
  occurrence: { type: 'string' },
  // Repeatable: `--choose a --choose b` answers a multi_select attention wait with both.
  choose: { type: 'string', multiple: true },
  // `workflow respond|answer --recommended`: answer with the option the wait recommends.
  recommended: { type: 'boolean' },
  // `workflow approve|reject|respond|answer --as <name>`: the name the answerer declares.
  as: { type: 'string' },
  // Repeatable attention-queue filters and label writes: `--label k=v`, `--set k=v`, `--unset k`.
  label: { type: 'string', multiple: true },
  set: { type: 'string', multiple: true },
  unset: { type: 'string', multiple: true },
  sort: { type: 'string' },
  'count-by': { type: 'string' },
  // `workflow attention --watch --protocol`: the full sync protocol, for programs.
  protocol: { type: 'boolean' },
  // `workflow attention --watch --notices`: also what happened to work nobody has to act on.
  notices: { type: 'boolean' },
  // `workflow attention --watch --after <cursor>`: replay the stream after an earlier line.
  after: { type: 'string' },
  port: { type: 'string' },
  'download-only': { type: 'boolean' },
  scope: { type: 'string' },
  node: { type: 'string' },
  yes: { type: 'boolean' },
  // `workflow cleanup --orphans`: list, or with --yes remove, files of runs with no row.
  orphans: { type: 'boolean' },
  force: { type: 'boolean' },
  merged: { type: 'boolean' },
  move: { type: 'boolean' },
  'include-closed': { type: 'boolean' },
  'conversation-id': { type: 'string' },
  detach: { type: 'boolean' },
  'no-wait': { type: 'boolean' },
  'no-item': { type: 'boolean' },
  // `trigger fire --priority`, and `workflow priority --clear`.
  priority: { type: 'boolean' },
  clear: { type: 'boolean' },
  all: { type: 'boolean' },
  status: { type: 'string' },
  limit: { type: 'string' },
  'if-revision': { type: 'string' },
  prefix: { type: 'string' },
  project: { type: 'string' },
  // `archon metrics` window, subject filter, cohort cut, model and dimension split.
  since: { type: 'string' },
  until: { type: 'string' },
  subject: { type: 'string' },
  compare: { type: 'string' },
  'by-model': { type: 'string' },
  'by-dimension': { type: 'string' },
  install: { type: 'boolean' },
  // `archon skill add --pack <id>`: install the skill an installed workflow pack ships.
  pack: { type: 'string' },
  raw: { type: 'boolean' },
  values: { type: 'boolean' },
  lease: { type: 'boolean' },
  'release-lease': { type: 'boolean' },
  held: { type: 'boolean' },
  timeout: { type: 'string' },
  follow: { type: 'boolean' },
  format: { type: 'string' },
  effort: { type: 'string' },
  full: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  // `archon workflow types`: compare instead of writing. `--out` is the file it writes,
  // and the directory `archon pack bindings` writes into.
  check: { type: 'boolean' },
  out: { type: 'string' },
  stubs: { type: 'string' },
  'stubs-init': { type: 'string' },
  'default-stubs': { type: 'boolean' },
  'exec-code': { type: 'boolean' },
  'pause-at-gates': { type: 'boolean' },
  // Repeatable: `--input a=1 --input b=2` yields ['a=1', 'b=2'] (#2554).
  input: { type: 'string', multiple: true },
  // Repeatable `name=path`: the input's value is the file's contents, read once at the
  // invocation gate.
  'input-file': { type: 'string', multiple: true },
  // Repeatable sparse tier/@alias rebinding for one workflow invocation (#2481).
  model: { type: 'string', multiple: true },
  binding: { type: 'string' },
  config: { type: 'string' },
  'config-from-run': { type: 'string' },
  host: { type: 'string' },
  'delivery-id': { type: 'string' },
  item: { type: 'string' },
  // `workflow cancel|abandon --item <key> --all-runs`: act on every matching run of the item.
  'all-runs': { type: 'boolean' },
  // `workflow runs --item-of <run-id>`: read the item a run belongs to; `workflow link`,
  // `merged` and `landing` write on it.
  'item-of': { type: 'string' },
  // `workflow rule --withdraw <ruling-id>` and `workflow answer --withdraw <ref>`.
  withdraw: { type: 'string' },
  // `workflow merged --change <ref> --at <ISO> --commit <sha>`: the merge the forge reported.
  change: { type: 'string' },
  at: { type: 'string' },
  commit: { type: 'string' },
  // `workflow link --item <key> --kind <kind> --to <key>`, or `workflow link --end <link-id>`.
  kind: { type: 'string' },
  to: { type: 'string' },
  end: { type: 'string' },
  // `workflow answer --ref <ref>`: answer an attention item by the ref the queue gives it.
  ref: { type: 'string' },
  inputs: { type: 'string' },
  owner: { type: 'string' },
  // `archon pack bindings`: the operator's choices a pack's binding declaration lacks. It
  // also reads `--out`, `--config` and `--workflow-source`, declared above.
  repo: { type: 'string' },
  'run-as': { type: 'string' },
  only: { type: 'string' },
  // Private sealed handoff appended by the parent of a detached workflow run.
  'internal-detached-run-config': { type: 'string' },
  // Private handoff: the run row the detached parent created before forking (#2872).
  'internal-detached-run-id': { type: 'string' },
  'internal-detached-worktree-identifier': { type: 'string' },
};

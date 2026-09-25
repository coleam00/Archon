/**
 * Deterministic guard: did this implement invocation produce work?
 *
 * An AI node that declines its task still exits 0, so without this check the stages
 * after implement would spend money or go public on nothing. It reads Archon-owned
 * facts only -- the engine's checkout observations and git objects -- never the
 * project's layout or toolchain.
 *
 * Three ways to pass, in order:
 * 1. New content: some path's content, mode, or type differs from where THIS implement
 *    invocation started (outside `.archon/`; see below). The start is the engine's own
 *    observation of the implement node's invocation, bound as `baseline`. Changes that
 *    were already in the checkout when it started are part of that start, so a dirty
 *    checkout the loop never touched does not pass. HEAD moving, staging, or an empty
 *    commit changes no content and does not pass either.
 * 2. Verified existing work: no new content, but the loop declared green AND the branch
 *    already carries commits ahead of the base branch -- a rerun that verified a fix a
 *    prior run committed is progress, not a decline.
 * 3. An honest decline on red the change did not cause: no new content, the loop is not
 *    green, and it declared that red `inherited` or `environment` with evidence in its
 *    summary. A correction round can genuinely have nothing left to edit -- the
 *    remaining break is in the base, or in configuration the run has no permission to
 *    change -- and demanding a change anyway asks for an invented one, or throws away
 *    the rounds that already landed. What such a claim is worth is the green gates'
 *    question, not this one; the tolerance lives here only so a change that cannot
 *    exist stops being required.
 *
 * Red the loop introduced still fails with nothing to show, and so does red it left
 * unexplained or unevidenced -- the same bar the green gates hold, because a cause
 * with no failing check named behind it is not a reason. A green claim with neither
 * new content nor a branch lead fails too.
 *
 * A loop that ended with its checks unfinished (`incomplete`) fails before any of
 * that is asked, whatever it changed: its work was never verified, and the green
 * gates refuse the same cause with the same message.
 *
 * Only UNCOMMITTED `.archon/` changes are excluded: Archon copies the operator's
 * workflow edits into every run worktree, so uncommitted `.archon/` files are not
 * implement's output. A `.archon/` path counts only when the current commit differs
 * from the start commit and the committed content differs from what the path held at
 * the start -- implement legitimately edits workflows, but committing bytes that were
 * already sitting in the checkout is not new work.
 *
 * Comparison: the engine records a start commit plus a manifest of only the paths that
 * differed from it, each identified by Git's blob id of its bytes (`hash-object`, clean
 * conversion applied), mode, and type. For every path that differs now or differed at
 * the start, the current identity (this node's own start observation, or the current
 * commit's tree) is compared with the starting identity (the start manifest, or the
 * start commit's tree). An observation that could not identify every path cannot prove
 * new work, and neither can a start that is not a Git checkout.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { artifactsDir, refuse, report, trimmed } from '../../.shared/io.ts';
import { PASSES_RED, passesRed, unfinishedValidation } from '../../.shared/verdict.ts';

/** A git read whose failure is a broken assumption, not a state to report on. */
function gitBytes(...args: string[]): Buffer {
  const result = Bun.spawnSync(['git', '--literal-pathspecs', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0] ?? ''} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout;
}

/** `undefined` when the ref does not resolve, which is an answer rather than a fault. */
function tryGit(...args: string[]): string | undefined {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
}

/** Commits this branch carries beyond the base, or `undefined` if neither ref resolves. */
function commitsAheadOfBase(base: string): { readonly ref: string; readonly ahead: number } | undefined {
  for (const ref of [`origin/${base}`, base]) {
    const ahead = tryGit('rev-list', '--count', `${ref}..HEAD`);
    if (ahead !== undefined) return { ref, ahead: Number.parseInt(ahead, 10) };
  }
  return undefined;
}

// --- The engine's checkout observation, as this consumer reads it --------------------
//
// The owning contract is the engine's `CheckoutObservation` schema. This pack cannot
// import engine code, so it reads only the fields it needs and rejects anything else
// as unreadable; a conformance test in the engine feeds real observations through this
// script so the two cannot drift silently.

/** A path's identity: absent, or a kind/mode/object id. Equality is identity. */
type Identity = { readonly kind: 'absent' } | { readonly kind: string; readonly mode: string; readonly oid: string };

interface Observed {
  readonly commit: string | null;
  /** Paths that differed from `commit` when sampled, keyed by raw path bytes (base64). */
  readonly dirty: ReadonlyMap<string, Identity>;
}

type Reading = { readonly observed: Observed } | { readonly unknown: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathKey(path: unknown): string | undefined {
  if (typeof path === 'string') return Buffer.from(path, 'utf8').toString('base64');
  if (isRecord(path) && typeof path.base64 === 'string') return path.base64;
  return undefined;
}

function readObservation(label: string, value: unknown, runId: string): Reading {
  if (!isRecord(value)) return { unknown: `${label} is not a checkout observation` };
  if (value.kind === 'not_git') return { unknown: `${label} was not a Git checkout` };
  if (value.kind === 'unavailable') {
    return { unknown: `${label} could not be observed (${String(value.reason)})` };
  }
  if (value.kind !== 'git' || !isRecord(value.worktree)) {
    return { unknown: `${label} is not a checkout observation this guard can read` };
  }
  const commit = value.commit;
  if (commit !== null && typeof commit !== 'string') return { unknown: `${label} has no commit` };
  const worktree = value.worktree;
  if (worktree.status === 'clean') return { observed: { commit, dirty: new Map() } };
  if (worktree.status !== 'dirty' || !isRecord(worktree.manifest)) {
    return { unknown: `${label} has an unreadable worktree state` };
  }
  const pointer = worktree.manifest.pointer;
  const digest = worktree.manifest.sha256;
  if (!isRecord(pointer) || typeof pointer.path !== 'string' || typeof digest !== 'string') {
    return { unknown: `${label} has no manifest reference` };
  }
  if (pointer.run_id !== runId) return { unknown: `${label} points at another run's manifest` };
  if (isAbsolute(pointer.path) || pointer.path.split(/[\\/]/).includes('..')) {
    return { unknown: `${label} has an unsafe manifest path` };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(artifactsDir(), pointer.path));
  } catch {
    return { unknown: `${label}'s manifest is missing` };
  }
  if (createHash('sha256').update(bytes).digest('hex') !== digest) {
    return { unknown: `${label}'s manifest does not match its recorded digest` };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { unknown: `${label}'s manifest is not JSON` };
  }
  if (!isRecord(manifest) || manifest.version !== 1 || !Array.isArray(manifest.entries)) {
    return { unknown: `${label}'s manifest has an unknown format` };
  }
  if (manifest.commit !== commit) return { unknown: `${label}'s manifest names another commit` };
  const dirty = new Map<string, Identity>();
  for (const entry of manifest.entries) {
    if (!isRecord(entry)) return { unknown: `${label}'s manifest has a malformed entry` };
    const key = pathKey(entry.path);
    if (key === undefined) return { unknown: `${label}'s manifest has a malformed path` };
    if (entry.kind === 'absent') {
      dirty.set(key, { kind: 'absent' });
    } else if ((entry.kind === 'file' || entry.kind === 'symlink') && typeof entry.blob === 'string') {
      dirty.set(key, { kind: entry.kind, mode: String(entry.mode), oid: entry.blob });
    } else if (entry.kind === 'gitlink' && typeof entry.commit === 'string') {
      dirty.set(key, { kind: 'gitlink', mode: '160000', oid: entry.commit });
    } else {
      return { unknown: `${label} could not identify every changed path` };
    }
  }
  return { observed: { commit, dirty } };
}

// --- Commit-side identities -----------------------------------------------------------

/** NUL-separated raw records. */
function splitNul(output: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    const stop = end === -1 ? output.length : end;
    if (stop > start) records.push(output.subarray(start, stop));
    start = stop + 1;
  }
  return records;
}

/** Paths whose tree entries differ between two commits (or every path of one). */
function committedPaths(from: string | null, to: string | null): string[] {
  if (from === to) return [];
  let listing: Buffer;
  if (from !== null && to !== null) {
    listing = gitBytes('diff-tree', '-r', '-z', '--no-renames', '--name-only', from, to);
  } else {
    // One side is an unborn branch: every path of the other commit differs.
    const only = from ?? to;
    if (only === null) return [];
    listing = gitBytes('ls-tree', '-r', '-z', '--name-only', only);
  }
  return splitNul(listing).map(path => path.toString('base64'));
}

/** Tree identities of the given paths in one commit; paths the tree lacks are absent. */
function treeIdentities(commit: string | null, keys: readonly string[]): Map<string, Identity> {
  const identities = new Map<string, Identity>(keys.map(key => [key, { kind: 'absent' }]));
  if (commit === null || keys.length === 0) return identities;
  // argv carries UTF-8 text; a non-UTF-8 path cannot be named there, so it cannot be
  // looked up and stays absent -- the observation already refused to identify such a
  // path as dirty, which keeps this from ever deciding equality on it.
  const names = keys
    .map(key => Buffer.from(key, 'base64'))
    .filter(raw => Buffer.from(raw.toString('utf8'), 'utf8').equals(raw))
    .map(raw => raw.toString('utf8'));
  for (let i = 0; i < names.length; i += 200) {
    const listing = gitBytes('ls-tree', '-r', '-z', commit, '--', ...names.slice(i, i + 200));
    for (const record of splitNul(listing)) {
      // "<mode> <type> <oid>\t<path>"
      const tab = record.indexOf(0x09);
      const [mode = '', type = '', oid = ''] = record.subarray(0, tab).toString('latin1').split(' ');
      const key = record.subarray(tab + 1).toString('base64');
      if (!identities.has(key)) continue;
      identities.set(key, {
        kind: type === 'commit' ? 'gitlink' : mode === '120000' ? 'symlink' : 'file',
        mode,
        oid,
      });
    }
  }
  return identities;
}

function same(a: Identity | undefined, b: Identity | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (!('oid' in a) || !('oid' in b)) return !('oid' in a) && !('oid' in b);
  return a.kind === b.kind && a.mode === b.mode && a.oid === b.oid;
}

const ARCHON_DIR = Buffer.from('.archon/', 'utf8');

/** How many paths' content differs from where the invocation started. */
function contentChanges(baseline: Observed, current: Observed): number {
  const keys = new Set<string>([
    ...baseline.dirty.keys(),
    ...current.dirty.keys(),
    ...committedPaths(baseline.commit, current.commit),
  ]);
  const all = [...keys];
  const startTree = treeIdentities(baseline.commit, all);
  const currentTree = treeIdentities(current.commit, all);
  let changed = 0;
  for (const key of all) {
    const start = baseline.dirty.get(key) ?? startTree.get(key);
    if (Buffer.from(key, 'base64').subarray(0, ARCHON_DIR.length).equals(ARCHON_DIR)) {
      // Only commits count here: the committed entry must have changed since the start,
      // and must differ from what the path held at the start -- so a new commit that
      // leaves a pre-existing uncommitted file alone, or commits its bytes as they were,
      // is not new work.
      const committed = currentTree.get(key);
      if (!same(committed, startTree.get(key)) && !same(committed, start)) changed++;
      continue;
    }
    const now = current.dirty.get(key) ?? currentTree.get(key);
    if (!same(now, start)) changed++;
  }
  return changed;
}

type Decision = { readonly shown: string } | { readonly refusal: string };

function decide(): Decision {
  // The loop's verdict, bound by the workflow (`with:`): green as canonical boolean
  // text ("true"/"false"), the declared cause of any red, and the summary that carries
  // the evidence for it. `baseline` is the implement invocation's checkout start.
  const green = trimmed(process.env.INPUTS_GREEN);
  // Certified at the loop's own node: `red_cause` is an enum on its output_format,
  // so the value here is a member or the empty string, never something to re-check.
  const declaredCause = trimmed(process.env.INPUTS_RED_CAUSE);
  const summary = trimmed(process.env.INPUTS_SUMMARY);
  const baselineText = trimmed(process.env.INPUTS_BASELINE);
  const executionText = trimmed(process.env.ARCHON_NODE_EXECUTION);
  if (declaredCause === 'incomplete') {
    return { refusal: unfinishedValidation('The implementation', summary) };
  }

  let unknownReason: string | undefined;
  let execution: unknown;
  try {
    execution = JSON.parse(executionText);
  } catch {
    execution = undefined;
  }
  let baselineValue: unknown;
  try {
    baselineValue = JSON.parse(baselineText);
  } catch {
    baselineValue = undefined;
  }
  const runId = isRecord(execution) && typeof execution.runId === 'string' ? execution.runId : '';
  const attempt = isRecord(execution) && isRecord(execution.attempt) ? execution.attempt : undefined;
  const baseline = readObservation('the implement start', baselineValue, runId);
  const current = readObservation('the current checkout', attempt?.checkoutStart, runId);
  if ('unknown' in baseline) unknownReason = baseline.unknown;
  else if ('unknown' in current) unknownReason = current.unknown;
  else {
    const changed = contentChanges(baseline.observed, current.observed);
    if (changed > 0) {
      return { shown: `${String(changed)} path(s) changed since this implement invocation started` };
    }
  }

  const base = process.env.BASE_BRANCH ?? '';
  if (green === 'true' && base !== '') {
    const lead = commitsAheadOfBase(base);
    if (lead !== undefined && lead.ahead > 0) {
      return {
        shown:
          'no new changes this run; verified existing work -- ' +
          `${lead.ahead} commit(s) ahead of ${lead.ref}`,
      };
    }
  }

  // Nothing to show, and nothing to do about it. The evidence bar is the green gates'
  // own: emptiness is all that is checked, because whether the prose names a real
  // failing check is the declaring agent's judgment and the reviewer's.
  if (green !== 'true' && passesRed(declaredCause) && summary !== '') {
    return {
      shown: `no new changes this run; the remaining red is declared ${declaredCause}, not introduced`,
    };
  }

  return {
    refusal:
      (unknownReason !== undefined
        ? `implement's new work cannot be established: ${unknownReason}. `
        : 'implement changed no content outside .archon/ since this invocation started ' +
          '(pre-existing uncommitted changes are part of that start), ') +
      'and the branch carries no verified work ahead of the base ' +
      `(green=${green || 'unknown'}, red_cause=${declaredCause || 'unknown'}).\n` +
      'Nothing to show is only acceptable on red the change did not cause -- declared ' +
      `${PASSES_RED.join(' or ')}, with the failing check named in the summary. Red the ` +
      'change introduced, red nobody explained, and a cause with no evidence behind it ' +
      'fail here rather than reporting success.',
  };
}

const decision = decide();
if ('shown' in decision) {
  report(decision.shown);
} else {
  refuse(decision.refusal);
}

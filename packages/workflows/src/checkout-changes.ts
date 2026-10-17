/**
 * Path-level delta between two recorded checkout observations (#3774).
 *
 * A path counts when its identity at the end (kind, mode, and Git object id) differs from
 * its identity at the start. Each side's identity is its observation's manifest entry when
 * the path was dirty then, and otherwise the entry in that observation's commit tree. So
 * the delta compares content, not activity: a dirty start the step left untouched, staging,
 * an empty commit, and committing bytes that were already dirty all change nothing.
 *
 * Only recorded facts are read: both observations, their manifests in the run's artifacts,
 * and the commits' trees. Nothing is observed again, so a resumed producer's persisted start
 * gives the same answer it would have live. What counts as new work stays with the consumer.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  checkoutPathBytes,
  encodePath,
  runGit,
  writeContentAddressed,
} from './checkout-observation';
import { ARTIFACT_POINTER_TYPE } from './schemas/artifact-pointer';
import {
  CHECKOUT_CHANGES_VERSION,
  checkoutManifestSchema,
  type CheckoutChanges,
  type CheckoutObservation,
} from './schemas/checkout-observation';

/** Engine-private home of delta manifests inside a run's artifacts directory. */
const CHANGES_DIR = '.archon/checkout-changes';
/** Paths per `ls-tree` call, keeping argv well under platform limits. */
const LS_TREE_BATCH = 200;

type Side = 'start' | 'end';
type Unknown = Extract<CheckoutChanges, { status: 'unknown' }>;

/** A path's identity. Two paths are equal exactly when their identities are. */
type Identity = { kind: 'absent' } | { kind: 'present'; mode: string; oid: string };

const ABSENT: Identity = { kind: 'absent' };

interface Observed {
  commit: string | null;
  /** Paths that differed from `commit` when sampled, keyed by raw path bytes (base64). */
  dirty: Map<string, Identity>;
}

function sameIdentity(a: Identity, b: Identity): boolean {
  if (a.kind === 'absent' || b.kind === 'absent') return a.kind === b.kind;
  return a.mode === b.mode && a.oid === b.oid;
}

/** A Git tree entry's identity; mode `000000` is how a raw diff names a missing side. */
function treeIdentity(mode: string, oid: string): Identity {
  return mode === '000000' ? ABSENT : { kind: 'present', mode, oid };
}

async function readObserved(
  observation: CheckoutObservation,
  side: Side,
  run: { runId: string; artifactsDir: string }
): Promise<Observed | Unknown> {
  if (observation.kind !== 'git') return { status: 'unknown', reason: observation.kind, side };
  const { worktree, commit } = observation;
  if (worktree.status === 'clean') return { commit, dirty: new Map() };
  if (worktree.content === 'incomplete') return { status: 'unknown', reason: 'incomplete', side };
  const unreadable: Unknown = { status: 'unknown', reason: 'manifest_unreadable', side };
  const { pointer, sha256 } = worktree.manifest;
  if (
    pointer.run_id !== run.runId ||
    isAbsolute(pointer.path) ||
    pointer.path.split(/[\\/]/).includes('..')
  ) {
    return unreadable;
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(join(run.artifactsDir, ...pointer.path.split('/')));
  } catch {
    return unreadable;
  }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) return unreadable;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return unreadable;
  }
  const manifest = checkoutManifestSchema.safeParse(parsed);
  if (!manifest.success || manifest.data.commit !== commit) return unreadable;
  const dirty = new Map<string, Identity>();
  for (const entry of manifest.data.entries) {
    const key = checkoutPathBytes(entry.path).toString('base64');
    switch (entry.kind) {
      case 'absent':
        dirty.set(key, ABSENT);
        break;
      case 'file':
      case 'symlink':
        dirty.set(key, { kind: 'present', mode: entry.mode, oid: entry.blob });
        break;
      case 'gitlink':
        dirty.set(key, { kind: 'present', mode: entry.mode, oid: entry.commit });
        break;
      case 'incomplete':
        // The recorded `content` already says so; a manifest that disagrees is not trusted.
        return { status: 'unknown', reason: 'incomplete', side };
    }
  }
  return { commit, dirty };
}

/** NUL-terminated raw records. */
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

interface TreeDelta {
  /** Both commits' identities for every path whose tree entry differs between them. */
  start: Map<string, Identity>;
  end: Map<string, Identity>;
}

/**
 * Tree entries that differ between the two commits, with both sides' identities, read
 * from raw output so paths stay byte-exact. An unborn side has no entries at all.
 */
async function diffTrees(
  cwd: string,
  from: string | null,
  to: string | null
): Promise<TreeDelta | undefined> {
  const delta: TreeDelta = { start: new Map(), end: new Map() };
  if (from === to) return delta;
  if (from !== null && to !== null) {
    const result = await runGit(cwd, ['diff-tree', '-r', '-z', '--no-renames', '--raw', from, to]);
    if (result.code !== 0) return undefined;
    // `:<old mode> <new mode> <old oid> <new oid> <status>` NUL `<path>` NUL
    const records = splitNul(result.stdout);
    for (let i = 0; i + 1 < records.length; i += 2) {
      const [oldMode = '', newMode = '', oldOid = '', newOid = ''] = (records[i] ?? Buffer.alloc(0))
        .toString('latin1')
        .slice(1)
        .split(' ');
      const key = (records[i + 1] ?? Buffer.alloc(0)).toString('base64');
      delta.start.set(key, treeIdentity(oldMode, oldOid));
      delta.end.set(key, treeIdentity(newMode, newOid));
    }
    return delta;
  }
  const only = (from ?? to) as string;
  const listing = await listTree(cwd, only, []);
  if (listing === undefined) return undefined;
  for (const [key, identity] of listing) {
    (from === null ? delta.end : delta.start).set(key, identity);
    (from === null ? delta.start : delta.end).set(key, ABSENT);
  }
  return delta;
}

/** `ls-tree -r` entries of one commit, limited to `names` when any are given. */
async function listTree(
  cwd: string,
  commit: string,
  names: readonly string[]
): Promise<Map<string, Identity> | undefined> {
  const identities = new Map<string, Identity>();
  const batches: (readonly string[])[] = [];
  if (names.length === 0) batches.push([]);
  for (let i = 0; i < names.length; i += LS_TREE_BATCH) {
    batches.push(names.slice(i, i + LS_TREE_BATCH));
  }
  for (const batch of batches) {
    const result = await runGit(cwd, [
      '--literal-pathspecs',
      'ls-tree',
      '-r',
      '-z',
      commit,
      ...(batch.length > 0 ? ['--', ...batch] : []),
    ]);
    if (result.code !== 0) return undefined;
    for (const record of splitNul(result.stdout)) {
      // `<mode> <type> <oid>` TAB `<path>`
      const tab = record.indexOf(0x09);
      const [mode = '', , oid = ''] = record.subarray(0, tab).toString('latin1').split(' ');
      identities.set(record.subarray(tab + 1).toString('base64'), treeIdentity(mode, oid));
    }
  }
  return identities;
}

/**
 * The delta from `start` to `end`, both observations of the checkout at `cwd` recorded in
 * this run. A non-empty delta writes its path list under the run's artifacts.
 */
export async function computeCheckoutChanges(
  cwd: string,
  start: CheckoutObservation,
  end: CheckoutObservation,
  run: { runId: string; artifactsDir: string }
): Promise<CheckoutChanges> {
  const from = await readObserved(start, 'start', run);
  if ('status' in from) return from;
  const to = await readObserved(end, 'end', run);
  if ('status' in to) return to;

  const trees = await diffTrees(cwd, from.commit, to.commit);
  if (trees === undefined) return { status: 'unknown', reason: 'git_failed' };
  // A dirty path whose tree entry is the same in both commits needs that one entry. Such a
  // path is UTF-8: an observation marks a non-UTF-8 dirty path incomplete, refused above.
  const sharedKeys = [...new Set([...from.dirty.keys(), ...to.dirty.keys()])].filter(
    key => !trees.start.has(key)
  );
  const sharedCommit = from.commit ?? to.commit;
  let shared = new Map<string, Identity>();
  if (sharedCommit !== null && sharedKeys.length > 0) {
    const listing = await listTree(
      cwd,
      sharedCommit,
      sharedKeys.map(key => Buffer.from(key, 'base64').toString('utf8'))
    );
    if (listing === undefined) return { status: 'unknown', reason: 'git_failed' };
    shared = listing;
  }

  const changed: Buffer[] = [];
  for (const key of new Set([...trees.start.keys(), ...sharedKeys])) {
    const before = from.dirty.get(key) ?? trees.start.get(key) ?? shared.get(key) ?? ABSENT;
    const after = to.dirty.get(key) ?? trees.end.get(key) ?? shared.get(key) ?? ABSENT;
    if (!sameIdentity(before, after)) changed.push(Buffer.from(key, 'base64'));
  }
  if (changed.length === 0) return { status: 'known', changed: 0 };
  changed.sort(Buffer.compare);
  const { relativePath, sha256 } = await writeContentAddressed(run.artifactsDir, CHANGES_DIR, {
    version: CHECKOUT_CHANGES_VERSION,
    paths: changed.map(encodePath),
  });
  return {
    status: 'known',
    changed: changed.length,
    manifest: {
      pointer: { type: ARTIFACT_POINTER_TYPE, run_id: run.runId, path: relativePath },
      sha256,
    },
  };
}

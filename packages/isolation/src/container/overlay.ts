/**
 * Overlay upperdir walk → change summary + write-back apply (container backend,
 * Phase C).
 *
 * By overlayfs construction the upper layer IS the diff relative to the read-only
 * lower (the live project root): every regular file in the upper is an add or a
 * modify, every whiteout is a delete. So computing the change set is a directory
 * WALK of the upperdir, not a tree comparison — this is why the container backend
 * uses overlay rather than copy-into-volume.
 *
 * The upper volume is only reachable through Docker (on macOS it lives inside the
 * Docker VM), so both operations run a short-lived `docker run --rm` helper on the
 * runner image (which has `bash`, `find`, `cp`, `rm`), NOT a running run-container.
 * That keeps the walk/apply independent of the run container's lifecycle (works
 * while it is stopped) and, crucially, makes APPLY the ONE place the live root is
 * ever written: the helper mounts the live root read-WRITE and rsync-style copies
 * the upper into it — nothing else in the system writes the live folder.
 *
 * Whiteout representations handled: native overlay char-devices (0,0) and
 * fuse-overlayfs `.wh.<name>` marker files. Native opaque-directory markers use an
 * xattr with no on-disk marker file, so a "replace an entire directory" op may not
 * fully apply on native mode — documented as a known limitation (rare for
 * folder-ops changes, which are file add/modify/delete).
 */

import type { OverlayChangeSummary, WriteBackApplySummary } from '@archon/providers/types';
import { createLogger } from '@archon/paths';
import type { DockerRunner } from './docker-exec';
import { extractDockerError } from './docker-exec';

const log = createLogger('isolation.overlay');

/** Cap on per-category file lists in the summary; `truncated`/`totalCount` carry the rest. */
const SUMMARY_ENTRY_CAP = 200;

/** overlayfs upperdir + workdir layout inside the per-run volume (see entrypoint.sh). */
const UPPER_DATA_SUBPATH = 'data';

export interface OverlayHelperTarget {
  /** The per-run upper volume name (`archon-<id>-upper`). */
  volume: string;
  /** The host project root — the overlay lower AND the write-back destination. */
  hostRoot: string;
  /** Runner image tag (has bash/find/cp/rm). */
  image: string;
}

/**
 * Walk the overlay upperdir and classify every change against the live root.
 *
 * Runs a read-only helper: the volume at `/upper` (upperdir = `/upper/data`) and
 * the live root at `/lower`, both `:ro`. Each upper entry is:
 *  - a `.wh.<name>` marker or char-device (0,0) → DELETE of the un-whited path,
 *  - a regular file/symlink present in the lower → MODIFY,
 *  - a regular file/symlink absent from the lower → ADD.
 * Records are NUL-delimited (`<TAG>\t<path>\0`) so paths with spaces/newlines
 * survive the round-trip.
 */
export async function summarizeOverlayChanges(
  docker: DockerRunner,
  target: OverlayHelperTarget
): Promise<OverlayChangeSummary> {
  const script = buildSummaryScript();
  let stdout: string;
  try {
    ({ stdout } = await docker([
      'run',
      '--rm',
      // Bypass the runner image ENTRYPOINT (the overlay-mount entrypoint that needs
      // ARCHON_WORKSPACE_PATH) — this helper only reads the volume, it does NOT mount
      // an overlay. Run our script directly under bash.
      '--entrypoint',
      'bash',
      '-v',
      `${target.volume}:/upper:ro`,
      '-v',
      `${target.hostRoot}:/lower:ro`,
      target.image,
      '-c',
      script,
    ]));
  } catch (err) {
    throw new Error(`Failed to inspect the overlay diff: ${extractDockerError(err)}`);
  }

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  let total = 0;
  for (const record of stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const tag = record.slice(0, tab);
    const path = record.slice(tab + 1);
    total++;
    if (tag === 'A') pushCapped(added, path);
    else if (tag === 'M') pushCapped(modified, path);
    else if (tag === 'D') pushCapped(deleted, path);
  }

  const listed = added.length + modified.length + deleted.length;
  return { added, modified, deleted, truncated: total > listed, totalCount: total };
}

/**
 * Apply the overlay diff onto the live project root — the ONE moment the live
 * root is written. Mounts the volume `:ro` at `/upper` and the live root `:rw` at
 * `/dest`; the helper copies adds/modifies in (preserving perms via `cp -a`) and
 * removes whiteouts. Fails LOUD on any per-file error (`set -e`) so a partial
 * apply throws with the records that landed rather than silently half-applying.
 */
export async function applyOverlayChanges(
  docker: DockerRunner,
  target: OverlayHelperTarget
): Promise<WriteBackApplySummary> {
  const script = buildApplyScript();
  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await docker([
      'run',
      '--rm',
      // Bypass the runner image ENTRYPOINT (see summarizeOverlayChanges) — this
      // helper mounts the live root read-WRITE and applies the diff, no overlay.
      '--entrypoint',
      'bash',
      '-v',
      `${target.volume}:/upper:ro`,
      '-v',
      `${target.hostRoot}:/dest`,
      target.image,
      '-c',
      script,
    ]));
  } catch (err) {
    // Partial apply: surface what the helper printed before it aborted so the
    // operator can see exactly what landed on the live root.
    const detail = extractDockerError(err);
    const partial = (err as { stdout?: string }).stdout ?? '';
    const landed = partial.split('\0').filter(Boolean).length;
    throw new Error(
      `Write-back apply failed partway (${landed} path(s) already applied to the live ` +
        `root — inspect and reconcile manually): ${detail}`
    );
  }

  let filesApplied = 0;
  let filesDeleted = 0;
  for (const record of stdout.split('\0')) {
    if (!record) continue;
    const tag = record.slice(0, record.indexOf('\t'));
    if (tag === 'W') filesApplied++;
    else if (tag === 'D') filesDeleted++;
  }
  const warnings = stderr.trim() ? stderr.trim().split('\n') : [];
  log.info({ filesApplied, filesDeleted, volume: target.volume }, 'isolation.overlay_applied');
  return { filesApplied, filesDeleted, warnings };
}

function pushCapped(list: string[], path: string): void {
  if (list.length < SUMMARY_ENTRY_CAP) list.push(path);
}

// The shell scripts below deliberately avoid every `${...}` brace expansion
// (using `basename`/`dirname`/`cut` instead) so they can live in a template
// literal without JS reading `${...}` as an interpolation — only `${` triggers
// interpolation; `$var`, `$(...)`, and `$UP` are inert.

/** Classify a whiteout marker/char-device/regular file. Shared summary+apply preamble. */
const CLASSIFY_PREAMBLE = `
  rel=$(printf '%s' "$p" | sed 's#^[.]/##')
  base=$(basename "$rel")
  dir=$(dirname "$rel")
  [ "$dir" = "." ] && dir=""`;

function buildSummaryScript(): string {
  // NUL-delimited records (<TAG>\\t<path>\\0); classify each upper entry vs /lower.
  return `
set -uo pipefail
UP=/upper/${UPPER_DATA_SUBPATH}
LO=/lower
[ -d "$UP" ] || exit 0
cd "$UP"
find . -mindepth 1 \\( -type f -o -type c -o -type l \\) -print0 2>/dev/null | while IFS= read -r -d '' p; do${CLASSIFY_PREAMBLE}
  case "$base" in
    .wh..wh..opq) continue ;;
    .wh.*)
      name=$(printf '%s' "$base" | cut -c5-)
      if [ -n "$dir" ]; then printf 'D\\t%s/%s\\0' "$dir" "$name"; else printf 'D\\t%s\\0' "$name"; fi
      continue ;;
  esac
  if [ -c "$UP/$rel" ]; then printf 'D\\t%s\\0' "$rel"
  elif [ -e "$LO/$rel" ]; then printf 'M\\t%s\\0' "$rel"
  else printf 'A\\t%s\\0' "$rel"; fi
done
`;
}

function buildApplyScript(): string {
  // Walk EVERYTHING (dirs too, to mkdir before files land); apply to /dest (rw).
  // `set -e` makes a failed cp/rm abort the whole helper → applyChanges throws.
  return `
set -euo pipefail
UP=/upper/${UPPER_DATA_SUBPATH}
DEST=/dest
[ -d "$UP" ] || exit 0
cd "$UP"
find . -mindepth 1 -print0 2>/dev/null | while IFS= read -r -d '' p; do${CLASSIFY_PREAMBLE}
  case "$base" in
    .wh..wh..opq) continue ;;
    .wh.*)
      name=$(printf '%s' "$base" | cut -c5-)
      if [ -n "$dir" ]; then rp="$dir/$name"; else rp="$name"; fi
      rm -rf "$DEST/$rp"
      printf 'D\\t%s\\0' "$rp"
      continue ;;
  esac
  if [ -d "$UP/$rel" ]; then
    mkdir -p "$DEST/$rel"
  elif [ -c "$UP/$rel" ]; then
    rm -rf "$DEST/$rel"
    printf 'D\\t%s\\0' "$rel"
  else
    if [ -n "$dir" ]; then mkdir -p "$DEST/$dir"; fi
    cp -a "$UP/$rel" "$DEST/$rel"
    printf 'W\\t%s\\0' "$rel"
  fi
done
`;
}

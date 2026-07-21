/**
 * Overlay upperdir walk → change summary + write-back apply (container backend,
 * Phase C).
 *
 * By overlayfs construction the upper layer IS the diff relative to the read-only
 * lower (the live project root): every regular file in the upper is an add or a
 * modify, every whiteout is a delete. So computing the change set is a directory
 * WALK of the upperdir, not a tree comparison.
 *
 * SECURITY — the apply is the ONE place the live root is written, and the overlay
 * contents are attacker-controlled (a compromised in-container agent). The walk
 * scripts are therefore hardened against adversarial overlays:
 *  - whiteout names are decoded and REJECTED when empty / `.` / `..` / containing a
 *    slash (a `.wh.` → empty name would `rm -rf` the parent; `.wh...` → `..`);
 *  - every write/delete target is confined under the destination via a
 *    parent-directory symlink guard (blocks dest-symlink traversal), with `set -f`
 *    (noglob) so malicious filenames can't glob-expand;
 *  - apply reproduces ONLY regular files, real directories, and in-project symlinks
 *    — block/char/fifo/socket special files are skipped (a planted device or a
 *    setuid binary must never land on the host);
 *  - reproduced files get their setuid/setgid/sticky bits stripped and are copied
 *    by CONTENTS ONLY (no `cp -a`, so ownership/xattrs — incl. `security.*` caps —
 *    are dropped);
 *  - symlinks whose target escapes the project root are REFUSED (a secret-exfil /
 *    foothold vector) and flagged in the summary so the approver sees them.
 * Both helper containers run with `--cap-drop ALL --network none --security-opt
 * no-new-privileges` as defense-in-depth around the script logic.
 *
 * The scripts are parameterized (`$1`=upperdir, `$2`=lower/dest, `$3`=project root)
 * and use only portable POSIX tools (no `stat -c` / `realpath -m`) so they run
 * identically in the debian runner image AND under `bash` in the unit tests.
 *
 * Known limitations (documented, not silently wrong): native-overlay OPAQUE
 * directory markers use an xattr with no on-disk marker file, so "replace an entire
 * directory" may not fully apply on native mode; overlay hardlinks are copied as
 * independent files (content amplification, not a correctness bug); the SIGKILL
 * grace on `docker stop` can under-report. See SECURITY.md.
 */

import type { OverlayChangeSummary, WriteBackApplySummary } from '@archon/providers/types';
import { createLogger } from '@archon/paths';
import type { DockerRunner } from './docker-exec';
import { extractDockerError } from './docker-exec';

const log = createLogger('isolation.overlay');

/** Cap on per-category file lists in the summary; `truncated`/`totalCount` carry the rest. */
const SUMMARY_ENTRY_CAP = 200;

/** overlayfs upperdir subpath inside the per-run volume (see entrypoint.sh). */
const UPPER_DATA_SUBPATH = 'data';

/**
 * Hardening flags applied to BOTH helper containers: no capabilities, no network,
 * and no privilege escalation — defense-in-depth so a bug in the walk script can't
 * be leveraged by the (attacker-controlled) overlay contents.
 */
const HELPER_HARDENING = [
  '--cap-drop',
  'ALL',
  '--network',
  'none',
  '--security-opt',
  'no-new-privileges',
] as const;

export interface OverlayHelperTarget {
  /** The per-run upper volume name (`archon-<id>-upper`). */
  volume: string;
  /** The host project root — the overlay lower AND the write-back destination. */
  hostRoot: string;
  /** Runner image tag (has bash + coreutils). */
  image: string;
}

/** A decoded record emitted by the walk scripts (`<TAG>\t<field>[\t<field>…]`). */
interface WalkRecord {
  tag: string;
  fields: string[];
}

function parseRecords(stdout: string): WalkRecord[] {
  const out: WalkRecord[] = [];
  for (const rec of stdout.split('\0')) {
    if (!rec) continue;
    const parts = rec.split('\t');
    const tag = parts[0];
    if (tag === undefined) continue;
    out.push({ tag, fields: parts.slice(1) });
  }
  return out;
}

/**
 * Walk the overlay upperdir and classify every change against the live root.
 * Read-only helper (volume + lower both `:ro`). See file header for the guards.
 */
export async function summarizeOverlayChanges(
  docker: DockerRunner,
  target: OverlayHelperTarget
): Promise<OverlayChangeSummary> {
  let stdout: string;
  try {
    ({ stdout } = await docker([
      'run',
      '--rm',
      ...HELPER_HARDENING,
      // Bypass the runner image ENTRYPOINT (the overlay-mount entrypoint that needs
      // ARCHON_WORKSPACE_PATH) — this helper only reads the volume, no overlay mount.
      '--entrypoint',
      'bash',
      '-v',
      `${target.volume}:/upper:ro`,
      '-v',
      `${target.hostRoot}:/lower:ro`,
      target.image,
      '-c',
      buildSummaryScript(),
      'archon-overlay',
      `/upper/${UPPER_DATA_SUBPATH}`,
      '/lower',
      target.hostRoot,
    ]));
  } catch (err) {
    throw new Error(`Failed to inspect the overlay diff: ${extractDockerError(err)}`);
  }

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const symlinks: { path: string; target: string; escapes: boolean }[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let total = 0;

  for (const { tag, fields } of parseRecords(stdout)) {
    const path = fields[0] ?? '';
    if (tag === 'A') {
      total++;
      pushCapped(added, path);
    } else if (tag === 'M') {
      total++;
      pushCapped(modified, path);
    } else if (tag === 'D') {
      total++;
      pushCapped(deleted, path);
    } else if (tag === 'L') {
      total++;
      const entry = { path, target: fields[1] ?? '', escapes: fields[2] === '1' };
      if (symlinks.length < SUMMARY_ENTRY_CAP) symlinks.push(entry);
    } else if (tag === 'S') {
      if (skipped.length < SUMMARY_ENTRY_CAP) {
        skipped.push({ path, reason: fields[1] ?? 'skipped' });
      }
    }
  }

  const listed = added.length + modified.length + deleted.length + symlinks.length;
  return {
    added,
    modified,
    deleted,
    symlinks,
    skipped,
    truncated: total > listed,
    totalCount: total,
  };
}

/**
 * Apply the overlay diff onto the live project root — the ONE moment the live root
 * is written. Mounts the volume `:ro` at `/upper` and the live root `:rw` at
 * `/dest`. Fails LOUD (non-zero exit) on any per-file error so a partial apply
 * throws with the records that landed rather than silently half-applying — and the
 * caller preserves the volume so nothing is lost.
 */
export async function applyOverlayChanges(
  docker: DockerRunner,
  target: OverlayHelperTarget
): Promise<WriteBackApplySummary> {
  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await docker([
      'run',
      '--rm',
      ...HELPER_HARDENING,
      '--entrypoint',
      'bash',
      '-v',
      `${target.volume}:/upper:ro`,
      '-v',
      `${target.hostRoot}:/dest`,
      target.image,
      '-c',
      buildApplyScript(),
      'archon-overlay',
      `/upper/${UPPER_DATA_SUBPATH}`,
      '/dest',
      target.hostRoot,
    ]));
  } catch (err) {
    const detail = extractDockerError(err);
    const partial = (err as { stdout?: string }).stdout ?? '';
    const landed = parseRecords(partial).filter(
      r => r.tag === 'W' || r.tag === 'K' || r.tag === 'D'
    ).length;
    throw new Error(
      `Write-back apply failed partway (${landed} path(s) already applied to the live ` +
        `root — inspect and reconcile manually): ${detail}`
    );
  }

  let filesApplied = 0;
  let filesDeleted = 0;
  const warnings: string[] = [];
  for (const { tag, fields } of parseRecords(stdout)) {
    if (tag === 'W' || tag === 'K') filesApplied++;
    else if (tag === 'D') filesDeleted++;
    else if (tag === 'S') warnings.push(`skipped ${fields[0] ?? ''}: ${fields[1] ?? 'refused'}`);
  }
  // The helper also prints refusals/skips to stderr for the operator log.
  if (stderr.trim()) warnings.push(...stderr.trim().split('\n'));
  log.info({ filesApplied, filesDeleted, volume: target.volume }, 'isolation.overlay_applied');
  return { filesApplied, filesDeleted, warnings };
}

function pushCapped(list: string[], path: string): void {
  if (list.length < SUMMARY_ENTRY_CAP) list.push(path);
}

// ---------------------------------------------------------------------------
// Shell scripts. Parameterized ($1=upperdir, $2=lower|dest, $3=project root) and
// portable (no `stat -c` / `realpath -m`) so they run in the runner image AND under
// bash in the unit tests. NUL-delimited, TAB-separated records. `set -f` disables
// globbing so adversarial filenames can't expand. NO `${…}` brace expansion (it
// would be read as a JS template interpolation) — basename/dirname/cut/ls are used.
// ---------------------------------------------------------------------------

/**
 * Shared classification + safety helpers, identical in the summary and apply
 * scripts so the summary faithfully predicts what apply does (M1).
 */
const SHELL_HELPERS = `
set -uf
UP="$1"; OTHER="$2"; WS="$3"

# Reject a decoded whiteout name that could escape or wipe: empty, '.'/'..', or
# containing a slash (defensive — a real basename can't, but never trust it).
valid_name() {
  case "$1" in
    ''|.|..) return 1 ;;
    */*) return 1 ;;
    *) return 0 ;;
  esac
}

# Confinement: every parent component of DEST/<rel> that already exists must be a
# REAL directory, never a symlink — blocks dest-symlink traversal. Returns 0 (safe)
# or 1 (refuse). Portable (test -L), no realpath.
safe_parent() {
  _rel="$1"; _cur="$2"; _oldifs="$IFS"; IFS='/'
  _parent="$(dirname "$_rel")"
  [ "$_parent" = "." ] && _parent=""
  for _seg in $_parent; do
    [ -z "$_seg" ] && continue
    case "$_seg" in .|..) IFS="$_oldifs"; return 1 ;; esac
    if [ -L "$_cur/$_seg" ]; then IFS="$_oldifs"; return 1; fi
    _cur="$_cur/$_seg"
  done
  IFS="$_oldifs"; return 0
}

# A char device is an overlay WHITEOUT iff its major,minor is 0,0. Parsed from
# 'ls -ln' (portable across GNU/BSD) rather than the GNU-only 'stat -c'.
is_whiteout_char() {
  _dm="$(ls -ln "$1" 2>/dev/null | awk 'NR==1{gsub(/,/,"",$5); print $5"_"$6}')"
  [ "$_dm" = "0_0" ]
}

# Does a symlink target escape the project root (WS)? Absolute targets are OK only
# under WS (the overlay mounts at the same absolute path); relative targets are OK
# only when they contain no '..' segment. Returns 0 = escapes, 1 = in-project.
symlink_escapes() {
  case "$1" in
    /*)
      case "$1/" in
        "$WS"/*) return 1 ;;
        *) return 0 ;;
      esac ;;
    *)
      case "/$1/" in
        */../*) return 0 ;;
        *) return 1 ;;
      esac ;;
  esac
}
`;

export function buildSummaryScript(): string {
  // Read-only: classify each upper entry vs OTHER (=lower). Emits A/M/D/L/S records.
  return `${SHELL_HELPERS}
[ -d "$UP" ] || exit 0
cd "$UP"
find . -mindepth 1 -print0 2>/dev/null | while IFS= read -r -d '' p; do
  rel="$(printf '%s' "$p" | sed 's#^[.]/##')"
  base="$(basename "$rel")"
  dir="$(dirname "$rel")"
  [ "$dir" = "." ] && dir=""

  # --- whiteout markers → deletion ---
  is_wh=0; whname=""
  case "$base" in
    .wh..wh..opq) printf 'S\\t%s\\topaque-dir-marker\\0' "$rel"; continue ;;
    .wh.*) is_wh=1; whname="$(printf '%s' "$base" | cut -c5-)" ;;
  esac
  if [ "$is_wh" = "0" ] && [ -c "$UP/$rel" ]; then
    if is_whiteout_char "$UP/$rel"; then is_wh=1; whname="$base"; else printf 'S\\t%s\\tspecial-char-device\\0' "$rel"; continue; fi
  fi
  if [ "$is_wh" = "1" ]; then
    if ! valid_name "$whname"; then printf 'S\\t%s\\tunsafe-whiteout-name\\0' "$rel"; continue; fi
    if [ -n "$dir" ]; then trel="$dir/$whname"; else trel="$whname"; fi
    printf 'D\\t%s\\0' "$trel"
    continue
  fi

  # --- symlink (check BEFORE -d/-f so a symlink-to-dir is not misclassified) ---
  if [ -L "$UP/$rel" ]; then
    ltarget="$(readlink "$UP/$rel")"
    if symlink_escapes "$ltarget"; then esc=1; else esc=0; fi
    printf 'L\\t%s\\t%s\\t%s\\0' "$rel" "$ltarget" "$esc"
    continue
  fi
  if [ -d "$UP/$rel" ]; then continue; fi   # directories are implied by their contents
  if [ -f "$UP/$rel" ]; then
    if [ -e "$OTHER/$rel" ]; then printf 'M\\t%s\\0' "$rel"; else printf 'A\\t%s\\0' "$rel"; fi
    continue
  fi
  printf 'S\\t%s\\tspecial-file\\0' "$rel"
done
`;
}

export function buildApplyScript(): string {
  // Writes to OTHER (=dest, rw). Fails loud (exit non-zero) on a genuine write error.
  return `${SHELL_HELPERS}
DEST="$OTHER"
[ -d "$UP" ] || exit 0
cd "$UP"
find . -mindepth 1 -print0 2>/dev/null | while IFS= read -r -d '' p; do
  rel="$(printf '%s' "$p" | sed 's#^[.]/##')"
  base="$(basename "$rel")"
  dir="$(dirname "$rel")"
  [ "$dir" = "." ] && dir=""

  # --- whiteout markers → deletion ---
  is_wh=0; whname=""
  case "$base" in
    .wh..wh..opq) printf 'S\\t%s\\topaque-dir-marker\\0' "$rel"; continue ;;
    .wh.*) is_wh=1; whname="$(printf '%s' "$base" | cut -c5-)" ;;
  esac
  if [ "$is_wh" = "0" ] && [ -c "$UP/$rel" ]; then
    if is_whiteout_char "$UP/$rel"; then is_wh=1; whname="$base"; else printf 'S\\t%s\\tspecial-char-device\\0' "$rel"; continue; fi
  fi
  if [ "$is_wh" = "1" ]; then
    if ! valid_name "$whname"; then printf 'S\\t%s\\tunsafe-whiteout-name\\0' "$rel"; continue; fi
    if [ -n "$dir" ]; then trel="$dir/$whname"; else trel="$whname"; fi
    if ! safe_parent "$trel" "$DEST"; then printf 'S\\t%s\\tescaping-delete\\0' "$trel"; continue; fi
    rm -rf "$DEST/$trel" || { printf 'ERR rm %s\\n' "$trel" >&2; exit 3; }
    printf 'D\\t%s\\0' "$trel"
    continue
  fi

  # --- symlink (check BEFORE -d/-f: a symlink-to-dir must not be treated as a dir) ---
  if [ -L "$UP/$rel" ]; then
    ltarget="$(readlink "$UP/$rel")"
    if symlink_escapes "$ltarget"; then printf 'S\\t%s\\tescaping-symlink\\0' "$rel"; continue; fi
    if ! safe_parent "$rel" "$DEST"; then printf 'S\\t%s\\tescaping-symlink-path\\0' "$rel"; continue; fi
    mkdir -p "$DEST/$dir" 2>/dev/null || true
    rm -rf "$DEST/$rel" || { printf 'ERR rm %s\\n' "$rel" >&2; exit 3; }
    ln -s "$ltarget" "$DEST/$rel" || { printf 'ERR ln %s\\n' "$rel" >&2; exit 3; }
    printf 'K\\t%s\\0' "$rel"
    continue
  fi
  if [ -d "$UP/$rel" ]; then
    if ! safe_parent "$rel" "$DEST"; then printf 'S\\t%s\\tescaping-dir\\0' "$rel"; continue; fi
    mkdir -p "$DEST/$rel" || { printf 'ERR mkdir %s\\n' "$rel" >&2; exit 3; }
    continue
  fi
  if [ -f "$UP/$rel" ]; then
    if ! safe_parent "$rel" "$DEST"; then printf 'S\\t%s\\tescaping-file\\0' "$rel"; continue; fi
    mkdir -p "$DEST/$dir" 2>/dev/null || true
    rm -rf "$DEST/$rel" || { printf 'ERR rm %s\\n' "$rel" >&2; exit 3; }
    cp "$UP/$rel" "$DEST/$rel" || { printf 'ERR cp %s\\n' "$rel" >&2; exit 3; }
    chmod u-s,g-s,o-t "$DEST/$rel" 2>/dev/null || true
    printf 'W\\t%s\\0' "$rel"
    continue
  fi
  printf 'S\\t%s\\tspecial-file\\0' "$rel"
done
`;
}

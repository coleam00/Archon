/**
 * Shell-level security tests: run the ACTUAL apply/summary bash scripts (the ones
 * shipped to the container) against a real temp dir via `bash -c`, with adversarial
 * overlay contents. These would FAIL on the pre-hardening scripts — they are the
 * regression guard for the C1/C2/M1/M4 findings.
 *
 * Portable subset (runs on macOS + Linux): whiteout-name traversal, setuid
 * stripping, special-file skip, symlink escape/representation, symlink-to-dir,
 * dest-symlink traversal. Char-device (0,0) whiteout detection needs `mknod` (root)
 * and is exercised by the live in-container malicious-overlay smoke instead.
 */
import { describe, test, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import { resolveBashPath } from '@archon/git';
import { trackTempRoots } from '@archon/paths/test-utils';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  existsSync,
  lstatSync,
  readlinkSync,
  chmodSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildApplyScript, buildSummaryScript } from './overlay';

// These scripts ONLY ever execute inside the Linux runner container in production.
// Git-Bash on Windows can't create real symlinks (`ln -s` copies) and MSYS mangles
// absolute paths (`/etc/shadow` → `/d/etc/shadow`), so the symlink/dest-traversal
// cases are skipped on win32 — environment reality, not test weakening. Every
// non-symlink case still runs on Windows.
const isWin = process.platform === 'win32';
// FIFO creation needs `mkfifo` (POSIX) — detected once so a missing tool is an
// explicit skip, never a silent pass (R2-F6).
const hasMkfifo = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v mkfifo'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// Resolved ONCE, via the same helper every production bash spawn uses. A bare
// `execFileSync('bash', …)` is the one thing this file must not do on Windows:
// CreateProcess searches System32 before PATH, so it resolves to the WSL
// launcher (`C:\Windows\System32\bash.exe`) rather than Git-Bash — the exact
// trap resolveBashPath() was written for (#1326). Resolving eagerly also keeps
// the per-test cost to the spawn itself.
const bashPath = resolveBashPath();

/** Run a walk script under bash; returns NUL-split records + raw stdout/stderr. */
function runScript(
  script: string,
  upper: string,
  other: string,
  ws: string
): { records: { tag: string; fields: string[] }[]; stdout: string; stderr: string; code: number } {
  let stdout = '';
  let stderr = '';
  let code = 0;
  try {
    stdout = execFileSync(bashPath, ['-c', script, 'archon-overlay', upper, other, ws], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    code = e.status ?? 1;
    stdout = (e.stdout ?? '').toString();
    stderr = (e.stderr ?? '').toString();
  }
  const records = stdout
    .split('\0')
    .filter(Boolean)
    .map(r => {
      const parts = r.split('\t');
      return { tag: parts[0] ?? '', fields: parts.slice(1) };
    });
  return { records, stdout, stderr, code };
}

// Cleanup used to be a trailing `rmSync` in each test body; the tracker reaps every root
// even when a test fails first, and retries against a bash/tar child that has exited but
// not yet released its handles (#2306).
const trackTempRoot = trackTempRoots();

/** Fresh {upper, dest} pair under a temp root; `data` is the overlay upperdir. */
function makeDirs(): { root: string; upper: string; dest: string; ws: string } {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'overlay-sec-')));
  const upper = join(root, 'upper', 'data');
  const dest = join(root, 'dest');
  mkdirSync(upper, { recursive: true });
  mkdirSync(dest, { recursive: true });
  return { root, upper, dest, ws: dest };
}

describe('apply script — C1 whiteout-name traversal', () => {
  test('`.wh.` (empty decoded name) does NOT wipe the parent dir', () => {
    const { upper, dest, ws } = makeDirs();
    mkdirSync(join(upper, 'subdir'), { recursive: true });
    writeFileSync(join(upper, 'subdir', '.wh.'), ''); // malicious: decodes to empty name
    mkdirSync(join(dest, 'subdir'), { recursive: true });
    writeFileSync(join(dest, 'subdir', 'keepme.txt'), 'precious');

    const { records } = runScript(buildApplyScript(), upper, dest, ws);
    expect(existsSync(join(dest, 'subdir', 'keepme.txt'))).toBe(true); // NOT wiped
    expect(records.some(r => r.tag === 'S' && r.fields[1] === 'unsafe-whiteout-name')).toBe(true);
  });

  test('`.wh...` (decoded name `..`) does NOT rm the parent-of-parent', () => {
    const { upper, dest, ws } = makeDirs();
    writeFileSync(join(upper, '.wh...'), ''); // decodes to '..'
    const canary = join(dest, 'canary.txt');
    writeFileSync(canary, 'alive');

    const { records } = runScript(buildApplyScript(), upper, dest, ws);
    expect(existsSync(canary)).toBe(true);
    expect(existsSync(dest)).toBe(true);
    expect(records.some(r => r.tag === 'S' && r.fields[1] === 'unsafe-whiteout-name')).toBe(true);
  });

  test('a legit `.wh.<name>` whiteout deletes exactly that file', () => {
    const { upper, dest, ws } = makeDirs();
    writeFileSync(join(upper, '.wh.gone.txt'), '');
    writeFileSync(join(dest, 'gone.txt'), 'bye');
    writeFileSync(join(dest, 'stay.txt'), 'keep');

    const { records } = runScript(buildApplyScript(), upper, dest, ws);
    expect(existsSync(join(dest, 'gone.txt'))).toBe(false);
    expect(existsSync(join(dest, 'stay.txt'))).toBe(true);
    expect(records.some(r => r.tag === 'D' && r.fields[0] === 'gone.txt')).toBe(true);
  });
});

// The rel/base/dir split uses shell parameter expansion rather than forking
// sed/basename/dirname per entry (#2558). Those are NOT drop-in equivalents, and
// the divergences all live in the path-splitting the traversal guards consume:
// `${rel%/*}` returns rel unchanged when there is no slash where `dirname` returns
// '.', and `${base#.wh.}` strips one prefix occurrence where `cut -c5-` strips
// four characters. Every pre-existing apply test that SUCCEEDS operates at the top
// level, so a wrong `dir` at depth would not have failed any of them. These do.
// These run on Windows wherever the fixture is portable there — that is where the
// fork cost was, so it is where the replacement most needs proving. Only the cases
// whose filenames cannot portably exist on win32 carry a skipIf, individually.
describe('apply script — rel/base/dir splitting', () => {
  test('a legit whiteout inside a subdirectory deletes exactly that nested file', () => {
    const { upper, dest, ws } = makeDirs();
    mkdirSync(join(upper, 'sub'), { recursive: true });
    writeFileSync(join(upper, 'sub', '.wh.gone.txt'), '');
    mkdirSync(join(dest, 'sub'), { recursive: true });
    writeFileSync(join(dest, 'sub', 'gone.txt'), 'bye');
    writeFileSync(join(dest, 'sub', 'stay.txt'), 'keep');
    writeFileSync(join(dest, 'gone.txt'), 'different file, same basename');

    const { records } = runScript(buildApplyScript(), upper, dest, ws);

    expect(existsSync(join(dest, 'sub', 'gone.txt'))).toBe(false);
    expect(existsSync(join(dest, 'sub', 'stay.txt'))).toBe(true);
    // The decisive assertion: a `dir` that came back empty would resolve the
    // target to top-level 'gone.txt' and delete the wrong file entirely.
    expect(existsSync(join(dest, 'gone.txt'))).toBe(true);
    expect(records.some(r => r.tag === 'D' && r.fields[0] === 'sub/gone.txt')).toBe(true);
  });

  // The expansions are not merely cheaper than the forks they replaced — they are
  // correct where the forks were not, and these two cases were live holes. Nothing
  // in the suite caught either, because the whole pre-PR implementation passes it.
  test.skipIf(isWin)('a whiteout name ending in a newline deletes THAT file, not its stem', () => {
    // `$(basename …)` strips trailing newlines, so `.wh.evil\n` used to decode to
    // `evil` and delete a different, innocent file — while `safe_parent` also
    // confined the wrong path. Skipped on win32 only because a trailing-newline
    // filename is not portably creatable there.
    const { upper, dest, ws } = makeDirs();
    writeFileSync(join(upper, '.wh.evil\n'), '');
    writeFileSync(join(dest, 'evil\n'), 'the real target');
    writeFileSync(join(dest, 'evil'), 'innocent bystander');

    const { records } = runScript(buildApplyScript(), upper, dest, ws);

    expect(existsSync(join(dest, 'evil\n'))).toBe(false);
    expect(existsSync(join(dest, 'evil'))).toBe(true);
    expect(records.some(r => r.tag === 'D' && r.fields[0] === 'evil\n')).toBe(true);
  });

  test('a whiteout under a `-`-prefixed directory still decodes instead of being copied', () => {
    // `basename "-d/.wh.foo"` treats the path as an option and exits 1 (BSD:
    // "illegal option -- d"; GNU: "invalid option -- 'd'"), so `base` came back
    // empty, the `.wh.*` arm never matched, and the marker was applied as an
    // ordinary FILE — planting a `.wh.foo` file in the live root instead of
    // deleting `foo`.
    const { upper, dest, ws } = makeDirs();
    mkdirSync(join(upper, '-d'), { recursive: true });
    writeFileSync(join(upper, '-d', '.wh.foo'), '');
    mkdirSync(join(dest, '-d'), { recursive: true });
    writeFileSync(join(dest, '-d', 'foo'), 'should be deleted');

    const { records } = runScript(buildApplyScript(), upper, dest, ws);

    expect(existsSync(join(dest, '-d', 'foo'))).toBe(false);
    // The marker itself must never land in the destination.
    expect(existsSync(join(dest, '-d', '.wh.foo'))).toBe(false);
    expect(records.some(r => r.tag === 'D' && r.fields[0] === '-d/foo')).toBe(true);
  });

  test('`.wh..wh.x` decodes to `.wh.x` — one prefix stripped, not four characters', () => {
    // cut -c5- and ${base#.wh.} agree here, and this pins that they keep agreeing.
    // The mutation it catches is `${base##*.wh.}`, which decodes to 'x' and deletes
    // the wrong entry. Note plain `##` is NOT the hazard: with a literal pattern
    // `${base##.wh.}` is byte-identical to `${base#.wh.}` — only adding the `*`
    // makes it greedy.
    const { upper, dest, ws } = makeDirs();
    writeFileSync(join(upper, '.wh..wh.x'), '');
    writeFileSync(join(dest, '.wh.x'), 'the real target');
    writeFileSync(join(dest, 'x'), 'must survive');

    const { records } = runScript(buildApplyScript(), upper, dest, ws);

    expect(existsSync(join(dest, '.wh.x'))).toBe(false);
    expect(existsSync(join(dest, 'x'))).toBe(true);
    expect(records.some(r => r.tag === 'D' && r.fields[0] === '.wh.x')).toBe(true);
  });
});

// The reviewer's through-line for this PR: every guard here exists in two
// hand-duplicated copies, and each fix landed with a test on exactly one of them, so
// the mirror copy stayed provably unpinned. These three close the remaining mutations
// that passed the whole suite green.
describe('apply script — guards pinned on the apply copy', () => {
  // R9: commit 3 tested the TAB guard only through the SUMMARY script, so deleting the
  // apply-side guard outright passed everything. Apply is the copy that writes.
  test.skipIf(isWin)('a TAB-bearing entry is refused by the APPLY script, not applied', () => {
    const { upper, dest, ws } = makeDirs();
    writeFileSync(join(upper, 'a\tb'), 'payload');

    const { records } = runScript(buildApplyScript(), upper, dest, ws);

    expect(records).toEqual([{ tag: 'S', fields: ['a?b', 'unsafe-record-name'] }]);
    // Nothing was written under either the real or the mangled name.
    expect(existsSync(join(dest, 'a\tb'))).toBe(false);
    expect(existsSync(join(dest, 'a?b'))).toBe(false);
  });

  // The apply-side mirror of the summary's TAB-target guard. Deleting that guard left
  // the whole suite green, which is this PR's own lesson reproduced inside its own
  // fix: a guard added to both copies but tested on one. The consequence is an M1
  // violation rather than an escape — `symlink_escapes` still catches real traversal
  // on the raw target — but it is the sharp kind. Measured with the guard removed, for
  // a target `foo<TAB>bar` that contains no `..`:
  //   summary → S x unsafe-record-target   (approver is told it was skipped)
  //   apply   → K x, symlink lands in the live root
  // i.e. the summary lies to the approver about what apply will do.
  test.skipIf(isWin)('a TAB in a symlink target is refused by the APPLY script too', () => {
    const { upper, dest, ws } = makeDirs();
    symlinkSync('foo\tbar', join(upper, 'x'));

    const { records } = runScript(buildApplyScript(), upper, dest, ws);

    expect(records).toEqual([{ tag: 'S', fields: ['x', 'unsafe-record-target'] }]);
    // Nothing reproduced into the destination under any spelling of the name.
    expect(existsSync(join(dest, 'x'))).toBe(false);
    let landed = true;
    try {
      lstatSync(join(dest, 'x'));
    } catch {
      landed = false;
    }
    expect(landed).toBe(false);
  });

  // R4: the newline fix had two halves and only the whiteout half was pinned. The
  // other half is safe_parent — `$(dirname)` stripped the trailing newline, so it
  // confined `$DEST/d` while the write went through `$DEST/d\n`. With a dest symlink
  // there, that write leaves the live root entirely AND is reported as applied.
  test.skipIf(isWin)(
    'a write cannot escape via a dest symlink whose name ends in a newline',
    () => {
      const { root, upper, dest, ws } = makeDirs();
      const outside = join(root, 'outside');
      mkdirSync(outside, { recursive: true });
      mkdirSync(join(upper, 'd\n'), { recursive: true });
      writeFileSync(join(upper, 'd\n', 'f.txt'), 'exfil');
      symlinkSync(outside, join(dest, 'd\n'));

      const { records } = runScript(buildApplyScript(), upper, dest, ws);

      // The decisive assertion: nothing reached the directory outside the root.
      expect(existsSync(join(outside, 'f.txt'))).toBe(false);
      // And it was refused rather than reported applied.
      expect(records.some(r => r.tag === 'W' && r.fields[0] === 'd\n/f.txt')).toBe(false);
    }
  );

  // R7: safe_parent's no-slash branch is observed by nothing. Dropping it makes
  // `_parent` equal the filename for a top-level entry, so the loop tests the entry
  // itself for symlink-ness and refuses a perfectly ordinary overwrite.
  test.skipIf(isWin)(
    'a top-level file whose dest counterpart is a symlink is still applied',
    () => {
      const { root, upper, dest, ws } = makeDirs();
      writeFileSync(join(upper, 'f.txt'), 'new content');
      writeFileSync(join(root, 'elsewhere.txt'), 'old');
      symlinkSync(join(root, 'elsewhere.txt'), join(dest, 'f.txt'));

      const { records } = runScript(buildApplyScript(), upper, dest, ws);

      expect(records.some(r => r.tag === 'W' && r.fields[0] === 'f.txt')).toBe(true);
      // Replaced as a real file, and the symlink's old target left untouched.
      expect(lstatSync(join(dest, 'f.txt')).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(root, 'elsewhere.txt'), 'utf8')).toBe('old');
    }
  );
});

describe('apply script — C2 special files + setuid', () => {
  test('setuid/setgid/sticky bits are stripped from applied files', () => {
    const { upper, dest, ws } = makeDirs();
    const src = join(upper, 'tool');
    writeFileSync(src, '#!/bin/sh\n');
    chmodSync(src, 0o6755); // setuid + setgid + rwxr-xr-x

    runScript(buildApplyScript(), upper, dest, ws);
    const applied = join(dest, 'tool');
    expect(existsSync(applied)).toBe(true);
    const mode = lstatSync(applied).mode;
    expect(mode & 0o4000).toBe(0); // no setuid
    expect(mode & 0o2000).toBe(0); // no setgid
    expect(mode & 0o1000).toBe(0); // no sticky
  });

  test.skipIf(!hasMkfifo)('a fifo (special file) is skipped, never reproduced on the host', () => {
    const { upper, dest, ws } = makeDirs();
    execFileSync('mkfifo', [join(upper, 'pipe')]);
    const { records } = runScript(buildApplyScript(), upper, dest, ws);
    expect(existsSync(join(dest, 'pipe'))).toBe(false);
    expect(records.some(r => r.tag === 'S' && r.fields[0] === 'pipe')).toBe(true);
  });
});

describe('apply script — M1/M4 symlinks', () => {
  test.skipIf(isWin)('a symlink whose target escapes the project root is REFUSED', () => {
    const { upper, dest, ws } = makeDirs();
    symlinkSync('/etc/passwd', join(upper, 'leak')); // absolute, outside ws
    const { records } = runScript(buildApplyScript(), upper, dest, ws);
    expect(existsSync(join(dest, 'leak'))).toBe(false);
    expect(records.some(r => r.tag === 'S' && r.fields[1] === 'escaping-symlink')).toBe(true);
  });

  test.skipIf(isWin)('a relative `..` symlink target is refused', () => {
    const { upper, dest, ws } = makeDirs();
    symlinkSync('../../../../etc/hosts', join(upper, 'up'));
    const { records } = runScript(buildApplyScript(), upper, dest, ws);
    expect(existsSync(join(dest, 'up'))).toBe(false);
    expect(records.some(r => r.tag === 'S' && r.fields[1] === 'escaping-symlink')).toBe(true);
  });

  test.skipIf(isWin)('an in-project relative symlink is reproduced as a symlink', () => {
    const { upper, dest, ws } = makeDirs();
    writeFileSync(join(upper, 'real.txt'), 'x');
    symlinkSync('real.txt', join(upper, 'link'));
    const { records } = runScript(buildApplyScript(), upper, dest, ws);
    expect(lstatSync(join(dest, 'link')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dest, 'link'))).toBe('real.txt');
    expect(records.some(r => r.tag === 'K' && r.fields[0] === 'link')).toBe(true);
  });

  test.skipIf(isWin)('M4: a symlink-to-dir is applied as a SYMLINK, not a real directory', () => {
    const { upper, dest, ws } = makeDirs();
    mkdirSync(join(upper, 'realdir'), { recursive: true });
    symlinkSync('realdir', join(upper, 'dirlink'));
    runScript(buildApplyScript(), upper, dest, ws);
    expect(lstatSync(join(dest, 'dirlink')).isSymbolicLink()).toBe(true);
  });
});

describe('apply script — dest-symlink traversal confinement', () => {
  test.skipIf(isWin)('a write through a pre-existing dest symlink parent is refused', () => {
    const { root, upper, dest, ws } = makeDirs();
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(dest, 'evil')); // dest/evil -> outside/
    mkdirSync(join(upper, 'evil'), { recursive: true });
    writeFileSync(join(upper, 'evil', 'pwned.txt'), 'x');

    const { records } = runScript(buildApplyScript(), upper, dest, ws);
    expect(existsSync(join(outside, 'pwned.txt'))).toBe(false); // did NOT traverse
    expect(records.some(r => r.tag === 'S' && r.fields[1] === 'escaping-file')).toBe(true);
  });
});

describe('summary script — faithful representation (M1)', () => {
  test.skipIf(isWin)('symlinks are shown with target + escape flag; specials flagged', () => {
    const { upper, dest, ws } = makeDirs();
    writeFileSync(join(upper, 'added.txt'), 'x');
    symlinkSync('/etc/shadow', join(upper, 'exfil')); // escaping
    symlinkSync('added.txt', join(upper, 'ok-link')); // in-project
    // dest has a matching file → modified classification for it
    writeFileSync(join(upper, 'mod.txt'), 'new');
    writeFileSync(join(dest, 'mod.txt'), 'old');

    const { records } = runScript(buildSummaryScript(), upper, dest, ws);
    const exfil = records.find(r => r.tag === 'L' && r.fields[0] === 'exfil');
    const okLink = records.find(r => r.tag === 'L' && r.fields[0] === 'ok-link');
    expect(exfil?.fields[1]).toBe('/etc/shadow');
    expect(exfil?.fields[2]).toBe('1'); // escapes
    expect(okLink?.fields[2]).toBe('0'); // in-project
    expect(records.some(r => r.tag === 'A' && r.fields[0] === 'added.txt')).toBe(true);
    expect(records.some(r => r.tag === 'M' && r.fields[0] === 'mod.txt')).toBe(true);
  });

  // The summary script carries its OWN copy of the rel/base/dir splitting, and
  // until this test nothing executed it: the case above is skipped on win32, sits
  // entirely at the top level, and contains no whiteout. Drift between the two
  // copies would therefore be invisible — and it is the summary that renders the
  // delete list a human approves, so a wrong `dir` there misinforms consent rather
  // than merely misapplying. No symlinks, so this runs everywhere.
  // Records are TAB-separated and decoded positionally, so a TAB in a filename used
  // to shift every later field: an escaping symlink was rendered to the approver
  // with its TARGET in the name slot and a path where the `escapes` flag belongs —
  // reaching the gate looking safe. Apply still refused it, so the exposure was
  // misinformed consent rather than over-apply, which is why it survived unnoticed.
  test.skipIf(isWin)('a TAB in a filename cannot forge the fields of a later record', () => {
    const { upper, dest, ws } = makeDirs();
    symlinkSync('/etc/shadow', join(upper, 'a\tb'));

    const { records } = runScript(buildSummaryScript(), upper, dest, ws);

    // The decisive property, and the only assertion here that fails pre-guard: the
    // entry is REFUSED by name, with the TAB rendered so the refusal itself decodes.
    // (Asserting merely that no `L … '0'` record exists passed before the guard too,
    // because the forged flag was a path rather than '0'.)
    expect(records).toEqual([{ tag: 'S', fields: ['a?b', 'unsafe-record-name'] }]);
  });

  // C1's mirror on the consent surface. The apply script's valid_name refusal is
  // pinned by two tests; the summary's call site was pinned by none — bypassing it
  // left the whole suite green. The failure is the inverse of an over-apply: apply
  // correctly refuses, while the summary tells the approver that `subdir` itself is
  // about to be deleted. A human asked to approve a deletion that will not happen is
  // being misinformed just as surely as one shown a deletion that will.
  test('the summary refuses an unsafe whiteout name rather than reporting a deletion', () => {
    const { upper, dest, ws } = makeDirs();
    mkdirSync(join(upper, 'subdir'), { recursive: true });
    writeFileSync(join(upper, 'subdir', '.wh.'), ''); // decodes to the empty name
    mkdirSync(join(dest, 'subdir'), { recursive: true });
    writeFileSync(join(dest, 'subdir', 'keepme.txt'), 'precious');

    const { records } = runScript(buildSummaryScript(), upper, dest, ws);

    expect(records.some(r => r.tag === 'S' && r.fields[1] === 'unsafe-whiteout-name')).toBe(true);
    // Nothing may be presented as a pending deletion — least of all the parent dir.
    expect(records.some(r => r.tag === 'D')).toBe(false);
  });

  // R6, second half: a TAB in the symlink TARGET forges the fields after it, so the
  // consumer reads a benign target and a PATH where the escape flag belongs. Measured
  // before the fix: ["L","utils-link.ts","src/utils.ts","../../../../etc/shadow","1"]
  // — the gate renders "-> src/utils.ts", no warning, while the real target escapes.
  // The name-only guard did not catch this; both variable-width fields need checking.
  test.skipIf(isWin)('a TAB in a symlink TARGET cannot forge the escape flag', () => {
    const { upper, dest, ws } = makeDirs();
    symlinkSync('src/utils.ts\t../../../../etc/shadow', join(upper, 'utils-link.ts'));

    const { records } = runScript(buildSummaryScript(), upper, dest, ws);

    expect(records).toEqual([{ tag: 'S', fields: ['utils-link.ts', 'unsafe-record-target'] }]);
  });

  // R8: the previous summary fixture pinned only `dir`. These pin the `base`/`whname`
  // decodes on the consent surface too — reverting the summary copy's split to forks,
  // or making its whiteout decode greedy, passed the whole suite before this.
  test('the summary decodes a nested whiteout name, not just its directory', () => {
    const { upper, dest, ws } = makeDirs();
    mkdirSync(join(upper, 'sub'), { recursive: true });
    writeFileSync(join(upper, 'sub', '.wh..wh.x'), '');
    mkdirSync(join(dest, 'sub'), { recursive: true });
    writeFileSync(join(dest, 'sub', '.wh.x'), 'the real target');

    const { records } = runScript(buildSummaryScript(), upper, dest, ws);

    // Greedy decode would report 'sub/x'; a forked basename on a '-'-prefixed
    // component would report nothing at all.
    expect(records.some(r => r.tag === 'D' && r.fields[0] === 'sub/.wh.x')).toBe(true);
    expect(records.some(r => r.tag === 'D' && r.fields[0] === 'sub/x')).toBe(false);
  });

  // Reverting the summary copy's rel/base to forks passed even the test above,
  // because `sub/.wh..wh.x` is an input where forks and expansions AGREE. Only a
  // divergent input discriminates: `basename "-d/.wh.foo"` treats the path as an
  // option and fails, so `base` comes back empty, the whiteout arm never matches, and
  // the summary shows the approver an ADDED marker file instead of a deletion.
  test('the summary decodes a whiteout under a `-`-prefixed directory', () => {
    const { upper, dest, ws } = makeDirs();
    mkdirSync(join(upper, '-d'), { recursive: true });
    writeFileSync(join(upper, '-d', '.wh.foo'), '');
    mkdirSync(join(dest, '-d'), { recursive: true });
    writeFileSync(join(dest, '-d', 'foo'), 'would be deleted');

    const { records } = runScript(buildSummaryScript(), upper, dest, ws);

    expect(records.some(r => r.tag === 'D' && r.fields[0] === '-d/foo')).toBe(true);
    // A failed decode surfaces the marker itself as an addition — the wrong story.
    expect(records.some(r => r.tag === 'A' && r.fields[0] === '-d/.wh.foo')).toBe(false);
  });

  test('a nested whiteout is reported at its full path, not its stem', () => {
    const { upper, dest, ws } = makeDirs();
    mkdirSync(join(upper, 'sub'), { recursive: true });
    writeFileSync(join(upper, 'sub', '.wh.gone.txt'), '');
    mkdirSync(join(dest, 'sub'), { recursive: true });
    writeFileSync(join(dest, 'sub', 'gone.txt'), 'bye');

    const { records } = runScript(buildSummaryScript(), upper, dest, ws);

    expect(records.some(r => r.tag === 'D' && r.fields[0] === 'sub/gone.txt')).toBe(true);
    // An empty `dir` would report the top-level name and invite the approver to
    // sign off on deleting a different file.
    expect(records.some(r => r.tag === 'D' && r.fields[0] === 'gone.txt')).toBe(false);
  });
});

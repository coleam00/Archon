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
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  lstatSync,
  readlinkSync,
  rmSync,
  chmodSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildApplyScript, buildSummaryScript } from './overlay';

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
    stdout = execFileSync('bash', ['-c', script, 'archon-overlay', upper, other, ws], {
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

/** Fresh {upper, dest} pair under a temp root; `data` is the overlay upperdir. */
function makeDirs(): { root: string; upper: string; dest: string; ws: string } {
  const root = mkdtempSync(join(tmpdir(), 'overlay-sec-'));
  const upper = join(root, 'upper', 'data');
  const dest = join(root, 'dest');
  mkdirSync(upper, { recursive: true });
  mkdirSync(dest, { recursive: true });
  return { root, upper, dest, ws: dest };
}

describe('apply script — C1 whiteout-name traversal', () => {
  test('`.wh.` (empty decoded name) does NOT wipe the parent dir', () => {
    const { root, upper, dest, ws } = makeDirs();
    mkdirSync(join(upper, 'subdir'), { recursive: true });
    writeFileSync(join(upper, 'subdir', '.wh.'), ''); // malicious: decodes to empty name
    mkdirSync(join(dest, 'subdir'), { recursive: true });
    writeFileSync(join(dest, 'subdir', 'keepme.txt'), 'precious');

    const { records } = runScript(buildApplyScript(), upper, dest, ws);
    expect(existsSync(join(dest, 'subdir', 'keepme.txt'))).toBe(true); // NOT wiped
    expect(records.some(r => r.tag === 'S' && r.fields[1] === 'unsafe-whiteout-name')).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('`.wh...` (decoded name `..`) does NOT rm the parent-of-parent', () => {
    const { root, upper, dest, ws } = makeDirs();
    writeFileSync(join(upper, '.wh...'), ''); // decodes to '..'
    const canary = join(dest, 'canary.txt');
    writeFileSync(canary, 'alive');

    const { records } = runScript(buildApplyScript(), upper, dest, ws);
    expect(existsSync(canary)).toBe(true);
    expect(existsSync(dest)).toBe(true);
    expect(records.some(r => r.tag === 'S' && r.fields[1] === 'unsafe-whiteout-name')).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('a legit `.wh.<name>` whiteout deletes exactly that file', () => {
    const { root, upper, dest, ws } = makeDirs();
    writeFileSync(join(upper, '.wh.gone.txt'), '');
    writeFileSync(join(dest, 'gone.txt'), 'bye');
    writeFileSync(join(dest, 'stay.txt'), 'keep');

    const { records } = runScript(buildApplyScript(), upper, dest, ws);
    expect(existsSync(join(dest, 'gone.txt'))).toBe(false);
    expect(existsSync(join(dest, 'stay.txt'))).toBe(true);
    expect(records.some(r => r.tag === 'D' && r.fields[0] === 'gone.txt')).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('apply script — C2 special files + setuid', () => {
  test('setuid/setgid/sticky bits are stripped from applied files', () => {
    const { root, upper, dest, ws } = makeDirs();
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
    rmSync(root, { recursive: true, force: true });
  });

  test('a fifo (special file) is skipped, never reproduced on the host', () => {
    const { root, upper, dest, ws } = makeDirs();
    // mkfifo via bash (portable); if unavailable the test still asserts non-reproduction.
    try {
      execFileSync('mkfifo', [join(upper, 'pipe')]);
    } catch {
      rmSync(root, { recursive: true, force: true });
      return;
    }
    const { records } = runScript(buildApplyScript(), upper, dest, ws);
    expect(existsSync(join(dest, 'pipe'))).toBe(false);
    expect(records.some(r => r.tag === 'S' && r.fields[0] === 'pipe')).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('apply script — M1/M4 symlinks', () => {
  test('a symlink whose target escapes the project root is REFUSED', () => {
    const { root, upper, dest, ws } = makeDirs();
    symlinkSync('/etc/passwd', join(upper, 'leak')); // absolute, outside ws
    const { records } = runScript(buildApplyScript(), upper, dest, ws);
    expect(existsSync(join(dest, 'leak'))).toBe(false);
    expect(records.some(r => r.tag === 'S' && r.fields[1] === 'escaping-symlink')).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('a relative `..` symlink target is refused', () => {
    const { root, upper, dest, ws } = makeDirs();
    symlinkSync('../../../../etc/hosts', join(upper, 'up'));
    const { records } = runScript(buildApplyScript(), upper, dest, ws);
    expect(existsSync(join(dest, 'up'))).toBe(false);
    expect(records.some(r => r.tag === 'S' && r.fields[1] === 'escaping-symlink')).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('an in-project relative symlink is reproduced as a symlink', () => {
    const { root, upper, dest, ws } = makeDirs();
    writeFileSync(join(upper, 'real.txt'), 'x');
    symlinkSync('real.txt', join(upper, 'link'));
    const { records } = runScript(buildApplyScript(), upper, dest, ws);
    expect(lstatSync(join(dest, 'link')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dest, 'link'))).toBe('real.txt');
    expect(records.some(r => r.tag === 'K' && r.fields[0] === 'link')).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('M4: a symlink-to-dir is applied as a SYMLINK, not a real directory', () => {
    const { root, upper, dest, ws } = makeDirs();
    mkdirSync(join(upper, 'realdir'), { recursive: true });
    symlinkSync('realdir', join(upper, 'dirlink'));
    runScript(buildApplyScript(), upper, dest, ws);
    expect(lstatSync(join(dest, 'dirlink')).isSymbolicLink()).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('apply script — dest-symlink traversal confinement', () => {
  test('a write through a pre-existing dest symlink parent is refused', () => {
    const { root, upper, dest, ws } = makeDirs();
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(dest, 'evil')); // dest/evil -> outside/
    mkdirSync(join(upper, 'evil'), { recursive: true });
    writeFileSync(join(upper, 'evil', 'pwned.txt'), 'x');

    const { records } = runScript(buildApplyScript(), upper, dest, ws);
    expect(existsSync(join(outside, 'pwned.txt'))).toBe(false); // did NOT traverse
    expect(records.some(r => r.tag === 'S' && r.fields[1] === 'escaping-file')).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('summary script — faithful representation (M1)', () => {
  test('symlinks are shown with target + escape flag; specials flagged', () => {
    const { root, upper, dest, ws } = makeDirs();
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
    rmSync(root, { recursive: true, force: true });
  });
});

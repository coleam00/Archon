import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');

/** The bundled SDLC pack: every file under it must work for any project. */
const PACK_ROOT = '.archon/workflows/sdlc';

/**
 * References that name this repository's owners, trackers or vendors. A project
 * adopting the pack would inherit them as if they were its own.
 */
const LEAKS: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  { pattern: /coleam00|wirasm/i, what: "this repository's owner" },
  { pattern: /coderabbit/i, what: 'a specific review vendor' },
  { pattern: /(?:^|[\s(`'"])#\d{4,6}\b/, what: 'a tracker issue or PR number' },
];

/**
 * The one exception: the maintained GitHub forge plugin's install id names the
 * repository that publishes it, which is the same for every project.
 */
const ALLOWED: readonly { readonly file: string; readonly line: RegExp }[] = [
  { file: `${PACK_ROOT}/.shared/forge.ts`, line: /^export const GITHUB_FORGE_PLUGIN = / },
];

export interface Leak {
  readonly file: string;
  readonly line: number;
  readonly what: string;
  readonly text: string;
}

export function findLeaks(file: string, content: string): Leak[] {
  const leaks: Leak[] = [];
  content.split('\n').forEach((text, index) => {
    if (ALLOWED.some(allowed => allowed.file === file && allowed.line.test(text))) return;
    for (const { pattern, what } of LEAKS) {
      if (pattern.test(text)) leaks.push({ file, line: index + 1, what, text: text.trim() });
    }
  });
  return leaks;
}

function packFiles(): string[] {
  return execFileSync('git', ['ls-files', '--', PACK_ROOT], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(file => file !== '');
}

if (import.meta.main) {
  const leaks = packFiles().flatMap(file =>
    findLeaks(file, readFileSync(resolve(REPO_ROOT, file), 'utf8'))
  );
  if (leaks.length > 0) {
    for (const leak of leaks) {
      console.error(`${leak.file}:${String(leak.line)}: names ${leak.what}: ${leak.text}`);
    }
    console.error(
      'The SDLC pack must work for any project. Move project-specific judgment to .archon/sdlc/policy/, or make the reference generic.'
    );
    process.exit(1);
  }
  console.log('Pack portability check passed.');
}

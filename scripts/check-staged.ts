/**
 * Pre-commit check: Biome on the staged content of each staged file.
 *
 * It reads what the commit will contain (`git show :<path>`), not the working tree,
 * and writes nothing, so a commit holds exactly what was staged. `biome check --staged`
 * is not used because it reads the working-tree file, which differs from the commit
 * when a file is partly staged.
 */

import { Buffer } from 'node:buffer';

const decoder = new TextDecoder();

function git(...args: string[]): Uint8Array {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${decoder.decode(result.stderr).trim()}`);
  }
  return result.stdout;
}

async function check(path: string): Promise<string | null> {
  const staged = git('show', `:${path}`);
  // With --write and stdin, Biome prints the fixed text and touches no file.
  const biome = Bun.spawn(
    [
      'bun',
      'x',
      'biome',
      'check',
      '--write',
      '--files-ignore-unknown=true',
      `--stdin-file-path=${path}`,
    ],
    { stdin: staged, stdout: 'pipe', stderr: 'pipe' }
  );
  const [fixed, errors, code] = await Promise.all([
    new Response(biome.stdout).bytes(),
    new Response(biome.stderr).text(),
    biome.exited,
  ]);
  if (code !== 0) return `${path}\n${errors.trim()}`;
  // An ignored or unknown file prints nothing; only a changed text is a finding.
  if (fixed.length > 0 && !Buffer.from(fixed).equals(Buffer.from(staged))) {
    return `${path}: not formatted. Run \`bun x biome check --write ${path}\` and stage it again.`;
  }
  return null;
}

const paths = decoder
  .decode(git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'))
  .split('\0')
  .filter(path => path !== '');
// A merge can stage hundreds of files; a few Biome processes at a time keeps launches bounded.
const problems: string[] = [];
for (let start = 0; start < paths.length; start += 8) {
  const batch = await Promise.all(paths.slice(start, start + 8).map(check));
  problems.push(...batch.filter(problem => problem !== null));
}
if (problems.length > 0) {
  console.error(problems.join('\n\n'));
  process.exit(1);
}

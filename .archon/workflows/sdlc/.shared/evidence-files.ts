/**
 * Where a cited evidence file is on disk.
 *
 * Agents cite evidence the way people do: relative to the folder they were working in,
 * which they often name once ("Evidence directory: ..."), not relative to the run's
 * artifacts root. Seen live: a sound report citing `town-spawn.png` for a file saved in
 * `<artifacts>/appcheck/` was refused as missing. A cited path is looked for, in order:
 * as an absolute path; in the report's declared evidence directory; in the artifacts
 * root; and as the one file under the artifacts root whose path ends with it.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';

function filesUnder(root: string, limit = 5000): string[] {
  const found: string[] = [];
  const stack = [root];
  for (let dir = stack.pop(); dir !== undefined && found.length < limit; dir = stack.pop()) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const path = join(dir, name);
      try {
        if (statSync(path).isDirectory()) stack.push(path);
        else found.push(path);
      } catch {
        // Gone between listing and stat: nothing to cite.
      }
    }
  }
  return found;
}

export function evidenceResolver(artifacts: string, evidenceDir: string): (cited: string) => string | null {
  let index: string[] | null = null;
  return (cited: string): string | null => {
    if (cited === '') return null;
    if (cited.includes('*')) {
      // A set cited by pattern ("landmarks-*.txt") stands when it matches a file.
      const pattern = new RegExp(
        `(^|[\\\\/])${normalize(cited)
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '[^\\\\/]*')}$`,
        'i'
      );
      index ??= filesUnder(artifacts);
      const roots = [evidenceDir, artifacts].filter(base => base !== '').map(base => normalize(base));
      return (
        index.find(path => pattern.test(path) && roots.some(base => normalize(path).startsWith(base))) ??
        null
      );
    }
    if (isAbsolute(cited)) return existsSync(cited) ? cited : null;
    for (const base of [evidenceDir, artifacts]) {
      if (base === '') continue;
      const path = join(base, cited);
      if (existsSync(path)) return path;
    }
    index ??= filesUnder(artifacts);
    const tail = sep + normalize(cited);
    const matches = index.filter(path => normalize(path).toLowerCase().endsWith(tail.toLowerCase()));
    return matches.length === 1 ? matches[0] : null;
  };
}

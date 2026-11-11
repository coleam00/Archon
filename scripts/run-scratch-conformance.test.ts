/**
 * The SDLC pack names the engine's run scratch directory without importing it: its prompts
 * tell agents where to put checkouts. The engine removes only `getRunScratchDir`, so a pack path that drifted from it would leave
 * every checkout on disk with nothing failing.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { getRunScratchDir } from '@archon/paths/archon-paths';

const artifacts = join('/', 'run-artifacts');
const engineScratch = getRunScratchDir(artifacts);

test('every pack file names scratch at the engine path', () => {
  const spelled = `$ARTIFACTS_DIR/${relative(artifacts, engineScratch).split(sep).join(posix.sep)}`;
  const root = join(import.meta.dir, '..', '.archon');
  const named = [
    ...new Bun.Glob('{workflows,commands}/**/*').scanSync({ cwd: root, dot: true }),
  ].flatMap(file =>
    [...readFileSync(join(root, file), 'utf8').matchAll(/\$ARTIFACTS_DIR\/\S*?scratch/g)].map(
      match => ({
        file,
        path: match[0],
      })
    )
  );
  expect(named.length).toBeGreaterThan(0);
  expect(named.filter(({ path }) => path !== spelled)).toEqual([]);
});

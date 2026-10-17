import { afterEach, expect, spyOn, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import * as defaults from '../packages/workflows/src/defaults/bundled-defaults';
import { captureWorkflowSource } from '../packages/workflows/src/workflow-source';

/**
 * Each SDLC workflow's policy node finds the pack's default policy documents inside the
 * run's own captured source, whether the bundle came from a source checkout or from a
 * binary's embedded constants. Importing the captured script gives the same
 * `import.meta.dir` the `policy` script node runs with.
 */
const track = trackTempRoots();
const originalHome = process.env.ARCHON_HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalHome;
});

const WORKFLOWS_WITH_POLICY = ['triage', 'plan', 'review'];

for (const binary of [true, false]) {
  test.each(WORKFLOWS_WITH_POLICY)(
    `a ${binary ? 'binary' : 'source'} capture hands %s the default policy documents`,
    async workflow => {
      const root = track(await mkdtemp(join(tmpdir(), 'archon-sdlc-policy-')));
      process.env.ARCHON_HOME = join(root, 'home');
      const mode = spyOn(defaults, 'isBinaryBuild').mockReturnValue(binary);
      const output = spyOn(console, 'log').mockImplementation(() => {});
      try {
        const project = join(root, 'project');
        await mkdir(project);
        const { anchor } = await captureWorkflowSource({
          sourceRoot: project,
          captureRoot: join(root, 'capture'),
        });
        await import(join(anchor.root, `bundled/workflows/sdlc/${workflow}/scripts/policy.ts`));
        const emitted: { defaults: string } = JSON.parse(String(output.mock.calls[0]?.[0]));
        const directory = realpathSync(emitted.defaults);
        expect(directory.startsWith(realpathSync(anchor.root) + sep)).toBe(true);
        for (const document of ['triage.md', 'rulings.md']) {
          // The bundle stores LF; a Windows checkout of the authored file is CRLF.
          const authored = await readFile(
            join(import.meta.dir, '../.archon/workflows/sdlc/.shared/policy', document),
            'utf8'
          );
          expect(await readFile(join(directory, document), 'utf8')).toBe(
            authored.replace(/\r\n/g, '\n')
          );
        }
      } finally {
        output.mockRestore();
        mode.mockRestore();
      }
    }
  );
}

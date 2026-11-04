import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import * as defaults from '../packages/workflows/src/defaults/bundled-defaults';
import { captureWorkflowSource } from '../packages/workflows/src/workflow-source';

/**
 * The SDLC pack's prompts read its default policy documents at
 * `$PACK_DIR/.shared/policy/`, which is the pack's folder in the run's captured source. So a
 * capture must carry every one of those documents, byte for byte, whether the bundle came
 * from a source checkout or from a binary's embedded constants.
 */
const track = trackTempRoots();
const originalHome = process.env.ARCHON_HOME;
const AUTHORED = join(import.meta.dir, '../.archon/workflows/sdlc/.shared/policy');

afterEach(() => {
  if (originalHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalHome;
});

test.each([true, false])(
  'a capture carries the default policy documents (binary: %p)',
  async binary => {
    const root = track(await mkdtemp(join(tmpdir(), 'archon-sdlc-policy-')));
    process.env.ARCHON_HOME = join(root, 'home');
    const mode = spyOn(defaults, 'isBinaryBuild').mockReturnValue(binary);
    try {
      const project = join(root, 'project');
      await mkdir(project);
      const { anchor } = await captureWorkflowSource({
        sourceRoot: project,
        captureRoot: join(root, 'capture'),
      });
      const captured = join(anchor.root, 'bundled/workflows/sdlc/.shared/policy');
      const documents = (await readdir(AUTHORED)).filter(name => name.endsWith('.md')).sort();
      expect(documents).toContain('triage.md');
      expect(documents).toContain('rulings.md');
      expect((await readdir(captured)).sort()).toEqual(documents);
      for (const document of documents) {
        // The bundle stores LF; a Windows checkout of the authored file is CRLF.
        const authored = await readFile(join(AUTHORED, document), 'utf8');
        expect(await readFile(join(captured, document), 'utf8')).toBe(
          authored.replace(/\r\n/g, '\n')
        );
      }
    } finally {
      mode.mockRestore();
    }
  }
);

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { BUNDLED_WORKFLOWS } from '@archon/workflows/defaults';
import { findBundledWorkflow, findWorkflowAt } from './workflow-files';

const trackTempRoot = trackTempRoots();
const invalid = 'name: declared-review\nthinking: high\n';

describe('file lookup uses declared error names', () => {
  test.each(['file.yaml', 'pack/folder/file.yaml'])(
    '%s answers only to its known declared name',
    async filename => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'workflow-file-name-')));
      const path = join(root, filename);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, invalid);
      const hit = await findWorkflowAt(root, 'declared-review');
      expect(hit?.parsed.error).toMatchObject({
        workflowName: 'declared-review',
        errorType: 'validation_error',
      });
      for (const alias of ['file', 'folder', 'DECLARED-REVIEW', 'review']) {
        expect(await findWorkflowAt(root, alias)).toBeNull();
      }
    }
  );

  test.each(['file.yaml', 'pack/folder/file.yaml'])(
    '%s retains filename attribution when no name is known',
    async filename => {
      const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'workflow-file-unnamed-')));
      const path = join(root, filename);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, 'name: [invalid');
      expect((await findWorkflowAt(root, 'file'))?.parsed.error?.errorType).toBe('parse_error');
      if (filename.includes('/')) {
        expect((await findWorkflowAt(root, 'folder'))?.parsed.error?.errorType).toBe('parse_error');
      }
    }
  );
});

const originalFile = BUNDLED_WORKFLOWS['file'];
afterEach(() => {
  if (originalFile === undefined) delete BUNDLED_WORKFLOWS['file'];
  else BUNDLED_WORKFLOWS['file'] = originalFile;
});

test('embedded bundled errors use the declared name when known', () => {
  BUNDLED_WORKFLOWS['file'] = invalid;
  expect(findBundledWorkflow('declared-review')?.parsed.error?.workflowName).toBe(
    'declared-review'
  );
  expect(findBundledWorkflow('file')).toBeNull();
  expect(findBundledWorkflow('DECLARED-REVIEW')).toBeNull();
  BUNDLED_WORKFLOWS['file'] = 'name: [invalid';
  expect(findBundledWorkflow('file')?.parsed.error?.errorType).toBe('parse_error');
});

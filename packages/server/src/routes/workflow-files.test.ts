import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { BUNDLED_WORKFLOWS } from '@archon/workflows/defaults';
import { OpenAPIHono } from '@hono/zod-openapi';
import * as codebaseDb from '@archon/core/db/codebases';
import { registerWorkflowDefinitionRoutes } from './api.workflows';
import { findBundledWorkflow, findWorkflowAt } from './workflow-files';

const trackTempRoot = trackTempRoots();
const invalid = 'name: declared-review\nthinking: high\n';

describe('file lookup uses declared error names', () => {
  test.each(['file.yaml', 'triage/file.yaml', 'pack/folder/file.yaml'])(
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

const valid = 'name: review\ndescription: Review\nnodes:\n  - id: run\n    bash: echo ok\n';

test('only a direct namespaced file can answer to its basename', async () => {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'workflow-namespace-')));
  await writeFile(join(root, 'review.yaml'), valid);
  expect(await findWorkflowAt(root, 'missing/review')).toBeNull();
  await mkdir(join(root, 'triage'));
  await writeFile(join(root, 'triage', 'review.yaml'), valid);
  expect((await findWorkflowAt(root, 'triage/review'))?.filename).toBe('triage/review.yaml');
});

test('YAML-suffixed grouping directories do not interrupt lookup', async () => {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'workflow-yaml-dir-')));
  await mkdir(join(root, 'assets.yaml'));
  await mkdir(join(root, 'pack', 'review'), { recursive: true });
  await writeFile(join(root, 'pack', 'review', 'file.yaml'), valid);
  expect((await findWorkflowAt(root, 'review'))?.packaged).toBe(true);
  expect(await findWorkflowAt(root, 'new-workflow')).toBeNull();
});

test.each(['project', 'global'] as const)(
  '%s GET and PUT use actual workflow files and exact scanned names',
  async source => {
    const home = trackTempRoot(await mkdtemp(join(tmpdir(), 'workflow-file-routes-')));
    const previousHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = home;
    const codebases = spyOn(codebaseDb, 'listCodebases').mockResolvedValue(
      source === 'global'
        ? []
        : [
            {
              id: 'project',
              name: 'project',
              default_cwd: home,
              kind: 'folder',
              repository_url: null,
              default_branch: null,
              ai_assistant_type: null,
              commands: {},
              created_at: new Date(0),
              updated_at: new Date(0),
            },
          ]
    );
    try {
      const root =
        source === 'global' ? join(home, 'workflows') : join(home, '.archon', 'workflows');
      await mkdir(join(root, 'triage'), { recursive: true });
      await writeFile(join(root, 'triage', 'file.yaml'), invalid);
      await writeFile(join(root, 'review.yaml'), valid);
      await mkdir(join(root, 'assets.yaml'));
      await mkdir(join(root, 'pack', 'flow'), { recursive: true });
      await writeFile(
        join(root, 'pack', 'flow', 'definition.yaml'),
        valid.replace('name: review', 'name: packaged')
      );
      const app = new OpenAPIHono();
      registerWorkflowDefinitionRoutes(app);
      const broken = await app.request('/api/workflows/declared-review');
      expect(broken.status).toBe(500);
      expect(await broken.text()).toContain('thinking');
      expect((await app.request('/api/workflows/missing%2Freview')).status).toBe(404);
      expect((await app.request('/api/workflows/packaged')).status).toBe(200);
      const saved = await app.request(`/api/workflows/packaged?source=${source}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definition: {
            name: 'packaged',
            description: 'Updated',
            nodes: [{ id: 'run', bash: 'echo updated' }],
          },
        }),
      });
      expect(saved.status).toBe(200);
      expect(await readFile(join(root, 'pack', 'flow', 'definition.yaml'), 'utf8')).toContain(
        'Updated'
      );
      const created = await app.request(`/api/workflows/new-workflow?source=${source}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definition: {
            name: 'new-workflow',
            description: 'New',
            nodes: [{ id: 'run', bash: 'echo new' }],
          },
        }),
      });
      expect(created.status).toBe(200);
    } finally {
      codebases.mockRestore();
      if (previousHome === undefined) delete process.env.ARCHON_HOME;
      else process.env.ARCHON_HOME = previousHome;
    }
  }
);

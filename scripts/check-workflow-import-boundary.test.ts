import { expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { checkWorkflowImports, WORKFLOW_BOUNDARY_FILES } from './check-workflow-import-boundary';

const tempRoots = trackTempRoots();
test('workflow boundary rejects static, dynamic and barrel persistence imports', async () => {
  const root = tempRoots(await mkdtemp(join(tmpdir(), 'archon-workflow-boundary-')));
  const db = resolve(import.meta.dir, '../packages/core/src/db/workflows.ts');
  const core = resolve(import.meta.dir, '../packages/core/src/index.ts');
  for (const [name, source] of [
    ['direct', `import { getWorkflowRun } from ${JSON.stringify(db)}; void getWorkflowRun;`],
    ['dynamic', `void import(${JSON.stringify(db)});`],
    ['template', 'void import(`' + db + '`);'],
    ['require', `require(${JSON.stringify(db)});`],
    ['barrel', `import { workflowDb } from ${JSON.stringify(core)}; void workflowDb;`],
  ]) {
    const file = join(root, `${name}.ts`);
    await writeFile(file, source);
    expect(checkWorkflowImports([file])).not.toEqual([]);
  }
  expect(
    checkWorkflowImports([...WORKFLOW_BOUNDARY_FILES, 'packages/core/src/workflows/sql-host.ts'])
  ).toEqual([]);
}, 30000);

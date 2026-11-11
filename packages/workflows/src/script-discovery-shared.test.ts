// @archon-test-isolated
/**
 * A pack workflow's named script falls back to the pack's shared scripts
 * (`<pack>/.shared/scripts/`) when the workflow's own `scripts/` does not hold it.
 */
import { providerRegistry } from '@archon/providers';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { formatPackagedResourceReference } from './packaged-workflow';
import { discoverScriptsForCwd } from './script-discovery';
import { discoverWorkflows } from './workflow-discovery';

let cwd: string;
const originalArchonHome = process.env.ARCHON_HOME;

const workflow = (name: string, script: string): string =>
  `name: ${name}\ndescription: d\nnodes:\n  - id: run\n    script: ${script}\n    runtime: bun\n`;

async function writePack(files: Record<string, string>): Promise<string> {
  const pack = join(cwd, '.archon', 'workflows', 'kit');
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(pack, path)), { recursive: true });
    await writeFile(join(pack, path), content);
  }
  return pack.replaceAll('\\', '/');
}

const qualified = (workflowFolder: string, name: string): string =>
  formatPackagedResourceReference(
    { source: 'project', pack: 'kit', workflow: workflowFolder },
    name
  );

beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'shared-scripts-')));
  process.env.ARCHON_HOME = join(cwd, 'home');
});

afterEach(async () => {
  await removeTempTree(cwd);
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
});

test("a named script resolves from the pack's shared scripts, and the workflow's own wins", async () => {
  const pack = await writePack({
    'borrows/borrows.yaml': workflow('borrows', 'check'),
    'owns/owns.yaml': workflow('owns', 'check'),
    'owns/scripts/check.ts': 'console.log("own");\n',
    '.shared/scripts/check.ts': 'console.log("shared");\n',
  });

  const { workflows, errors } = await discoverWorkflows(cwd, {
    providers: providerRegistry,
    loadDefaults: false,
  });
  expect(errors).toEqual([]);
  expect(workflows.map(w => w.workflow.name).sort()).toEqual(['borrows', 'owns']);

  // The lookup a script node makes at run time: its one qualified name.
  for (const [folder, path] of [
    ['borrows', `${pack}/.shared/scripts/check.ts`],
    ['owns', `${pack}/owns/scripts/check.ts`],
  ] as const) {
    const name = qualified(folder, 'check');
    const selected = await discoverScriptsForCwd(cwd, undefined, new Set([name]));
    expect(selected.get(name)).toEqual({ name, path, runtime: 'bun' });
    expect((await discoverScriptsForCwd(cwd)).get(name)?.path).toBe(path);
  }
});

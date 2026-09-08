// Runs in its own process because the engine hands exec nodes the ambient environment:
// only a child can be given the harness PATH, Git config, Archon home, and temporary
// directory the acceptance run must see, without those leaking into the test runner.
import { discoverWorkflows } from '../../../../../packages/workflows/src/workflow-discovery';
import { dryRunWorkflow } from '../../../../../packages/workflows/src/dry-run';
import { liveSourceRoots } from '../../../../../packages/workflows/src/workflow-source';
import { join } from 'node:path';

const source = process.argv[2];
const roots = {
  ...liveSourceRoots(source),
  globalWorkflows: join(source, 'empty'),
  globalCommands: join(source, 'empty'),
  globalScripts: join(source, 'empty'),
  bundledWorkflows: join(source, 'empty'),
  bundledCommands: join(source, 'empty'),
};
const discovered = await discoverWorkflows(source, { loadDefaults: false, sourceRoots: roots });
if (process.argv[3] === 'discover') {
  console.log(JSON.stringify(discovered.errors));
} else {
  if (discovered.errors.length) throw new Error(JSON.stringify(discovered.errors));
  const workflow = discovered.workflows.find(w => w.workflow.name === 'archon-accept')?.workflow;
  if (!workflow) throw new Error('Acceptance workflow was not discovered');
  const result = await dryRunWorkflow({
    workflow,
    cwd: source,
    execWorkspace: process.cwd(),
    sourceRoots: roots,
    userMessage: '',
    inputs: {
      target: process.env.INPUTS_TARGET ?? '',
      work_order: process.env.INPUTS_WORK_ORDER ?? '',
      policy: process.env.INPUTS_POLICY ?? '',
    },
    execCode: true,
    stubs: { judge: process.env.INPUTS_JUDGMENT ?? 'null' },
  });
  console.log(JSON.stringify(result));
}

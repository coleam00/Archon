import { trackTempRoots } from '@archon/paths/test-utils';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dryRunWorkflow as dryRunResolvedWorkflow,
  createDryRunStubScaffold as createResolvedDryRunStubScaffold,
  writeDryRunStubScaffold as writeResolvedDryRunStubScaffold,
} from './dry-run';
import { resolveWorkflow } from './graph-plan';
import type { ResolvedWorkflow, WorkflowDefinition } from './schemas';

function asResolvedWorkflow(workflow: WorkflowDefinition | ResolvedWorkflow): ResolvedWorkflow {
  return 'plan' in workflow ? workflow : resolveWorkflow(workflow);
}

export function createDryRunStubScaffold(workflow: WorkflowDefinition | ResolvedWorkflow) {
  return createResolvedDryRunStubScaffold(asResolvedWorkflow(workflow));
}

export function writeDryRunStubScaffold(
  workflow: WorkflowDefinition | ResolvedWorkflow,
  path: string
) {
  return writeResolvedDryRunStubScaffold(asResolvedWorkflow(workflow), path);
}

type TestDryRunOptions = Omit<
  Parameters<typeof dryRunResolvedWorkflow>[0],
  'workflow' | 'userMessage' | 'cwd'
> & {
  workflow: WorkflowDefinition | ResolvedWorkflow;
  userMessage?: string;
  cwd?: string;
};

export function dryRunWorkflow(options: TestDryRunOptions) {
  return dryRunResolvedWorkflow({
    userMessage: '',
    cwd: process.cwd(),
    ...options,
    workflow: asResolvedWorkflow(options.workflow),
  });
}

export function useDryRunFiles() {
  const track = trackTempRoots();
  const temporaryDirectory = () => track(mkdtempSync(join(tmpdir(), 'archon-dry-run-')));
  const temporaryFile = (content: string) => {
    const path = join(temporaryDirectory(), 'stubs.yaml');
    writeFileSync(path, content);
    return path;
  };
  const commandFiles = (commands: Record<string, string>) => {
    const cwd = temporaryDirectory();
    const directory = join(cwd, '.archon', 'commands');
    mkdirSync(directory, { recursive: true });
    for (const [name, text] of Object.entries(commands)) {
      writeFileSync(join(directory, `${name}.md`), text);
    }
    return cwd;
  };
  return { temporaryDirectory, temporaryFile, commandFiles };
}

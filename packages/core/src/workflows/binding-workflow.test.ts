import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { providerRegistry } from '@archon/providers';
import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { asksSettledBindingCheck } from './asks-settled';
import { selectStartedWorkflow } from './binding-workflow';
import { runEndedBindingCheck } from './run-ended';

const track = trackTempRoots();

const SOURCE = '/srv/pack-source';
const entry = (name: string, source: 'project' | 'global' | 'bundled') =>
  makeTestWorkflowWithSource({ name, nodes: [{ id: 'one', bash: 'echo one' }] }, source);

describe('selectStartedWorkflow', () => {
  test('with a workflow source, its own workflow is started', () => {
    const own = entry('build', 'project');
    expect(selectStartedWorkflow({ workflowName: 'build', discoveryCwd: SOURCE }, [own])).toEqual({
      workflow: own.workflow,
    });
  });

  test.each(['global', 'bundled'] as const)(
    'with a workflow source, a %s copy of the name is refused, naming where it looked',
    scope => {
      const started = selectStartedWorkflow({ workflowName: 'build', discoveryCwd: SOURCE }, [
        entry('build', scope),
      ]);
      if (!('refused' in started)) throw new Error('expected a refusal');
      expect(started.refused).toContain(join(SOURCE, '.archon', 'workflows'));
      expect(started.refused).toContain(scope);
    }
  );

  test('with a workflow source, a name in no scope is refused, naming where it looked', () => {
    const started = selectStartedWorkflow({ workflowName: 'build', discoveryCwd: SOURCE }, []);
    if (!('refused' in started)) throw new Error('expected a refusal');
    expect(started.refused).toContain(join(SOURCE, '.archon', 'workflows'));
  });

  test('a workflow source inside a checkout points at its checkout root', () => {
    const packFolder = join(SOURCE, '.archon', 'workflows', 'sdlc');
    const started = selectStartedWorkflow({ workflowName: 'build', discoveryCwd: packFolder }, [
      entry('build', 'bundled'),
    ]);
    if (!('refused' in started)) throw new Error('expected a refusal');
    expect(started.refused).toContain(`did you mean ${SOURCE}?`);
  });

  test('without a workflow source, the name resolves across every scope', () => {
    const global = entry('build', 'global');
    expect(selectStartedWorkflow({ workflowName: 'build' }, [global])).toEqual({
      workflow: global.workflow,
    });
  });
});

describe('trigger check refuses what a fire refuses', () => {
  const deps = {
    loadConfig: async () => ({
      assistant: 'claude' as const,
      assistants: { claude: {}, codex: {} },
      commands: {},
    }),
    providers: providerRegistry,
  };

  test.each(['runEnded', 'asksSettled'] as const)(
    'a %s binding whose workflow source lacks the workflow reports it, though a bundled one has the name',
    async kind => {
      const root = track(await mkdtemp(join(tmpdir(), 'archon-binding-workflow-')));
      const source = join(root, 'source');
      await mkdir(join(source, '.archon', 'workflows'), { recursive: true });
      const discovered = await discoverWorkflowsWithConfig(source, deps.loadConfig, deps.providers);
      const bundled = discovered.workflows.find(found => found.source === 'bundled');
      if (!bundled) throw new Error('expected a bundled workflow to shadow');
      const binding = {
        bindingId: 'b',
        bindingRevision: null,
        hostId: 'host',
        runAsUserId: 'operator',
        resource: 'r',
        overlap: 'queue' as const,
        launch: {
          cwd: root,
          discoveryCwd: source,
          workflowName: bundled.workflow.name,
          inputs: {},
          isolation: { kind: 'default' as const },
        },
      };
      const problems =
        kind === 'runEnded'
          ? await runEndedBindingCheck(
              {
                file: 'b.json',
                sourceInstanceId: 'b',
                binding,
                runEnded: { workflowName: 'plan', outcome: 'ready' },
              },
              deps
            )
          : await asksSettledBindingCheck(
              {
                file: 'b.json',
                sourceInstanceId: 'b',
                binding,
                asksSettled: { workflowName: 'plan', settled: 'any' },
              },
              deps
            );
      expect(problems).toContainEqual(
        expect.stringContaining(join(source, '.archon', 'workflows'))
      );
    }
  );
});

import { describe, expect, it } from 'bun:test';
import type { WorkflowDefinition } from './schemas';
import {
  formatPackagedResourceReference,
  parsePackagedResourceReference,
  qualifyWorkflowResources,
} from './packaged-workflow';

const owner = { source: 'project' as const, pack: 'author-pack', workflow: 'workflow-x' };

describe('packaged workflow resource qualification (#2527)', () => {
  it('qualifies command, loop command, and loop-group named resources', () => {
    const workflow = {
      name: 'test',
      description: 'test',
      nodes: [
        { id: 'command', command: 'review' },
        { id: 'loop', loop: { prompt: 'again', command: 'iterate', max_iterations: 2 } },
        {
          id: 'group',
          loop_group: {
            control: { max_iterations: 2 },
            nodes: [
              { id: 'child-command', command: 'child' },
              { id: 'child-script', script: 'transform', runtime: 'bun' },
            ],
          },
        },
      ],
    } as unknown as WorkflowDefinition;

    qualifyWorkflowResources(workflow, owner);
    const command = workflow.nodes[0] as { command: string };
    const loop = workflow.nodes[1] as { loop: { command: string } };
    const group = workflow.nodes[2] as {
      loop_group: { nodes: Array<{ command?: string; script?: string }> };
    };
    expect(parsePackagedResourceReference(command.command)?.name).toBe('review');
    expect(parsePackagedResourceReference(loop.loop.command)?.name).toBe('iterate');
    expect(parsePackagedResourceReference(group.loop_group.nodes[0].command ?? '')?.name).toBe(
      'child'
    );
    expect(parsePackagedResourceReference(group.loop_group.nodes[1].script ?? '')?.name).toBe(
      'transform'
    );
  });

  it('leaves inline scripts unchanged', () => {
    const workflow = {
      name: 'test',
      description: 'test',
      nodes: [{ id: 'script', script: 'console.log("inline")', runtime: 'bun' }],
    } as unknown as WorkflowDefinition;

    qualifyWorkflowResources(workflow, owner);
    expect((workflow.nodes[0] as { script: string }).script).toBe('console.log("inline")');
  });

  it('refuses to format an invalid packaged resource reference', () => {
    expect(() =>
      formatPackagedResourceReference(
        { source: 'project', pack: '..', workflow: 'workflow-x' },
        'review'
      )
    ).toThrow('Invalid packaged resource reference');
    expect(() => formatPackagedResourceReference(owner, '../review')).toThrow(
      'Invalid packaged resource reference'
    );
  });
});

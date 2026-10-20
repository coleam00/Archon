import { describe, test, expect, mock } from 'bun:test';
import { makeTestWorkflowWithSource } from '@archon/workflows/test-utils';
import type { Codebase } from '../types';
import {
  buildInvokeWorkflowTool,
  buildRegisterProjectTool,
  type ChatLaunch,
  type ProjectRegistration,
} from './chat-tools';

function makeCodebase(name: string): Codebase {
  return {
    id: `id-${name}`,
    name,
    repository_url: null,
    default_cwd: `/repos/${name}`,
    default_branch: null,
    ai_assistant_type: 'claude',
    kind: 'repo',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
  };
}

describe('invoke_workflow', () => {
  const workflows = [
    makeTestWorkflowWithSource({ name: 'archon-ship' }),
    makeTestWorkflowWithSource({ name: 'archon-plan' }),
  ];
  const codebases = [makeCodebase('owner/my-app')];

  function build(): { tool: ReturnType<typeof buildInvokeWorkflowTool>; launches: ChatLaunch[] } {
    const launches: ChatLaunch[] = [];
    const tool = buildInvokeWorkflowTool({
      workflows,
      listCodebases: () => Promise.resolve(codebases),
      onLaunch: launch => {
        launches.push(launch);
        return null;
      },
    });
    return { tool, launches };
  }

  test('an unknown workflow lists the available names and queues nothing', async () => {
    const { tool, launches } = build();
    const out = await tool.handler({ workflow: 'ship', project: 'owner/my-app', prompt: 'x' });
    expect(out).toBe('No workflow named "ship". Available: archon-ship, archon-plan');
    expect(launches).toEqual([]);
  });

  test('an unknown project lists the registered projects and queues nothing', async () => {
    const { tool, launches } = build();
    const out = await tool.handler({ workflow: 'archon-ship', project: 'other', prompt: 'x' });
    expect(out).toBe('No registered project matches "other". Registered projects: owner/my-app');
    expect(launches).toEqual([]);
  });

  test('an unexpected project lookup failure reaches the provider failure channel', async () => {
    const tool = buildInvokeWorkflowTool({
      workflows,
      listCodebases: async () => {
        throw new Error('registry unavailable');
      },
      onLaunch: () => {
        throw new Error('must not launch');
      },
    });
    await expect(
      tool.handler({ workflow: 'archon-ship', project: 'my-app', prompt: 'go' })
    ).rejects.toThrow('registry unavailable');
  });

  test('an empty prompt is refused', async () => {
    const { tool, launches } = build();
    const out = await tool.handler({ workflow: 'archon-ship', project: 'my-app', prompt: '  ' });
    expect(out).toBe('invoke_workflow: prompt is required.');
    expect(launches).toEqual([]);
  });

  test('a repo name matches its owner/name project, and the prompt is kept verbatim', async () => {
    const { tool, launches } = build();
    const prompt = 'Fix the "login" bug in C:\\Users\\me';
    const out = await tool.handler({ workflow: 'archon-ship', project: 'My-App', prompt });
    expect(out).toContain('Queued archon-ship on owner/my-app');
    expect(launches).toHaveLength(1);
    expect(launches[0]?.entry.workflow.name).toBe('archon-ship');
    expect(launches[0]?.codebase.name).toBe('owner/my-app');
    expect(launches[0]?.prompt).toBe(prompt);
    expect(launches[0]?.inputs).toEqual({});
  });
});

describe('invoke_workflow declared inputs', () => {
  const workflow = makeTestWorkflowWithSource({
    name: 'release',
    inputs: {
      base_branch: { required: true, description: 'Branch to release from' },
      style: { default: 'normal' },
    },
  });

  function build(): { tool: ReturnType<typeof buildInvokeWorkflowTool>; launches: ChatLaunch[] } {
    const launches: ChatLaunch[] = [];
    const tool = buildInvokeWorkflowTool({
      workflows: [workflow],
      listCodebases: () => Promise.resolve([makeCodebase('owner/my-app')]),
      onLaunch: launch => {
        launches.push(launch);
        return null;
      },
    });
    return { tool, launches };
  }
  const call = { workflow: 'release', project: 'my-app', prompt: 'Cut the release' };

  test('a missing required input is named with its description and nothing is queued', async () => {
    const { tool, launches } = build();
    const out = await tool.handler(call);
    expect(out).toBe(
      "release needs input 'base_branch' (Branch to release from). Ask the user for it, then call invoke_workflow again with inputs. Nothing was launched."
    );
    expect(launches).toEqual([]);
  });

  test('an undeclared input is named alongside the declared ones and nothing is queued', async () => {
    const { tool, launches } = build();
    const out = await tool.handler({ ...call, inputs: '{"base_branch":"dev","stlye":"x"}' });
    expect(out).toContain("does not declare input 'stlye'");
    expect(out).toContain('Declared inputs: base_branch, style.');
    expect(launches).toEqual([]);
  });

  test.each([['not json'], ['["dev"]'], ['{"base_branch":1}'], [{ base_branch: 'dev' }]])(
    'malformed inputs %p are refused and nothing is queued',
    async inputs => {
      const { tool, launches } = build();
      const out = await tool.handler({ ...call, inputs });
      expect(out).toBe(
        'invoke_workflow: inputs must be a JSON object mapping input names to string values. Nothing was launched.'
      );
      expect(launches).toEqual([]);
    }
  );

  test('valid inputs are queued with the launch and echoed to the agent', async () => {
    const { tool, launches } = build();
    const out = await tool.handler({ ...call, inputs: '{"style":"loud","base_branch":"dev"}' });
    expect(out).toContain(
      'Queued release on owner/my-app with inputs: base_branch=dev, style=loud.'
    );
    expect(launches[0]?.inputs).toEqual({ base_branch: 'dev', style: 'loud' });
  });
});

test('invoke_workflow resolves a project registered after the tool was built', async () => {
  const registered: Codebase[] = [];
  const launches: ChatLaunch[] = [];
  const tool = buildInvokeWorkflowTool({
    workflows: [makeTestWorkflowWithSource({ name: 'archon-ship' })],
    listCodebases: () => Promise.resolve(registered),
    onLaunch: launch => {
      launches.push(launch);
      return null;
    },
  });
  registered.push(makeCodebase('fresh-app'));
  const out = await tool.handler({ workflow: 'archon-ship', project: 'fresh-app', prompt: 'x' });
  expect(out).toContain('Queued archon-ship on fresh-app');
  expect(launches[0]?.codebase.name).toBe('fresh-app');
});

describe('register_project', () => {
  function build(impl: (r: ProjectRegistration) => Promise<string>) {
    const registerProject = mock(impl);
    return { tool: buildRegisterProjectTool({ registerProject }), registerProject };
  }

  test('passes folder: true through and omits it when absent', async () => {
    const { tool, registerProject } = build(() => Promise.resolve('ok'));
    await tool.handler({ name: 'app', path: '/srv/app', folder: true });
    await tool.handler({ name: 'app', path: '/srv/app' });
    expect(registerProject.mock.calls).toEqual([
      [{ projectName: 'app', projectPath: '/srv/app', folder: true }],
      [{ projectName: 'app', projectPath: '/srv/app' }],
    ]);
  });

  test('an unexpected registration failure reaches the provider failure channel', async () => {
    const { tool } = build(() => Promise.reject(new Error('disk full')));
    await expect(tool.handler({ name: 'app', path: '/srv/app' })).rejects.toThrow('disk full');
  });
});

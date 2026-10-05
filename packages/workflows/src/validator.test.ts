import type { ProviderRegistry } from '@archon/provider-contract';
import { providerRegistry } from '@archon/providers';
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, symlink as fsSymlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { registerBuiltinProviders, registerPiProvider, clearRegistry } from '@archon/providers';

// Bootstrap provider registry (needed by capability-driven checks in validator).
// Pi supplies a provider whose mcp capability is false.
clearRegistry();
registerBuiltinProviders();
registerPiProvider();

import {
  levenshtein,
  findSimilar,
  makeWorkflowResult,
  validateWorkflowResources,
  validateCommand,
  discoverAvailableCommands,
} from './validator';
import type { WorkflowDefinition, DagNode } from './schemas';
import { dagNodeSchema } from './schemas';
import { parseWorkflow } from './loader';
import { BUNDLED_WORKFLOWS, BUNDLED_WORKFLOW_OWNERS } from './defaults/bundled-defaults';
import { makeTestWorkflow } from './test-utils';
import { formatPackagedResourceReference } from './packaged-workflow';

// =============================================================================
// Test helpers
// =============================================================================

let tmpDir: string;
let tmpHomeDir: string;
let originalArchonHome: string | undefined;
let originalArchonDocker: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'validator-test-'));
  tmpHomeDir = await mkdtemp(join(tmpdir(), 'validator-home-'));
  originalArchonHome = process.env.ARCHON_HOME;
  originalArchonDocker = process.env.ARCHON_DOCKER;
  process.env.ARCHON_HOME = tmpHomeDir;
  delete process.env.ARCHON_DOCKER;
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  await rm(tmpHomeDir, { recursive: true, force: true });
  if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = originalArchonHome;
  if (originalArchonDocker === undefined) delete process.env.ARCHON_DOCKER;
  else process.env.ARCHON_DOCKER = originalArchonDocker;
});

function makeWorkflow(
  name: string,
  nodes: WorkflowDefinition['nodes'],
  provider?: string
): WorkflowDefinition {
  return {
    name,
    description: 'test workflow',
    nodes,
    ...(provider && { provider }),
  } as WorkflowDefinition;
}

async function createCommandFile(name: string, content = '# Do something'): Promise<void> {
  const dir = join(tmpDir, '.archon', 'commands');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.md`), content);
}

// =============================================================================
// levenshtein
// =============================================================================

describe('levenshtein', () => {
  test('identical strings → 0', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
  });

  test('single insertion', () => {
    expect(levenshtein('abc', 'abcd')).toBe(1);
  });

  test('single deletion', () => {
    expect(levenshtein('abcd', 'abc')).toBe(1);
  });

  test('single substitution', () => {
    expect(levenshtein('abc', 'axc')).toBe(1);
  });

  test('empty string → length of other', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  test('both empty → 0', () => {
    expect(levenshtein('', '')).toBe(0);
  });

  test('typical typo: "asist" vs "assist"', () => {
    expect(levenshtein('asist', 'assist')).toBe(1);
  });

  test('completely different strings', () => {
    expect(levenshtein('abc', 'xyz')).toBe(3);
  });
});

// =============================================================================
// findSimilar
// =============================================================================

describe('findSimilar', () => {
  test('returns closest candidates within threshold', () => {
    const result = findSimilar('asist', ['assist', 'assign', 'resist', 'totally-different']);
    expect(result).toContain('assist');
    expect(result.length).toBeLessThanOrEqual(3);
  });

  test('excludes exact match (distance = 0)', () => {
    expect(findSimilar('assist', ['assist', 'asist'])).not.toContain('assist');
  });

  test('returns empty array when nothing is close', () => {
    expect(findSimilar('xyz', ['totally-different', 'another-one'])).toEqual([]);
  });

  test('respects explicit maxDistance override', () => {
    const result = findSimilar('a', ['ab', 'abc', 'abcd'], 1);
    expect(result).toEqual(['ab']);
  });

  test('returns at most 3 suggestions', () => {
    const result = findSimilar('test', ['teat', 'tent', 'text', 'best', 'rest']);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  test('is case-insensitive for near-matches', () => {
    const result = findSimilar('ASIST', ['assist']);
    expect(result).toContain('assist');
  });
});

// =============================================================================
// validateWorkflowResources — command nodes
// =============================================================================

describe('validateWorkflowResources — command nodes', () => {
  test('no issues when command file exists', async () => {
    await createCommandFile('my-command');
    const workflow = makeWorkflow('test', [
      { id: 'step1', kind: 'agent', source: { kind: 'command', name: 'my-command' } } as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const errors = issues.filter(i => i.level === 'error');
    expect(errors).toHaveLength(0);
  });

  test('error when command file is missing', async () => {
    const workflow = makeWorkflow('test', [
      { id: 'step1', kind: 'agent', source: { kind: 'command', name: 'nonexistent' } } as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {
      loadDefaultCommands: false,
    });
    const errors = issues.filter(i => i.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('command');
    expect(errors[0].message).toContain('not found');
  });

  test('suggests similar command names', async () => {
    await createCommandFile('assist');
    const workflow = makeWorkflow('test', [
      { id: 'step1', kind: 'agent', source: { kind: 'command', name: 'asist' } } as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {
      loadDefaultCommands: false,
    });
    const errors = issues.filter(i => i.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].suggestions).toContain('assist');
  });

  test('error for invalid command name', async () => {
    const workflow = makeWorkflow('test', [
      { id: 'step1', kind: 'agent', source: { kind: 'command', name: '../escape' } } as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const errors = issues.filter(i => i.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Invalid command name');
  });

  test('validates a command inside its owning packaged workflow', async () => {
    const commandsDir = join(tmpDir, '.archon', 'workflows', 'team-pack', 'release', 'commands');
    await mkdir(commandsDir, { recursive: true });
    await writeFile(join(commandsDir, 'prepare.md'), '# Prepare');
    const command = formatPackagedResourceReference(
      { source: 'project', pack: 'team-pack', workflow: 'release' },
      'prepare'
    );
    const workflow = makeWorkflow('test', [
      { id: 'step1', kind: 'agent', source: { kind: 'command', name: command } } as DagNode,
    ]);

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    expect(issues.filter(issue => issue.level === 'error')).toHaveLength(0);
  });

  test('rejects a directory masquerading as a packaged command file', async () => {
    const commandsDir = join(tmpDir, '.archon', 'workflows', 'team-pack', 'release', 'commands');
    await mkdir(join(commandsDir, 'prepare.md'), { recursive: true });
    const command = formatPackagedResourceReference(
      { source: 'project', pack: 'team-pack', workflow: 'release' },
      'prepare'
    );
    const workflow = makeWorkflow('test', [
      { id: 'step1', kind: 'agent', source: { kind: 'command', name: command } } as DagNode,
    ]);

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    expect(issues.some(issue => issue.level === 'error' && issue.field === 'command')).toBe(true);
  });
});

// =============================================================================
// validateWorkflowResources — bundled sub-run target check (#2470)
// =============================================================================

describe('validateWorkflowResources — bundled workflow: target check', () => {
  test('bundled targets use the registry supplied to each call', async () => {
    const name = 'registry-target-probe';
    BUNDLED_WORKFLOWS[name] = [
      `name: ${name}`,
      'description: Registry admission fixture.',
      'provider: claude',
      'nodes:',
      '  - id: registry-target-probe-node',
      '    prompt: Check registry admission.',
    ].join('\n');
    const emptyRegistry: ProviderRegistry = { get: () => undefined, list: () => [] };
    const workflow = makeWorkflow('test', [{ id: 'sub', kind: 'workflow', workflow: name }]);
    const config = { workflowSource: 'bundled' } as const;
    try {
      const admitted = await validateWorkflowResources(workflow, tmpDir, providerRegistry, config);
      expect(admitted.filter(issue => issue.field === 'workflow')).toEqual([]);
      const rejected = await validateWorkflowResources(workflow, tmpDir, emptyRegistry, config);
      expect(rejected.filter(issue => issue.field === 'workflow')).toEqual([
        expect.objectContaining({
          level: 'error',
          nodeId: 'sub',
          message: `Node 'sub' targets sub-run '${name}', which is not a bundled workflow`,
        }),
      ]);
      const readmitted = await validateWorkflowResources(
        workflow,
        tmpDir,
        providerRegistry,
        config
      );
      expect(readmitted.filter(issue => issue.field === 'workflow')).toEqual([]);
    } finally {
      delete BUNDLED_WORKFLOWS[name];
    }
  });

  test('bundled workflow with a real bundled workflow: target passes', async () => {
    const workflow = makeWorkflow('test', [
      { id: 'sub', kind: 'workflow', workflow: 'archon-review' } as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {
      workflowSource: 'bundled',
    });
    expect(issues.some(i => i.field === 'workflow')).toBe(false);
  });

  test('bundled workflow with a workflow: node to a non-existent bundled name fails', async () => {
    const workflow = makeWorkflow('test', [
      { id: 'sub', kind: 'workflow', workflow: 'definitely-not-a-bundled-workflow' } as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {
      workflowSource: 'bundled',
    });
    expect(
      issues.some(i => i.field === 'workflow' && i.message.includes('not a bundled workflow'))
    ).toBe(true);
  });

  test('project workflow with a workflow: node to a non-existent name is NOT checked (runtime-resolved)', async () => {
    const workflow = makeWorkflow('test', [
      { id: 'sub', kind: 'workflow', workflow: 'definitely-not-a-bundled-workflow' } as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {
      workflowSource: 'project',
    });
    expect(issues.some(i => i.field === 'workflow')).toBe(false);
  });
});

// =============================================================================
// validateWorkflowResources — portable model refs
// =============================================================================

describe('validateWorkflowResources — portable model refs', () => {
  test('bundled workflow rejects top-level @custom model ref', async () => {
    await createCommandFile('my-command');
    const workflow = {
      ...makeWorkflow('test', [
        { id: 'step1', kind: 'agent', source: { kind: 'command', name: 'my-command' } } as DagNode,
      ]),
      model: '@custom',
    } as WorkflowDefinition;

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {
      workflowSource: 'bundled',
    });

    expect(issues.some(i => i.field === 'model' && i.message.includes('@custom'))).toBe(true);
  });

  test('global workflow rejects node @custom model ref', async () => {
    await createCommandFile('my-command');
    const workflow = makeWorkflow('test', [
      {
        id: 'step1',
        kind: 'agent',
        source: { kind: 'command', name: 'my-command' },
        model: '@custom',
      } as DagNode,
    ]);

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {
      workflowSource: 'global',
    });

    expect(issues.some(i => i.nodeId === 'step1' && i.field === 'model')).toBe(true);
  });

  test('project workflow allows configured @custom model refs', async () => {
    await createCommandFile('my-command');
    const workflow = makeWorkflow('test', [
      {
        id: 'step1',
        kind: 'agent',
        source: { kind: 'command', name: 'my-command' },
        model: '@custom',
      } as DagNode,
    ]);

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {
      workflowSource: 'project',
      aliases: {
        '@custom': { provider: 'claude', model: 'sonnet' },
      },
    });

    expect(issues.some(i => i.field === 'model')).toBe(false);
  });

  test('project workflow rejects unknown @custom model refs', async () => {
    await createCommandFile('my-command');
    const workflow = makeWorkflow('test', [
      {
        id: 'step1',
        kind: 'agent',
        source: { kind: 'command', name: 'my-command' },
        model: '@missing',
      } as DagNode,
    ]);

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {
      workflowSource: 'project',
    });

    expect(
      issues.some(
        i => i.nodeId === 'step1' && i.field === 'model' && i.message.includes('@missing')
      )
    ).toBe(true);
  });

  test('rejects invalid tier config during workflow validation', async () => {
    await createCommandFile('my-command');
    const workflow = {
      ...makeWorkflow('test', [
        { id: 'step1', kind: 'agent', source: { kind: 'command', name: 'my-command' } } as DagNode,
      ]),
      model: 'tiny',
    } as WorkflowDefinition;

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {
      workflowSource: 'project',
      tiers: {
        tiny: { provider: 'claude', model: 'sonnet' },
      } as never,
    });

    expect(issues.some(i => i.field === 'model' && i.message.includes("Tier name 'tiny'"))).toBe(
      true
    );
  });

  test('bundled workflow accepts tiers and literal models', async () => {
    await createCommandFile('my-command');
    const workflow = {
      ...makeWorkflow('test', [
        {
          id: 'step1',
          kind: 'agent',
          source: { kind: 'command', name: 'my-command' },
          model: 'small',
        } as DagNode,
        {
          id: 'step2',
          kind: 'agent',
          source: { kind: 'command', name: 'my-command' },
          model: 'gpt-5.5',
        } as DagNode,
      ]),
      model: 'large',
    } as WorkflowDefinition;

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {
      workflowSource: 'bundled',
    });

    expect(issues.some(i => i.field === 'model')).toBe(false);
  });
});

// =============================================================================
// validateWorkflowResources — loop.command (mirrors command-node coverage)
// =============================================================================

describe('validateWorkflowResources — loop.command', () => {
  // Helper: build a loop node carrying `loop.command`. We bypass the parser via
  // `as DagNode` for parity with the command-node tests above, which lets the
  // validator branch be exercised directly even for inputs the schema would
  // reject (e.g. an unsafe `loop.command` name).
  function makeLoopCommandNode(id: string, loopCommand: string): DagNode {
    return {
      id,
      kind: 'loop',
      loop: {
        command: loopCommand,
        until: 'DONE',
        max_iterations: 5,
        fresh_context: false,
      },
    } as unknown as DagNode;
  }

  test('no issues when repo-local command file exists', async () => {
    // Repo-scope hit: confirms the validator reuses the same repo lookup that
    // command-nodes use, so a `loop.command` pointing at an existing
    // `.archon/commands/<name>.md` clears Level 3 silently.
    await createCommandFile('my-loop-command');
    const workflow = makeWorkflow('test', [makeLoopCommandNode('step1', 'my-loop-command')]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {
      loadDefaultCommands: false,
    });
    const errors = issues.filter(i => i.level === 'error');
    expect(errors).toHaveLength(0);
  });

  test('error with suggestions when loop.command target is missing', async () => {
    // Missing target should produce exactly one `field: 'loop.command'` error,
    // and the suggestions list should populate from `findSimilar` over the
    // already-discovered command names — the same affordance command-nodes get.
    await createCommandFile('archon-ralph-implement');
    const workflow = makeWorkflow('test', [makeLoopCommandNode('step1', 'archon-ralph-implemen')]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {
      loadDefaultCommands: false,
    });
    const errors = issues.filter(i => i.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('loop.command');
    expect(errors[0].nodeId).toBe('step1');
    expect(errors[0].message).toContain("Command 'archon-ralph-implemen' not found");
    expect(errors[0].suggestions).toContain('archon-ralph-implement');
  });

  test('error for invalid (unsafe) loop.command name', async () => {
    // Defense-in-depth: the loop schema's superRefine already rejects unsafe
    // names at parse time, but a programmatically-constructed workflow can
    // bypass that path. The validator must still flag it with a clear
    // `field: 'loop.command'` error rather than treating it as a missing file.
    const workflow = makeWorkflow('test', [makeLoopCommandNode('step1', '../escape')]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {
      loadDefaultCommands: false,
    });
    const errors = issues.filter(i => i.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('loop.command');
    expect(errors[0].message).toContain('Invalid command name');
  });

  test('no issues when loop.command resolves to a bundled packaged command', async () => {
    // A `loop.command` naming a shipped pack command must resolve when defaults are
    // loaded, even with an empty repo `.archon/commands/` — the same resolution
    // command-nodes already get.
    const command = formatPackagedResourceReference(
      { source: 'bundled', pack: 'sdlc', workflow: 'deliver' },
      'classify-review-scope'
    );
    const workflow = makeWorkflow('test', [makeLoopCommandNode('step1', command)]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const errors = issues.filter(i => i.level === 'error' && i.field === 'loop.command');
    expect(errors).toHaveLength(0);
  });

  // --- Home-scoped resolution: mirrors the equivalent command-node test path.
  // Uses the same ARCHON_HOME swap as the existing home-scope block so the
  // walks of repo / home / bundled all see the temp dirs.
  describe('home-scoped loop.command', () => {
    let homeDir: string;
    const originalArchonHome = process.env.ARCHON_HOME;
    const originalArchonDocker = process.env.ARCHON_DOCKER;

    beforeEach(async () => {
      homeDir = await mkdtemp(join(tmpdir(), 'validator-loop-home-'));
      process.env.ARCHON_HOME = homeDir;
      delete process.env.ARCHON_DOCKER;
    });

    afterEach(async () => {
      await rm(homeDir, { recursive: true, force: true });
      if (originalArchonHome === undefined) {
        delete process.env.ARCHON_HOME;
      } else {
        process.env.ARCHON_HOME = originalArchonHome;
      }
      if (originalArchonDocker === undefined) {
        delete process.env.ARCHON_DOCKER;
      } else {
        process.env.ARCHON_DOCKER = originalArchonDocker;
      }
    });

    async function createHomeCommand(name: string, content = '# Home helper'): Promise<void> {
      const dir = join(homeDir, 'commands');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${name}.md`), content);
    }

    test('resolves a loop.command placed under ~/.archon/commands/', async () => {
      await createHomeCommand('only-in-home-loop');
      const workflow = makeWorkflow('test', [makeLoopCommandNode('step1', 'only-in-home-loop')]);
      const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {
        loadDefaultCommands: false,
      });
      const errors = issues.filter(i => i.level === 'error');
      expect(errors).toHaveLength(0);
    });
  });
});

// =============================================================================
// validateWorkflowResources — MCP validation
// =============================================================================

describe('validateWorkflowResources — MCP validation', () => {
  test('error when MCP config file is missing', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'step1',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'do stuff' },
        mcp: 'missing.json',
      } as unknown as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    expect(issues.some(i => i.field === 'mcp' && i.level === 'error')).toBe(true);
  });

  test('error when MCP config has invalid JSON', async () => {
    const mcpPath = join(tmpDir, 'bad.json');
    await writeFile(mcpPath, '{bad json');
    const workflow = makeWorkflow('test', [
      {
        id: 'step1',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'do stuff' },
        mcp: mcpPath,
      } as unknown as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const mcpErrors = issues.filter(i => i.field === 'mcp' && i.level === 'error');
    expect(mcpErrors).toHaveLength(1);
    expect(mcpErrors[0].message).toContain('invalid JSON');
  });

  test('error when MCP config is an array instead of object', async () => {
    const mcpPath = join(tmpDir, 'array.json');
    await writeFile(mcpPath, '[]');
    const workflow = makeWorkflow('test', [
      {
        id: 'step1',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'do stuff' },
        mcp: mcpPath,
      } as unknown as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const mcpErrors = issues.filter(i => i.field === 'mcp' && i.level === 'error');
    expect(mcpErrors).toHaveLength(1);
    expect(mcpErrors[0].message).toContain('JSON object');
  });

  test('no error when MCP config is a valid JSON object', async () => {
    const mcpPath = join(tmpDir, 'good.json');
    await writeFile(mcpPath, '{"server": {"command": "npx"}}');
    const workflow = makeWorkflow('test', [
      {
        id: 'step1',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'do stuff' },
        mcp: mcpPath,
      } as unknown as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const mcpErrors = issues.filter(i => i.field === 'mcp' && i.level === 'error');
    expect(mcpErrors).toHaveLength(0);
  });

  test('does not warn when MCP is used with codex provider', async () => {
    const mcpPath = join(tmpDir, 'good.json');
    await writeFile(mcpPath, '{"server": {"command": "npx"}}');
    const workflow = makeWorkflow(
      'test',
      [
        {
          id: 'step1',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'do stuff' },
          mcp: mcpPath,
        } as unknown as DagNode,
      ],
      'codex'
    );
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const mcpWarnings = issues.filter(i => i.field === 'mcp' && i.level === 'warning');
    expect(mcpWarnings).toHaveLength(0);
  });

  test('MCP on a provider without the capability is an error', async () => {
    const mcpPath = join(tmpDir, 'good.json');
    await writeFile(mcpPath, '{"server": {"command": "npx"}}');
    const workflow = makeWorkflow(
      'test',
      [
        {
          id: 'step1',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'do stuff' },
          mcp: mcpPath,
        } as unknown as DagNode,
      ],
      'pi'
    );
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const error = issues.find(i => i.field === 'mcp' && i.level === 'error');
    expect(error?.message).toContain("Provider 'pi' cannot load MCP servers");
  });
});

// =============================================================================
// validateCommand
// =============================================================================

describe('validateCommand', () => {
  test('valid for non-empty command file', async () => {
    await createCommandFile('my-command', '# Do something useful');
    const result = await validateCommand('my-command', tmpDir, { loadDefaultCommands: false });
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  test('error for empty command file', async () => {
    await createCommandFile('empty-cmd', '   \n  ');
    const result = await validateCommand('empty-cmd', tmpDir, { loadDefaultCommands: false });
    expect(result.valid).toBe(false);
    expect(result.issues[0].field).toBe('content');
  });

  test('error for invalid command name', async () => {
    const result = await validateCommand('../escape', tmpDir);
    expect(result.valid).toBe(false);
    expect(result.issues[0].field).toBe('name');
  });

  test('error for missing command with suggestions', async () => {
    await createCommandFile('assist');
    const result = await validateCommand('asist', tmpDir, { loadDefaultCommands: false });
    expect(result.valid).toBe(false);
    expect(result.issues[0].suggestions).toContain('assist');
  });
});

// =============================================================================
// discoverAvailableCommands
// =============================================================================

describe('discoverAvailableCommands', () => {
  test('finds commands in .archon/commands/', async () => {
    await createCommandFile('my-command');
    await createCommandFile('other-command');
    const commands = await discoverAvailableCommands(tmpDir, { loadDefaultCommands: false });
    expect(commands).toContain('my-command');
    expect(commands).toContain('other-command');
  });

  test('returns sorted list', async () => {
    await createCommandFile('zebra');
    await createCommandFile('alpha');
    const commands = await discoverAvailableCommands(tmpDir, { loadDefaultCommands: false });
    expect(commands).toEqual(['alpha', 'zebra']);
  });

  test('returns empty array when no commands directory', async () => {
    const commands = await discoverAvailableCommands(tmpDir, { loadDefaultCommands: false });
    expect(commands).toEqual([]);
  });

  test.skipIf(process.platform === 'win32')('finds symlinked project commands', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'validator-command-source-'));
    try {
      await writeFile(join(sourceDir, 'linked.md'), '# Linked command');
      const commandsDir = join(tmpDir, '.archon', 'commands');
      await mkdir(commandsDir, { recursive: true });
      await fsSymlink(join(sourceDir, 'linked.md'), join(commandsDir, 'linked.md'));

      const commands = await discoverAvailableCommands(tmpDir, { loadDefaultCommands: false });

      expect(commands).toContain('linked');
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  test('loadDefaultCommands: false suppresses bundled commands', async () => {
    const withDefaults = await discoverAvailableCommands(tmpDir, { loadDefaultCommands: true });
    const without = await discoverAvailableCommands(tmpDir, { loadDefaultCommands: false });
    expect(withDefaults.length).toBeGreaterThanOrEqual(without.length);
  });

  // --- Home-scoped commands (~/.archon/commands/) — new capability
  describe('home-scoped commands', () => {
    async function createHomeCommand(name: string, content = '# Home helper'): Promise<void> {
      const dir = join(tmpHomeDir, 'commands');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${name}.md`), content);
    }

    test('discovers commands placed at ~/.archon/commands/', async () => {
      await createHomeCommand('my-personal-helper');
      const commands = await discoverAvailableCommands(tmpDir, { loadDefaultCommands: false });
      expect(commands).toContain('my-personal-helper');
    });

    test('resolveCommand (via validateCommand) finds home-scoped commands when repo has none', async () => {
      await createHomeCommand('only-in-home');
      const result = await validateCommand('only-in-home', tmpDir, { loadDefaultCommands: false });
      expect(result.valid).toBe(true);
    });

    test('repo command overrides home command with the same name', async () => {
      await createHomeCommand('shared', '# Home version');
      await createCommandFile('shared', '# Repo version');
      const result = await validateCommand('shared', tmpDir, { loadDefaultCommands: false });
      expect(result.valid).toBe(true);
    });
  });
});

// =============================================================================
// validateWorkflowResources — script nodes
// =============================================================================

describe('validateWorkflowResources — script nodes', () => {
  test('error when named bun script file does not exist', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'step1',
        kind: 'exec',
        script: 'nonexistent-script',
        runtime: 'bun',
      } as unknown as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const errors = issues.filter(i => i.level === 'error' && i.field === 'script');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Named script 'nonexistent-script' not found");
    expect(errors[0].nodeId).toBe('step1');
  });

  test('error when named uv script file does not exist', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'step1',
        kind: 'exec',
        script: 'missing-py-script',
        runtime: 'uv',
      } as unknown as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const errors = issues.filter(i => i.level === 'error' && i.field === 'script');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Named script 'missing-py-script' not found");
    expect(errors[0].hint).toContain('.py');
  });

  test('no error when named bun script file exists', async () => {
    const scriptsDir = join(tmpDir, '.archon', 'scripts');
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, 'my-script.ts'), 'console.log("hi")');
    const workflow = makeWorkflow('test', [
      { id: 'step1', kind: 'exec', script: 'my-script', runtime: 'bun' } as unknown as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const scriptErrors = issues.filter(i => i.level === 'error' && i.field === 'script');
    expect(scriptErrors).toHaveLength(0);
  });

  test('no error for inline bun script (no file lookup needed)', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'step1',
        kind: 'exec',
        script: 'console.log("inline")',
        runtime: 'bun',
      } as unknown as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const scriptErrors = issues.filter(i => i.level === 'error' && i.field === 'script');
    expect(scriptErrors).toHaveLength(0);
  });

  test('pack modules are not targets while an existing _shared workflow keeps its scripts', async () => {
    const packDir = join(tmpDir, '.archon', 'workflows', 'team-pack');
    await mkdir(join(packDir, '.shared'), { recursive: true });
    await mkdir(join(packDir, '_shared', 'scripts'), { recursive: true });
    await writeFile(join(packDir, '.shared', 'helper.ts'), 'export const value = 1;');
    await writeFile(join(packDir, '_shared', 'scripts', 'existing.ts'), 'console.log(1);');
    for (const [owner, name, expectedErrors] of [
      ['release', 'helper', 1],
      ['_shared', 'existing', 0],
    ] as const) {
      const script = formatPackagedResourceReference(
        { source: 'project', pack: 'team-pack', workflow: owner },
        name
      );
      const workflow = makeTestWorkflow({
        name: 'test',
        nodes: [{ id: 'run', script, runtime: 'bun' }],
      });
      const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
      expect(
        issues.filter(issue => issue.level === 'error' && issue.field === 'script')
      ).toHaveLength(expectedErrors);
    }
  });

  test('validates a named script inside its owning packaged workflow', async () => {
    const scriptsDir = join(tmpDir, '.archon', 'workflows', 'team-pack', 'release', 'scripts');
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, 'publish.ts'), 'console.log("publish")');
    const script = formatPackagedResourceReference(
      { source: 'project', pack: 'team-pack', workflow: 'release' },
      'publish'
    );
    const workflow = makeTestWorkflow({
      name: 'test',
      nodes: [{ id: 'step1', script, runtime: 'bun' }],
    });

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    expect(
      issues.filter(issue => issue.level === 'error' && issue.field === 'script')
    ).toHaveLength(0);
  });
});

// =============================================================================
// validateWorkflowResources — inline agents capability warning
// =============================================================================

describe('validateWorkflowResources — agents capability', () => {
  const agentsField = {
    'brief-gen': { description: 'd', prompt: 'p' },
  };

  test('warns when provider does not support inline agents (codex)', async () => {
    const workflow = makeWorkflow(
      'test',
      [
        {
          id: 'step1',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'p' },
          agents: agentsField,
        } as unknown as DagNode,
      ],
      'codex'
    );
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const warning = issues.find(i => i.level === 'warning' && i.field === 'agents');
    expect(warning).toBeDefined();
    expect(warning!.message).toContain("not supported by provider 'codex'");
    expect(warning!.hint).toContain('claude');
  });

  test('no agents-capability warning when provider is claude', async () => {
    const workflow = makeWorkflow(
      'test',
      [
        {
          id: 'step1',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'p' },
          agents: agentsField,
        } as unknown as DagNode,
      ],
      'claude'
    );
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const warning = issues.find(i => i.level === 'warning' && i.field === 'agents');
    expect(warning).toBeUndefined();
  });

  test('no warning when node has no agents field', async () => {
    const workflow = makeWorkflow(
      'test',
      [
        {
          id: 'step1',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'p' },
        } as unknown as DagNode,
      ],
      'codex'
    );
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const warning = issues.find(i => i.level === 'warning' && i.field === 'agents');
    expect(warning).toBeUndefined();
  });
});

// =============================================================================
// validateWorkflowResources — tool-name validation (#2084)
// =============================================================================

describe('validateWorkflowResources — tool-name validation', () => {
  function nodeWithTools(tools: { allowed_tools?: string[]; denied_tools?: string[] }): DagNode {
    return {
      id: 'step1',
      kind: 'agent',
      source: { kind: 'inline', prompt: 'p' },
      ...tools,
    } as unknown as DagNode;
  }

  const isToolNameWarning = (field: string) => (i: { level: string; field: string }) =>
    i.level === 'warning' && i.field === field;

  test('warns on unknown tool name with did-you-mean suggestion', async () => {
    const workflow = makeWorkflow('test', [nodeWithTools({ allowed_tools: ['Bsh'] })], 'claude');
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const warning = issues.find(isToolNameWarning('allowed_tools'));
    expect(warning).toBeDefined();
    expect(warning!.message).toContain("Unknown tool 'Bsh'");
    expect(warning!.message).toContain('silently ignored');
    expect(warning!.suggestions).toContain('Bash');
  });

  test('warns on renamed tool (Task → Agent) in denied_tools with targeted hint', async () => {
    const workflow = makeWorkflow('test', [nodeWithTools({ denied_tools: ['Task'] })], 'claude');
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const warning = issues.find(isToolNameWarning('denied_tools'));
    expect(warning).toBeDefined();
    expect(warning!.message).toContain("renamed to 'Agent'");
    expect(warning!.suggestions).toEqual(['Agent']);
  });

  test('no warning for valid built-in tool names', async () => {
    const workflow = makeWorkflow(
      'test',
      [
        nodeWithTools({
          allowed_tools: ['Read', 'Glob', 'Grep', 'WebSearch'],
          denied_tools: ['Write', 'Edit', 'Bash', 'Agent'],
        }),
      ],
      'claude'
    );
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    expect(issues.find(isToolNameWarning('allowed_tools'))).toBeUndefined();
    expect(issues.find(isToolNameWarning('denied_tools'))).toBeUndefined();
  });

  test('no warning for MCP tool names and wildcards', async () => {
    const workflow = makeWorkflow(
      'test',
      [
        nodeWithTools({
          allowed_tools: ['mcp__github__create_issue', 'mcp__server__*', 'mcp__server'],
        }),
      ],
      'claude'
    );
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    expect(issues.find(isToolNameWarning('allowed_tools'))).toBeUndefined();
  });

  test('validates the base name of permission-rule specifiers', async () => {
    const workflow = makeWorkflow(
      'test',
      [nodeWithTools({ allowed_tools: ['Bash(git:*)', 'Bsh(git:*)'] })],
      'claude'
    );
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const warnings = issues.filter(isToolNameWarning('allowed_tools'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("Unknown tool 'Bsh'");
  });

  test('no warning when provider declares no tool vocabulary (pi)', async () => {
    const workflow = makeWorkflow('test', [nodeWithTools({ denied_tools: ['Task'] })], 'pi');
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    expect(issues.find(isToolNameWarning('denied_tools'))).toBeUndefined();
    // pi supports tool restrictions, so the capability warning must not fire either
    expect(issues.find(isToolNameWarning('allowed_tools/denied_tools'))).toBeUndefined();
  });

  test('unknown-tool warning is advisory — workflow still validates', async () => {
    const workflow = makeWorkflow('test', [nodeWithTools({ denied_tools: ['Task'] })], 'claude');
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    expect(issues.some(isToolNameWarning('denied_tools'))).toBe(true);
    expect(makeWorkflowResult('test', issues).valid).toBe(true);
  });

  test('empty allowed_tools produces no warning', async () => {
    const workflow = makeWorkflow('test', [nodeWithTools({ allowed_tools: [] })], 'claude');
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    expect(issues.find(isToolNameWarning('allowed_tools'))).toBeUndefined();
  });
});

// =============================================================================
// validateWorkflowResources — bash output-ref lint
// =============================================================================

describe('validateWorkflowResources — bash output-ref lint', () => {
  test('no warning when bash uses correct unquoted idiom', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'check',
        kind: 'exec',
        runtime: 'sh',
        script: 'status=$node.output.field\n[ "$status" = "ok" ] && echo pass',
      } as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const warnings = issues.filter(i => i.level === 'warning' && i.field === 'bash');
    expect(warnings).toHaveLength(0);
  });

  test.each([
    'echo $emit.output',
    'printf "%s" $emit.output.status',
    'echo $(cat $emit.output)',
    '[ -n $emit.output ]',
    '[[ $LOOP_PREV.emit.output.status = ok ]]',
    'cat > $emit.output',
    'echo value=$emit.output',
    'value=prefix$emit.output',
    'value=$emit.output/suffix',
    'echo \\;value=$emit.output',
    'echo "literal <<EOF"\necho $emit.output',
    'echo value=#$emit.output',
    'echo $((1 << MASK))\necho $emit.output',
    '(( flags << SHIFT ))\necho $emit.output',
  ])('warns on unsafe shell position: %s', async script => {
    const workflow = makeWorkflow('test', [{ id: 'check', kind: 'exec', runtime: 'sh', script }]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const warnings = issues.filter(i => i.field === 'bash');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].level).toBe('warning');
    expect(warnings[0].message).toContain('bare');
    expect(warnings[0].hint).toContain('"$var"');
    expect(makeWorkflowResult('test', issues).valid).toBe(true);
  });

  test.each([
    'value=$emit.output; printf "%s" "$value"',
    'export value=$emit.output.status',
    'local value=$LOOP_PREV.emit.output.status',
    'first=ok value=$emit.output',
    'export first=ok value=$emit.output',
    'first="two words" value=$emit.output',
    'local first="two words" value=$emit.output',
    'value=$emit.output>result',
    'value=$LOOP_PREV.emit.output.status<input',
  ])('accepts complete assignment RHS: %s', async script => {
    const workflow = makeWorkflow('test', [{ id: 'check', kind: 'exec', runtime: 'sh', script }]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    expect(issues.filter(i => i.field === 'bash')).toHaveLength(0);
  });

  test.each([
    'cat <<EOF\n$emit.output\nEOF',
    'cat <<\'EOF\'\n"$emit.output"\nEOF',
    'cat <<-EOF\n\t$emit.output\n\tEOF',
    'cat <<\\EOF\n$emit.output\nEOF',
  ])('ignores heredoc contents and resumes checking after the delimiter', async script => {
    const workflow = makeWorkflow('test', [{ id: 'check', kind: 'exec', runtime: 'sh', script }]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    expect(issues.filter(i => i.field === 'bash')).toHaveLength(0);

    const continued = makeWorkflow('test', [
      { id: 'check', kind: 'exec', runtime: 'sh', script: `${script}\necho $emit.output` },
    ]);
    const continuedIssues = await validateWorkflowResources(continued, tmpDir, providerRegistry);
    const warnings = continuedIssues.filter(i => i.field === 'bash');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('bare');
  });

  test('warns on a bare ref in loop until_bash', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'gen',
        kind: 'loop',
        loop: {
          prompt: 'produce output',
          until_bash: '[ -n $emit.output ]',
          max_iterations: 2,
          fresh_context: false,
        },
      },
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    expect(issues.find(i => i.field === 'loop.until_bash')?.message).toContain('bare');
  });

  test('retains both warnings when a shell slot contains quoted and bare refs', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'check',
        kind: 'exec',
        runtime: 'sh',
        script: 'echo "$emit.output"; echo $emit.output',
      },
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    expect(issues.filter(i => i.field === 'bash').map(i => i.message)).toEqual([
      expect.stringContaining('bare'),
      expect.stringContaining('wrapping'),
    ]);
  });

  test('warning when bash body has double-quoted $nodeId.output.field', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'check',
        kind: 'exec',
        runtime: 'sh',
        script: 'status="$emit.output.status"\n[ "$status" = "ok" ] && echo pass',
      } as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const warnings = issues.filter(i => i.level === 'warning' && i.field === 'bash');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].nodeId).toBe('check');
    expect(warnings[0].message).toContain('wrapping');
    expect(warnings[0].hint).toContain('var=$node.output.field');
  });

  test('warning when $nodeId.output is embedded inside a double-quoted string', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'check',
        kind: 'exec',
        runtime: 'sh',
        script: 'echo "result: $emit.output.status"',
      } as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const warnings = issues.filter(i => i.level === 'warning' && i.field === 'bash');
    expect(warnings).toHaveLength(1);
  });

  test('script nodes are exempt from the quoted-output lint', async () => {
    // A `bun` script is not shell source, so quoting a ref there is correct TypeScript.
    // Asserted across every field, not just `bash`: the lint selects fields by the
    // template walker's `shell` surface, and dropping that filter would report the
    // `script` slot (and prompts, and conditions) under their own field names.
    const workflow = makeWorkflow('test', [
      {
        id: 'check',
        kind: 'exec',
        script: 'const status = "$emit.output.status";\nconsole.log(status);',
        runtime: 'bun',
      } as unknown as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    expect(issues.filter(i => i.message.includes('wrapping'))).toHaveLength(0);
  });

  test('warning when bash body has single-quoted $nodeId.output.field', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'check',
        kind: 'exec',
        runtime: 'sh',
        script: "status='$emit.output.status'",
      } as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const warnings = issues.filter(i => i.level === 'warning' && i.field === 'bash');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('wrapping');
  });

  test('warns on single-quoted output refs in loop and loop_group until_bash', async () => {
    // until_bash substitutes through the same pre-quoting path, so the single-quoted
    // form is as wrong there as in a bash body. The loop_group case uses the
    // $LOOP_PREV grammar, which the lint has to look for separately — a plain
    // $id.output pattern does not match it.
    const workflow = makeWorkflow('test', [
      {
        id: 'loop-single',
        prompt: 'produce output',
        kind: 'loop',
        loop: {
          until: 'DONE',
          until_bash: "status='$emit.output.status'",
        },
      } as unknown as DagNode,
      {
        id: 'group-single',
        kind: 'loop_group',
        loop_group: {
          until_bash: "status='$LOOP_PREV.probe.output.status'",
          max_iterations: 2,
          nodes: [{ id: 'probe', kind: 'exec', runtime: 'sh', script: 'echo pending' }],
        },
      } as unknown as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const warnings = issues.filter(i => i.level === 'warning');
    expect(warnings.map(warning => [warning.nodeId, warning.field])).toEqual([
      ['loop-single', 'loop.until_bash'],
      ['group-single', 'loop_group.until_bash'],
    ]);
  });

  test('no false positive: prose apostrophes and heredoc bodies elsewhere in the script', async () => {
    // Both bodies are reduced from shipped workflows that a whole-body quote scanner
    // reported (archon-deliver's flip-ready, t1-fix-issue's open-pr). In `commented`
    // the apostrophe of "gh's" opens nothing because it is mid-word; in `heredoc` the
    // `--body "$(cat <<...` double quote stays open to the end of its own line, and
    // only line-locality stops it from reaching the refs on the lines below. Every
    // ref in both bodies is correctly unquoted.
    const workflow = makeWorkflow('test', [
      {
        id: 'commented',
        kind: 'exec',
        runtime: 'sh',
        script:
          '# --repo pins to origin: gh\'s default resolution targets the parent.\nPR_NUMBER=$pr.output.number\necho "$PR_NUMBER"',
      } as DagNode,
      {
        id: 'heredoc',
        kind: 'exec',
        runtime: 'sh',
        script:
          'gh pr create --title "fix" --body "$(cat <<\'ARCHON_EOF\'\n## Assessment\n$assess.output.reason\nARCHON_EOF\n)"',
      } as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const warnings = issues.filter(i => i.level === 'warning' && i.field === 'bash');
    expect(warnings).toHaveLength(0);
  });

  test("no false positive: an unbalanced apostrophe earlier on the ref's own line", async () => {
    // Line-locality alone does not cover this: the apostrophe is on the SAME line as
    // the ref and never closes, so only the operand-boundary rule (a quote must open
    // at line start, after `=`, or after whitespace) keeps `$build.output.score` —
    // which is correctly unquoted — from being reported.
    const workflow = makeWorkflow('test', [
      {
        id: 'check',
        kind: 'exec',
        runtime: 'sh',
        script: "echo don't; result=$build.output.score",
      } as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const warnings = issues.filter(i => i.level === 'warning' && i.field === 'bash');
    expect(warnings).toHaveLength(0);
  });

  test('no false positive: a prior double-quoted string before an unquoted ref on the same line', async () => {
    // The closing `"` of "Build complete." must NOT seed a match that slides across
    // the `;` to the correctly-unquoted $build.output.score.
    const workflow = makeWorkflow('test', [
      {
        id: 'check',
        kind: 'exec',
        runtime: 'sh',
        script: 'echo "Build complete."; result=$build.output.score',
      } as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const warnings = issues.filter(i => i.level === 'warning' && i.field === 'bash');
    expect(warnings).toHaveLength(0);
  });

  test('no false positive: a prior single-quoted string before an unquoted ref on the same line', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'check',
        kind: 'exec',
        runtime: 'sh',
        script: "echo 'Build complete.'; result=$build.output.score",
      } as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const warnings = issues.filter(i => i.level === 'warning' && i.field === 'bash');
    expect(warnings).toHaveLength(0);
  });

  test('warns on a double-quoted $node.output in a loop until_bash', async () => {
    // until_bash substitutes with the same escapedForBash=true path as bash nodes,
    // so the footgun applies there too.
    const workflow = makeWorkflow('test', [
      {
        id: 'gen',
        prompt: 'produce output',
        kind: 'loop',
        loop: {
          until: 'DONE',
          until_bash: 'status="$emit.output.status" && [ "$status" = "done" ]',
        },
      } as unknown as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const warnings = issues.filter(i => i.level === 'warning' && i.field === 'loop.until_bash');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('wrapping');
  });

  test('warns on double-quoted output refs in top-level and nested loop_groups', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'outer',
        kind: 'loop_group',
        loop_group: {
          until_bash: 'test "$inner.output.state" = done',
          max_iterations: 2,
          nodes: [
            {
              id: 'inner',
              kind: 'loop_group',
              loop_group: {
                until_bash: 'test "$LOOP_PREV.probe.output.state" != "pending"',
                max_iterations: 2,
                nodes: [{ id: 'probe', kind: 'exec', runtime: 'sh', script: 'echo pending' }],
              },
            } as unknown as DagNode,
          ],
        },
      } as unknown as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const warnings = issues.filter(i => i.level === 'warning');
    // Every warning is listed, not just the ones on the expected field: a body node is
    // reached once through the validator's own flattening, so the lint must not also
    // walk into loop_group bodies and report `inner` a second time under a nested path.
    expect(warnings.map(warning => [warning.nodeId, warning.field])).toEqual([
      ['outer', 'loop_group.until_bash'],
      ['inner', 'loop_group.until_bash'],
    ]);
    expect(warnings.every(warning => warning.message.includes('wrapping'))).toBe(true);
  });

  test('warns on a bare output ref in loop_group until_bash', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'group',
        kind: 'loop_group',
        loop_group: {
          until_bash: 'test $probe.output.state != "pending"',
          max_iterations: 2,
          nodes: [{ id: 'probe', kind: 'exec', runtime: 'sh', script: 'echo pending' }],
        },
      } as unknown as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    expect(issues.find(i => i.field === 'loop_group.until_bash')?.message).toContain('bare');
  });
});

// =============================================================================
// validateWorkflowResources — skills search roots (#2178)
// =============================================================================

describe('validateWorkflowResources — skills search roots', () => {
  // The validator must accept skills anywhere the runtime resolver
  // (skillSearchRoots in @archon/paths/skills) would find them: .agents/skills/
  // and .claude/skills/, at both project (cwd) and user (HOME) level.
  let originalHome: string | undefined;
  let fakeHome: string;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    // Point HOME at a temp dir so real user-level skills can't leak in.
    fakeHome = await mkdtemp(join(tmpdir(), 'validator-skills-home-'));
    process.env.HOME = fakeHome;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(fakeHome, { recursive: true, force: true });
  });

  async function stageSkill(
    base: string,
    subdir: '.agents' | '.claude',
    name: string
  ): Promise<void> {
    const dir = join(base, subdir, 'skills', name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), `# ${name}\n`);
  }

  function skillsWorkflow(skillName: string): WorkflowDefinition {
    return makeWorkflow(
      'test',
      [
        {
          id: 'step1',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'do work' },
          skills: [skillName],
        } as unknown as DagNode,
      ],
      'claude'
    );
  }

  function missingSkillIssues(issues: Awaited<ReturnType<typeof validateWorkflowResources>>) {
    return issues.filter(i => i.field === 'skills' && i.message.includes('not found'));
  }

  test('Claude rejects a skill installed only under <cwd>/.agents/skills/', async () => {
    await stageSkill(tmpDir, '.agents', 'my-skill');
    const issues = await validateWorkflowResources(
      skillsWorkflow('my-skill'),
      tmpDir,
      providerRegistry
    );
    const missing = missingSkillIssues(issues);
    expect(missing).toHaveLength(1);
    expect(missing[0].level).toBe('error');
    expect(missing[0].message).toContain('.claude/skills/');
  });

  test('Claude accepts a skill under <cwd>/.claude/skills/', async () => {
    await stageSkill(tmpDir, '.claude', 'my-skill');
    const issues = await validateWorkflowResources(
      skillsWorkflow('my-skill'),
      tmpDir,
      providerRegistry
    );
    expect(missingSkillIssues(issues)).toHaveLength(0);
  });

  test('Claude rejects a skill installed only under ~/.agents/skills/', async () => {
    await stageSkill(fakeHome, '.agents', 'home-skill');
    const issues = await validateWorkflowResources(
      skillsWorkflow('home-skill'),
      tmpDir,
      providerRegistry
    );
    const missing = missingSkillIssues(issues);
    expect(missing).toHaveLength(1);
    expect(missing[0].level).toBe('error');
  });

  test('Claude accepts a skill under ~/.claude/skills/', async () => {
    await stageSkill(fakeHome, '.claude', 'home-skill');
    const issues = await validateWorkflowResources(
      skillsWorkflow('home-skill'),
      tmpDir,
      providerRegistry
    );
    expect(missingSkillIssues(issues)).toHaveLength(0);
  });

  test('Claude accepts a user skill from the configured CLAUDE_CONFIG_DIR', async () => {
    const configDir = join(fakeHome, 'custom-claude-config');
    const skillDir = join(configDir, 'skills', 'custom-user-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '# custom user skill\n');

    const issues = await validateWorkflowResources(
      skillsWorkflow('custom-user-skill'),
      tmpDir,
      providerRegistry,
      {
        claudeConfigDir: configDir,
      }
    );

    expect(missingSkillIssues(issues)).toHaveLength(0);
  });

  test('Claude rejects a HOME skill when configured CLAUDE_CONFIG_DIR replaces user scope', async () => {
    await stageSkill(fakeHome, '.claude', 'home-only');
    const configDir = join(fakeHome, 'empty-custom-claude-config');

    const issues = await validateWorkflowResources(
      skillsWorkflow('home-only'),
      tmpDir,
      providerRegistry,
      {
        claudeConfigDir: configDir,
      }
    );

    expect(missingSkillIssues(issues)).toHaveLength(1);
  });

  test('Claude warns, not errors, when the skill is on no root at all', async () => {
    // A name absent from every filesystem root may still be one of Claude's
    // built-in skills or a `plugin:skill` entry — neither lives under a skills
    // directory. Erroring here would make those undeclarable (PR #2535 review).
    const issues = await validateWorkflowResources(
      skillsWorkflow('nonexistent-skill'),
      tmpDir,
      providerRegistry
    );
    const missing = missingSkillIssues(issues);
    expect(missing).toHaveLength(1);
    expect(missing[0].level).toBe('warning');
    expect(missing[0].nodeId).toBe('step1');
    expect(missing[0].message).toContain("Claude skill 'nonexistent-skill' not found");
    expect(missing[0].message).toContain('built-in');
    expect(missing[0].hint).toContain('.claude/skills/nonexistent-skill/SKILL.md');
  });

  test('Claude skill directory without SKILL.md still errors', async () => {
    // An empty directory is not a valid skill — the resolver requires SKILL.md.
    await mkdir(join(tmpDir, '.claude', 'skills', 'empty-skill'), { recursive: true });
    const issues = await validateWorkflowResources(
      skillsWorkflow('empty-skill'),
      tmpDir,
      providerRegistry
    );
    const missing = missingSkillIssues(issues);
    expect(missing).toHaveLength(1);
    expect(missing[0].level).toBe('error');
  });

  test('Pi keeps accepting the shared .agents skill root', async () => {
    await stageSkill(tmpDir, '.agents', 'portable-skill');
    const workflow = makeWorkflow(
      'test',
      [
        {
          id: 'step1',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'do work' },
          skills: ['portable-skill'],
        } as unknown as DagNode,
      ],
      'pi'
    );

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    expect(missingSkillIssues(issues)).toHaveLength(0);
  });

  test('Codex rejects YAML skills without four-root validation', async () => {
    await stageSkill(tmpDir, '.claude', 'claude-only');
    const workflow = makeWorkflow(
      'test',
      [
        {
          id: 'step1',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'do work' },
          skills: ['claude-only'],
        } as unknown as DagNode,
      ],
      'codex'
    );

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    expect(missingSkillIssues(issues)).toHaveLength(0);
    const error = issues.find(issue => issue.level === 'error' && issue.field === 'skills');
    expect(error?.message).toContain("Provider 'codex' cannot load named skills");
    expect(error?.hint).toContain('$skill-name');
  });

  test('plugins on a provider without the capability is an error', async () => {
    const workflow = makeWorkflow(
      'test',
      [
        {
          id: 'step1',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'do work' },
          plugins: ['formatter@tools'],
        } as unknown as DagNode,
      ],
      'pi'
    );

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const error = issues.find(issue => issue.field === 'plugins');
    expect(error?.level).toBe('error');
    expect(error?.message).toContain("Provider 'pi' cannot load named plugins");
  });

  test('uses a node model alias provider for Claude skill validation', async () => {
    const workflow = makeWorkflow(
      'test',
      [
        {
          id: 'step1',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'do work' },
          model: '@claude-node',
          skills: ['missing'],
        } as unknown as DagNode,
      ],
      'codex'
    );

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {
      aliases: { '@claude-node': { provider: 'claude', model: 'sonnet' } },
      assistant: 'codex',
    });

    const missing = missingSkillIssues(issues);
    expect(missing).toHaveLength(1);
    // Claude-specific wording proves the alias-resolved provider drove the
    // check, rather than the workflow-level 'codex' default.
    expect(missing[0].message).toContain('Claude skill');
    expect(issues.some(issue => issue.message.includes("Provider 'codex' cannot load"))).toBe(
      false
    );
  });

  test('uses a workflow model alias provider for inherited Codex skill errors', async () => {
    const workflow = {
      ...skillsWorkflow('missing'),
      model: '@codex-workflow',
    } as WorkflowDefinition;

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {
      aliases: { '@codex-workflow': { provider: 'codex', model: 'gpt-5.5' } },
      assistant: 'claude',
    });

    expect(missingSkillIssues(issues)).toHaveLength(0);
    expect(
      issues.some(issue => issue.message.includes("Provider 'codex' cannot load named skills"))
    ).toBe(true);
  });

  test('Claude project-only settingSources rejects a user-only skill', async () => {
    await stageSkill(fakeHome, '.claude', 'user-only');

    const issues = await validateWorkflowResources(
      skillsWorkflow('user-only'),
      tmpDir,
      providerRegistry,
      {
        claudeSettingSources: ['project'],
      }
    );

    expect(missingSkillIssues(issues)).toHaveLength(1);
  });

  test('Claude user-only node settingSources rejects a project-only skill', async () => {
    await stageSkill(tmpDir, '.claude', 'project-only');
    const workflow = makeWorkflow(
      'test',
      [
        {
          id: 'step1',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'do work' },
          skills: ['project-only'],
          settingSources: ['user'],
        } as unknown as DagNode,
      ],
      'claude'
    );

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);

    expect(missingSkillIssues(issues)).toHaveLength(1);
  });

  test('Claude empty settingSources rejects every declared skill', async () => {
    await stageSkill(tmpDir, '.claude', 'disabled');
    const workflow = makeWorkflow(
      'test',
      [
        {
          id: 'step1',
          kind: 'agent',
          source: { kind: 'inline', prompt: 'do work' },
          skills: ['disabled'],
          settingSources: [],
        } as unknown as DagNode,
      ],
      'claude'
    );

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);

    expect(missingSkillIssues(issues)).toHaveLength(1);
  });
});

// =============================================================================
// validateWorkflowResources — declared contract compiles (#2453)
// =============================================================================

describe('validateWorkflowResources — output_format compiles', () => {
  test('no issue for the inert output_format on a loop_group itself', async () => {
    // The loader and this pass must agree: a group's own schema governs nothing, so a
    // dangling $ref there is not a contract failure here either.
    const workflow = makeWorkflow('test', [
      {
        id: 'group',
        kind: 'loop_group',
        output_format: { type: 'object', properties: { done: { $ref: '#/$defs/missing' } } },
        loop_group: {
          until_bash: 'exit 0',
          max_iterations: 1,
          nodes: [{ id: 'work', kind: 'exec', runtime: 'sh', script: 'echo done' }],
        },
      } as unknown as DagNode,
    ]);

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);

    expect(issues.filter(i => i.field === 'output_format')).toHaveLength(0);
  });

  test('error when a workflow: node declares output_format, naming the child returns: node', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'sub',
        kind: 'workflow',
        workflow: 'child-workflow',
        output_format: { type: 'object', properties: { green: { type: 'boolean' } } },
      } as DagNode,
    ]);

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const errors = issues.filter(i => i.field === 'output_format');
    expect(errors).toHaveLength(1);
    expect(errors[0].level).toBe('error');
    expect(errors[0].nodeId).toBe('sub');
    expect(errors[0].message).toBe(
      "Node 'sub' declares output_format on a workflow: node; the result contract belongs to the child's returns: node — declare it there"
    );
  });

  test('error when a declared output_format cannot be compiled', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'plan',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'emit the plan result' },
        output_format: { type: 'object', properties: { ready: { $ref: '#/$defs/missing' } } },
      } as DagNode,
    ]);

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    const errors = issues.filter(i => i.field === 'output_format');
    expect(errors).toHaveLength(1);
    expect(errors[0].level).toBe('error');
    expect(errors[0].nodeId).toBe('plan');
    expect(errors[0].message).toContain('cannot be compiled');
  });

  test('no issue for a compilable schema', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'plan',
        kind: 'agent',
        source: { kind: 'inline', prompt: 'emit the plan result' },
        output_format: {
          type: 'object',
          properties: { ready: { type: 'boolean' } },
          required: ['ready'],
        },
      } as DagNode,
    ]);

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry);
    expect(issues.filter(i => i.field === 'output_format')).toHaveLength(0);
  });
});

describe('validateWorkflowResources — strict-schema compatibility', () => {
  const looseSchema = {
    type: 'object',
    properties: { ready: { type: 'boolean' }, note: { type: 'string' } },
    required: ['ready'],
  };

  function makeAgent(id: string, extra: Partial<DagNode> = {}): DagNode {
    return {
      id,
      kind: 'agent',
      source: { kind: 'inline', prompt: `do ${id}` },
      ...extra,
    } as DagNode;
  }

  test('Codex-routed agent node with optional-by-omission reports error', async () => {
    const workflow = makeWorkflow('test', [makeAgent('plan', { output_format: looseSchema })]);

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {}, 'codex');
    const errs = issues.filter(i => i.field === 'output_format' && i.level === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].nodeId).toBe('plan');
    expect(errs[0].message).toContain('note');
    expect(errs[0].message).toContain('required');
  });

  test('Codex-routed nested bare object reports the node and schema path', async () => {
    const workflow = makeWorkflow('test', [
      makeAgent('scope', {
        output_format: {
          type: 'object',
          properties: { pr: { type: 'object' } },
          required: ['pr'],
        },
      }),
    ]);

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {}, 'codex');
    const errors = issues.filter(i => i.field === 'output_format' && i.level === 'error');

    expect(errors).toHaveLength(1);
    expect(errors[0].nodeId).toBe('scope');
    expect(errors[0].message).toContain('output_format.properties.pr');
    expect(errors[0].message).toContain("Provider 'codex'");
    expect(errors[0].hint).toContain('["object","null"]');
  });

  test('Claude-routed same schema reports nothing', async () => {
    const workflow = makeWorkflow('test', [makeAgent('plan', { output_format: looseSchema })]);

    const issues = await validateWorkflowResources(
      workflow,
      tmpDir,
      providerRegistry,
      {},
      'claude'
    );
    const errs = issues.filter(i => i.field === 'output_format' && i.level === 'error');
    expect(errs).toHaveLength(0);
  });

  test('loop_group body agent under Codex reports error', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'group',
        kind: 'loop_group',
        loop_group: {
          until_bash: 'exit 0',
          max_iterations: 1,
          nodes: [makeAgent('body', { output_format: looseSchema })],
        },
      } as unknown as DagNode,
    ]);

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {}, 'codex');
    const errs = issues.filter(i => i.field === 'output_format' && i.level === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].nodeId).toBe('body');
  });

  test('loop_group provider becomes the body provider during validation', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'group',
        kind: 'loop_group',
        provider: 'codex',
        loop_group: {
          until_bash: 'exit 0',
          max_iterations: 1,
          nodes: [makeAgent('body', { output_format: looseSchema })],
        },
      } as unknown as DagNode,
    ]);

    const issues = await validateWorkflowResources(
      workflow,
      tmpDir,
      providerRegistry,
      {},
      'claude'
    );
    const errors = issues.filter(i => i.field === 'output_format' && i.level === 'error');

    expect(errors).toHaveLength(1);
    expect(errors[0].nodeId).toBe('body');
    expect(errors[0].message).toContain("Provider 'codex'");
  });

  test("loop_group model's provider becomes the body provider during validation", async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'group',
        kind: 'loop_group',
        model: '@codex-group',
        loop_group: {
          until_bash: 'exit 0',
          max_iterations: 1,
          nodes: [makeAgent('body', { output_format: looseSchema })],
        },
      } as unknown as DagNode,
    ]);

    const issues = await validateWorkflowResources(
      workflow,
      tmpDir,
      providerRegistry,
      { aliases: { '@codex-group': { provider: 'codex', model: 'gpt-5.5' } } },
      'claude'
    );
    const errors = issues.filter(i => i.field === 'output_format' && i.level === 'error');

    expect(errors).toHaveLength(1);
    expect(errors[0].nodeId).toBe('body');
    expect(errors[0].message).toContain("Provider 'codex'");
  });

  test('loop_group inert schema under Codex is skipped', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'group',
        kind: 'loop_group',
        output_format: looseSchema,
        loop_group: {
          until_bash: 'exit 0',
          max_iterations: 1,
          nodes: [{ id: 'work', kind: 'exec', runtime: 'sh', script: 'echo done' }],
        },
      } as unknown as DagNode,
    ]);

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {}, 'codex');
    const errs = issues.filter(i => i.field === 'output_format' && i.level === 'error');
    expect(errs).toHaveLength(0);
  });

  test('workflow: node with loose schema under Codex does not double-report', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'sub',
        kind: 'workflow',
        workflow: 'child',
        output_format: looseSchema,
      } as DagNode,
    ]);

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {}, 'codex');
    const outputFormatIssues = issues.filter(
      i => i.field === 'output_format' && i.level === 'error'
    );
    // Ownership error fires; strict-schema error must NOT also fire.
    expect(outputFormatIssues).toHaveLength(1);
    expect(outputFormatIssues[0].message).toContain('returns:');
  });

  test('bash node with bare object output_format under Codex is not flagged', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'run',
        kind: 'exec',
        runtime: 'sh',
        script: 'echo {}',
        output_format: { type: 'object' },
      } as unknown as DagNode,
    ]);

    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {}, 'codex');
    const errs = issues.filter(i => i.field === 'output_format' && i.level === 'error');
    expect(errs).toHaveLength(0);
  });
});

describe('validateWorkflowResources — loose output schemas', () => {
  const looseSchema = {
    type: 'object',
    properties: { verdict: { type: 'string', enum: ['review', 'skip'] } },
  };

  test.each(['claude', 'pi', undefined])(
    'warns once with provider %s and remains valid',
    async provider => {
      const workflow = makeWorkflow('loose', [
        dagNodeSchema.parse({ id: 'classify', prompt: 'decide', output_format: looseSchema }),
      ]);
      const issues = await validateWorkflowResources(
        workflow,
        tmpDir,
        providerRegistry,
        {},
        provider
      );
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        level: 'warning',
        nodeId: 'classify',
        field: 'output_format',
      });
      expect(issues[0].message).toContain("Node 'classify'");
      expect(issues[0].message).toContain('required');
      expect(issues[0].message).toContain('additionalProperties: false');
      expect(makeWorkflowResult(workflow.name, issues).valid).toBe(true);
    }
  );

  test.each([
    ['object-or-null', { ...looseSchema, type: ['object', 'null'] }, 1],
    ['properties without type', { properties: looseSchema.properties }, 1],
    ['empty required', { ...looseSchema, required: [] }, 1],
    ['explicitly open', { ...looseSchema, additionalProperties: true }, 1],
    ['open record', { ...looseSchema, additionalProperties: { type: 'string' } }, 1],
    ['tight', { ...looseSchema, required: ['verdict'], additionalProperties: false }, 0],
    ['required only', { ...looseSchema, required: ['verdict'] }, 0],
    ['additionalProperties only', { ...looseSchema, additionalProperties: false }, 0],
    ['non-object', { type: 'string' }, 0],
    ['bare object', { type: 'object' }, 0],
  ])('%s schema warning count', async (_name, schema, count) => {
    const workflow = makeWorkflow('test', [
      dagNodeSchema.parse({ id: 'classify', prompt: 'decide', output_format: schema }),
    ]);
    const issues = await validateWorkflowResources(
      workflow,
      tmpDir,
      providerRegistry,
      {},
      'claude'
    );
    expect(issues.filter(i => i.field === 'output_format')).toHaveLength(count);
  });

  test('Codex strict-schema error suppresses the warning', async () => {
    const workflow = makeWorkflow('test', [
      dagNodeSchema.parse({ id: 'classify', prompt: 'decide', output_format: looseSchema }),
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir, providerRegistry, {}, 'codex');
    expect(issues.filter(i => i.field === 'output_format')).toEqual([
      expect.objectContaining({ level: 'error', nodeId: 'classify' }),
    ]);
  });

  test('checks enforced exec and loop schemas and body nodes, skipping inert kinds and wait', async () => {
    const nodes = [
      { id: 'bash', bash: 'echo {}' },
      { id: 'script', script: 'console.log("{}")', runtime: 'bun' },
      { id: 'loop', loop: { prompt: 'decide', until_bash: 'exit 0', max_iterations: 1 } },
      { id: 'gate', approval: { message: 'approve' } },
      { id: 'halt', cancel: 'stop' },
      {
        id: 'group',
        loop_group: {
          until_bash: 'exit 0',
          max_iterations: 1,
          nodes: [{ id: 'body', prompt: 'decide', output_format: looseSchema }],
        },
      },
    ].map(node => dagNodeSchema.parse({ ...node, output_format: looseSchema }));
    nodes.push(dagNodeSchema.parse({ id: 'wait', wait: { duration_ms: 1 } }));
    const issues = await validateWorkflowResources(
      makeWorkflow('test', nodes),
      tmpDir,
      providerRegistry,
      {},
      'claude'
    );
    expect(issues.filter(i => i.field === 'output_format').map(i => i.nodeId)).toEqual([
      'bash',
      'script',
      'loop',
      'body',
    ]);
  });

  test('bundled SDLC workflows have no loose output schema warnings', async () => {
    const names = Object.keys(BUNDLED_WORKFLOWS).filter(
      name => BUNDLED_WORKFLOW_OWNERS[name]?.pack === 'sdlc'
    );
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const { workflow, error } = parseWorkflow(BUNDLED_WORKFLOWS[name], name, providerRegistry);
      expect(error).toBeNull();
      if (!workflow) throw new Error(`Could not parse bundled workflow ${name}`);
      const issues = await validateWorkflowResources(
        workflow,
        tmpDir,
        providerRegistry,
        {},
        'claude'
      );
      expect(issues.filter(i => i.field === 'output_format' && i.level === 'warning')).toEqual([]);
    }
  });
});

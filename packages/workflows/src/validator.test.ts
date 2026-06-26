import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, symlink as fsSymlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { registerBuiltinProviders, clearRegistry } from '@archon/providers';

// Bootstrap provider registry (needed by capability-driven warnings in validator)
clearRegistry();
registerBuiltinProviders();

import {
  levenshtein,
  findSimilar,
  validateWorkflowResources,
  validateCommand,
  discoverAvailableCommands,
} from './validator';
import type { WorkflowDefinition, DagNode } from './schemas';

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

function makeWorkflow(name: string, nodes: DagNode[], provider?: string): WorkflowDefinition {
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
    const workflow = makeWorkflow('test', [{ id: 'step1', command: 'my-command' } as DagNode]);
    const issues = await validateWorkflowResources(workflow, tmpDir);
    const errors = issues.filter(i => i.level === 'error');
    expect(errors).toHaveLength(0);
  });

  test('error when command file is missing', async () => {
    const workflow = makeWorkflow('test', [{ id: 'step1', command: 'nonexistent' } as DagNode]);
    const issues = await validateWorkflowResources(workflow, tmpDir, {
      loadDefaultCommands: false,
    });
    const errors = issues.filter(i => i.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('command');
    expect(errors[0].message).toContain('not found');
  });

  test('suggests similar command names', async () => {
    await createCommandFile('assist');
    const workflow = makeWorkflow('test', [{ id: 'step1', command: 'asist' } as DagNode]);
    const issues = await validateWorkflowResources(workflow, tmpDir, {
      loadDefaultCommands: false,
    });
    const errors = issues.filter(i => i.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].suggestions).toContain('assist');
  });

  test('error for invalid command name', async () => {
    const workflow = makeWorkflow('test', [{ id: 'step1', command: '../escape' } as DagNode]);
    const issues = await validateWorkflowResources(workflow, tmpDir);
    const errors = issues.filter(i => i.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Invalid command name');
  });
});

// =============================================================================
// validateWorkflowResources — portable model refs
// =============================================================================

describe('validateWorkflowResources — portable model refs', () => {
  test('bundled workflow rejects top-level @custom model ref', async () => {
    await createCommandFile('my-command');
    const workflow = {
      ...makeWorkflow('test', [{ id: 'step1', command: 'my-command' } as DagNode]),
      model: '@custom',
    } as WorkflowDefinition;

    const issues = await validateWorkflowResources(workflow, tmpDir, {
      workflowSource: 'bundled',
    });

    expect(issues.some(i => i.field === 'model' && i.message.includes('@custom'))).toBe(true);
  });

  test('global workflow rejects node @custom model ref', async () => {
    await createCommandFile('my-command');
    const workflow = makeWorkflow('test', [
      { id: 'step1', command: 'my-command', model: '@custom' } as DagNode,
    ]);

    const issues = await validateWorkflowResources(workflow, tmpDir, {
      workflowSource: 'global',
    });

    expect(issues.some(i => i.nodeId === 'step1' && i.field === 'model')).toBe(true);
  });

  test('project workflow allows configured @custom model refs', async () => {
    await createCommandFile('my-command');
    const workflow = makeWorkflow('test', [
      { id: 'step1', command: 'my-command', model: '@custom' } as DagNode,
    ]);

    const issues = await validateWorkflowResources(workflow, tmpDir, {
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
      { id: 'step1', command: 'my-command', model: '@missing' } as DagNode,
    ]);

    const issues = await validateWorkflowResources(workflow, tmpDir, {
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
      ...makeWorkflow('test', [{ id: 'step1', command: 'my-command' } as DagNode]),
      model: 'tiny',
    } as WorkflowDefinition;

    const issues = await validateWorkflowResources(workflow, tmpDir, {
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
        { id: 'step1', command: 'my-command', model: 'small' } as DagNode,
        { id: 'step2', command: 'my-command', model: 'gpt-5.5' } as DagNode,
      ]),
      model: 'large',
    } as WorkflowDefinition;

    const issues = await validateWorkflowResources(workflow, tmpDir, {
      workflowSource: 'bundled',
    });

    expect(issues.some(i => i.field === 'model')).toBe(false);
  });
});

// =============================================================================
// validateWorkflowResources — MCP validation
// =============================================================================

describe('validateWorkflowResources — MCP validation', () => {
  test('error when MCP config file is missing', async () => {
    const workflow = makeWorkflow('test', [
      { id: 'step1', prompt: 'do stuff', mcp: 'missing.json' } as unknown as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir);
    expect(issues.some(i => i.field === 'mcp' && i.level === 'error')).toBe(true);
  });

  test('error when MCP config has invalid JSON', async () => {
    const mcpPath = join(tmpDir, 'bad.json');
    await writeFile(mcpPath, '{bad json');
    const workflow = makeWorkflow('test', [
      { id: 'step1', prompt: 'do stuff', mcp: mcpPath } as unknown as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir);
    const mcpErrors = issues.filter(i => i.field === 'mcp' && i.level === 'error');
    expect(mcpErrors).toHaveLength(1);
    expect(mcpErrors[0].message).toContain('invalid JSON');
  });

  test('error when MCP config is an array instead of object', async () => {
    const mcpPath = join(tmpDir, 'array.json');
    await writeFile(mcpPath, '[]');
    const workflow = makeWorkflow('test', [
      { id: 'step1', prompt: 'do stuff', mcp: mcpPath } as unknown as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir);
    const mcpErrors = issues.filter(i => i.field === 'mcp' && i.level === 'error');
    expect(mcpErrors).toHaveLength(1);
    expect(mcpErrors[0].message).toContain('JSON object');
  });

  test('no error when MCP config is a valid JSON object', async () => {
    const mcpPath = join(tmpDir, 'good.json');
    await writeFile(mcpPath, '{"server": {"command": "npx"}}');
    const workflow = makeWorkflow('test', [
      { id: 'step1', prompt: 'do stuff', mcp: mcpPath } as unknown as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir);
    const mcpErrors = issues.filter(i => i.field === 'mcp' && i.level === 'error');
    expect(mcpErrors).toHaveLength(0);
  });

  test('does not warn when MCP is used with codex provider', async () => {
    const mcpPath = join(tmpDir, 'good.json');
    await writeFile(mcpPath, '{"server": {"command": "npx"}}');
    const workflow = makeWorkflow(
      'test',
      [{ id: 'step1', prompt: 'do stuff', mcp: mcpPath } as unknown as DagNode],
      'codex'
    );
    const issues = await validateWorkflowResources(workflow, tmpDir);
    const mcpWarnings = issues.filter(i => i.field === 'mcp' && i.level === 'warning');
    expect(mcpWarnings).toHaveLength(0);
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
      { id: 'step1', script: 'nonexistent-script', runtime: 'bun' } as unknown as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir);
    const errors = issues.filter(i => i.level === 'error' && i.field === 'script');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("Named script 'nonexistent-script' not found");
    expect(errors[0].nodeId).toBe('step1');
  });

  test('error when named uv script file does not exist', async () => {
    const workflow = makeWorkflow('test', [
      { id: 'step1', script: 'missing-py-script', runtime: 'uv' } as unknown as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir);
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
      { id: 'step1', script: 'my-script', runtime: 'bun' } as unknown as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir);
    const scriptErrors = issues.filter(i => i.level === 'error' && i.field === 'script');
    expect(scriptErrors).toHaveLength(0);
  });

  test('no error for inline bun script (no file lookup needed)', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'step1',
        script: 'console.log("inline")',
        runtime: 'bun',
      } as unknown as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir);
    const scriptErrors = issues.filter(i => i.level === 'error' && i.field === 'script');
    expect(scriptErrors).toHaveLength(0);
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
      [{ id: 'step1', prompt: 'p', agents: agentsField } as unknown as DagNode],
      'codex'
    );
    const issues = await validateWorkflowResources(workflow, tmpDir);
    const warning = issues.find(i => i.level === 'warning' && i.field === 'agents');
    expect(warning).toBeDefined();
    expect(warning!.message).toContain("not supported by provider 'codex'");
    expect(warning!.hint).toContain('claude');
  });

  test('no agents-capability warning when provider is claude', async () => {
    const workflow = makeWorkflow(
      'test',
      [{ id: 'step1', prompt: 'p', agents: agentsField } as unknown as DagNode],
      'claude'
    );
    const issues = await validateWorkflowResources(workflow, tmpDir);
    const warning = issues.find(i => i.level === 'warning' && i.field === 'agents');
    expect(warning).toBeUndefined();
  });

  test('no warning when node has no agents field', async () => {
    const workflow = makeWorkflow(
      'test',
      [{ id: 'step1', prompt: 'p' } as unknown as DagNode],
      'codex'
    );
    const issues = await validateWorkflowResources(workflow, tmpDir);
    const warning = issues.find(i => i.level === 'warning' && i.field === 'agents');
    expect(warning).toBeUndefined();
  });
});

// =============================================================================
// validateWorkflowResources — bash double-quote lint
// =============================================================================

describe('validateWorkflowResources — bash double-quote lint', () => {
  test('no warning when bash uses correct unquoted idiom', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'check',
        bash: 'status=$node.output.field\n[ "$status" = "ok" ] && echo pass',
      } as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir);
    const warnings = issues.filter(i => i.level === 'warning' && i.field === 'bash');
    expect(warnings).toHaveLength(0);
  });

  test('warning when bash body has double-quoted $nodeId.output.field', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'check',
        bash: 'status="$emit.output.status"\n[ "$status" = "ok" ] && echo pass',
      } as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir);
    const warnings = issues.filter(i => i.level === 'warning' && i.field === 'bash');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].nodeId).toBe('check');
    expect(warnings[0].message).toContain('double-quoting');
    expect(warnings[0].hint).toContain('var=$node.output.field');
  });

  test('warning when $nodeId.output is embedded inside a double-quoted string', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'check',
        bash: 'echo "result: $emit.output.status"',
      } as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir);
    const warnings = issues.filter(i => i.level === 'warning' && i.field === 'bash');
    expect(warnings).toHaveLength(1);
  });

  test('script nodes are exempt from the double-quote lint', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'check',
        script: 'const status = "$emit.output.status";\nconsole.log(status);',
        runtime: 'bun',
      } as unknown as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir);
    const warnings = issues.filter(i => i.level === 'warning' && i.field === 'bash');
    expect(warnings).toHaveLength(0);
  });

  test('no warning when $nodeId.output is inside single quotes', async () => {
    const workflow = makeWorkflow('test', [
      {
        id: 'check',
        bash: "status='$emit.output.status'",
      } as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir);
    const warnings = issues.filter(i => i.level === 'warning' && i.field === 'bash');
    expect(warnings).toHaveLength(0);
  });

  test('no false positive: a prior double-quoted string before an unquoted ref on the same line', async () => {
    // The closing `"` of "Build complete." must NOT seed a match that slides across
    // the `;` to the correctly-unquoted $build.output.score.
    const workflow = makeWorkflow('test', [
      {
        id: 'check',
        bash: 'echo "Build complete."; result=$build.output.score',
      } as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir);
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
        loop: {
          until: 'DONE',
          until_bash: 'status="$emit.output.status" && [ "$status" = "done" ]',
        },
      } as unknown as DagNode,
    ]);
    const issues = await validateWorkflowResources(workflow, tmpDir);
    const warnings = issues.filter(i => i.level === 'warning' && i.field === 'loop.until_bash');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('double-quoting');
  });
});

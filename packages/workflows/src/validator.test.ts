import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
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

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'validator-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
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

  test('warns when MCP used with codex provider', async () => {
    const mcpPath = join(tmpDir, 'good.json');
    await writeFile(mcpPath, '{"server": {"command": "npx"}}');
    const workflow = makeWorkflow(
      'test',
      [{ id: 'step1', prompt: 'do stuff', mcp: mcpPath } as unknown as DagNode],
      'codex'
    );
    const issues = await validateWorkflowResources(workflow, tmpDir);
    const mcpWarnings = issues.filter(i => i.field === 'mcp' && i.level === 'warning');
    expect(mcpWarnings).toHaveLength(1);
    expect(mcpWarnings[0].message).toContain('not supported by provider');
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

  test('loadDefaultCommands: false suppresses bundled commands', async () => {
    const withDefaults = await discoverAvailableCommands(tmpDir, { loadDefaultCommands: true });
    const without = await discoverAvailableCommands(tmpDir, { loadDefaultCommands: false });
    expect(withDefaults.length).toBeGreaterThanOrEqual(without.length);
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

import { describe, it, expect, beforeEach, afterEach, spyOn, mock, type Mock } from 'bun:test';
import { mkdir, writeFile, rm, readdir, readFile } from 'fs/promises';
import { join, basename } from 'path';
import { tmpdir } from 'os';

const isWindows = process.platform === 'win32';

// Inline mock logger to suppress noisy output during tests
type MockLog = (data: unknown, message?: string, ...args: unknown[]) => undefined;
const mockLogger = {
  fatal: mock<MockLog>(() => undefined),
  error: mock<MockLog>(() => undefined),
  warn: mock<MockLog>(() => undefined),
  info: mock<MockLog>(() => undefined),
  debug: mock<MockLog>(() => undefined),
  trace: mock<MockLog>(() => undefined),
  child: mock(function () {
    return mockLogger;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};

// Mock @archon/paths: suppress logger + pass through real path utilities
const realArchonPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...realArchonPaths,
  createLogger: mock(() => mockLogger),
}));

// Bootstrap provider registry (needed by isRegisteredProvider checks at load time)
import { registerBuiltinProviders, clearRegistry } from '@archon/providers';
clearRegistry();
registerBuiltinProviders();

import { discoverWorkflows, discoverWorkflowsWithConfig } from './workflow-discovery';
import {
  isExecNode,
  isHaltNode,
  isLoopGroupNode,
  isLoopNode,
  isAgentNode,
  isWorkflowNode,
} from './schemas';
import { parseWorkflow, resetClassPlacementWarningForTests, type ParseResult } from './loader';
import { COMPILED_LOOP_COMMAND, type LoopWithCompiledCommand } from './compiled-command';
import { workflowDefinitionSchema } from './schemas/workflow';
import type { WorkflowDefinition } from './schemas/workflow';
import type { DagNode, IncludeDirective, BindingDirective } from './schemas';
import type { JsonValue } from './output-ref';
import * as bundledDefaults from './defaults/bundled-defaults';
import { parsePackagedResourceReference } from './packaged-workflow';
import { discoverScriptsForCwd } from './script-discovery';

/** The inline prompt text of an agent node, or undefined for any other kind
 * (formerly the bare `'prompt' in node ? node.prompt : ...` idiom, #2486). */
function inlinePrompt(node: DagNode | IncludeDirective | undefined): string | undefined {
  return node && 'kind' in node && isAgentNode(node) && node.source.kind === 'inline'
    ? node.source.prompt
    : undefined;
}

/** The `with:` bindings of an agent (command-sourced) or exec node, or undefined
 * for any other kind (formerly the bare `'with' in node ? node.with : ...` idiom). */
function nodeWith(
  node: DagNode | IncludeDirective | undefined
): Record<string, JsonValue | BindingDirective> | undefined {
  if (!node || !('kind' in node)) return undefined;
  if (isExecNode(node)) return node.with;
  if (isAgentNode(node) && node.source.kind === 'command') return node.source.with;
  if (isWorkflowNode(node)) return node.with;
  return undefined;
}

/**
 * Parse one workflow YAML directly.
 *
 * These assertions are about what `parseWorkflow` PRODUCES. Routing them through
 * `discoverWorkflows` also ran include expansion, which since #1764 collapses a
 * workflow's node-affecting config onto its own nodes and removes the workflow-level
 * layer — so a `provider:`/`model:`/`effort:` assertion made on a discovered workflow
 * was testing the expander, not the parser it named.
 */
function parseWorkflowYaml(
  yaml: string,
  filename = 'test.yaml'
): { workflow: WorkflowDefinition; warnings: string[] } {
  const result = parseWorkflow(yaml, filename);
  expect(result.error).toBeNull();
  if (result.workflow === null) throw new Error('expected a parsed workflow');
  return { workflow: result.workflow, warnings: result.warnings };
}

describe('Workflow Loader', () => {
  let testDir: string;
  const originalArchonHome = process.env.ARCHON_HOME;
  const originalArchonDocker = process.env.ARCHON_DOCKER;

  beforeEach(async () => {
    // Create unique temp directory for each test
    testDir = join(tmpdir(), `workflow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    process.env.ARCHON_HOME = join(testDir, 'home');
    delete process.env.ARCHON_DOCKER;
    const { resetLegacyHomeWarningForTests } = await import('./workflow-discovery');
    resetLegacyHomeWarningForTests();
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
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

  describe('packaged workflow folders (#2527)', () => {
    it('discovers arbitrary repo pack/workflow folders and qualifies local resources', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows', 'team-kit', 'ship-it');
      await mkdir(workflowDir, { recursive: true });
      await writeFile(
        join(workflowDir, 'release.yaml'),
        `name: release\ndescription: release\nnodes:\n  - id: command\n    command: prepare\n  - id: script\n    script: publish\n    runtime: bun\n`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toEqual([]);
      const workflow = result.workflows.find(entry => entry.workflow.name === 'release')?.workflow;
      expect(workflow).toBeDefined();
      const command = parsePackagedResourceReference(
        (workflow?.nodes[0] as { source: { name: string } }).source.name
      );
      const script = parsePackagedResourceReference(
        (workflow?.nodes[1] as { script: string }).script
      );
      expect(command).toEqual({
        owner: { source: 'project', pack: 'team-kit', workflow: 'ship-it' },
        name: 'prepare',
      });
      expect(script).toEqual({
        owner: { source: 'project', pack: 'team-kit', workflow: 'ship-it' },
        name: 'publish',
      });
    });

    it("a composed block's named script still resolves to its OWN pack after composition", async () => {
      // The packaged-ownership claim at the boundary that matters: the script name a
      // composed node carries has to resolve to the file in the BLOCK's pack, not to a
      // same-named script in the parent's. Composition into a different pack is the case
      // (#1764 Task 11 / #2528) — a bare basename would silently pick the wrong program.
      const parentDir = join(testDir, '.archon', 'workflows', 'product', 'parent');
      const blockDir = join(testDir, '.archon', 'workflows', 'shared', 'report-block');
      await mkdir(join(parentDir, 'scripts'), { recursive: true });
      await mkdir(join(blockDir, 'scripts'), { recursive: true });
      await writeFile(
        join(parentDir, 'parent.yaml'),
        `name: script-parent\ndescription: parent\nnodes:\n  - id: rep\n    include: report-block\n`
      );
      await writeFile(
        join(blockDir, 'block.yaml'),
        `name: report-block\ndescription: block\nnodes:\n  - id: run\n    script: report\n    runtime: bun\n`
      );
      // Same basename in both packs — only the qualified reference tells them apart.
      await writeFile(join(parentDir, 'scripts', 'report.ts'), 'console.log("parent");\n');
      await writeFile(join(blockDir, 'scripts', 'report.ts'), 'console.log("block");\n');

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toEqual([]);
      const parent = result.workflows.find(w => w.workflow.name === 'script-parent')?.workflow;
      const composed = parent?.nodes.find(n => n.id === 'rep__run') as { script: string };
      expect(parsePackagedResourceReference(composed.script)).toEqual({
        owner: { source: 'project', pack: 'shared', workflow: 'report-block' },
        name: 'report',
      });

      // And that reference is a live key in the map the executor looks the script up in.
      // Stored paths go through `normalizeSep()` (script-discovery.ts), so they are
      // forward-slash on every OS while `join` is backslash on Windows — normalize the
      // expected side, matching the `norm` helper in script-discovery.test.ts.
      const scripts = await discoverScriptsForCwd(testDir);
      expect(scripts.get(composed.script)?.path).toBe(
        join(blockDir, 'scripts', 'report.ts').replaceAll('\\', '/')
      );
    });

    it('resolves an included workflow command from its own package before compiling it', async () => {
      const parentDir = join(testDir, '.archon', 'workflows', 'product', 'parent');
      const blockDir = join(testDir, '.archon', 'workflows', 'shared', 'review-block');
      const blockCommandsDir = join(blockDir, 'commands');
      await mkdir(parentDir, { recursive: true });
      await mkdir(blockCommandsDir, { recursive: true });
      await writeFile(
        join(parentDir, 'parent.yaml'),
        `name: parent\ndescription: parent\nnodes:\n  - id: review\n    include: review-block\n`
      );
      await writeFile(
        join(blockDir, 'block.yaml'),
        `name: review-block\ndescription: block\nnodes:\n  - id: run\n    command: inspect\n`
      );
      await writeFile(join(blockCommandsDir, 'inspect.md'), 'Package-owned review prompt.');

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const parent = result.workflows.find(entry => entry.workflow.name === 'parent')?.workflow;
      const included = parent?.nodes.find(node => node.id === 'review__run');
      expect(inlinePrompt(included) ?? '').toBe('Package-owned review prompt.');
    });

    it('uses the identical authored structure in home scope', async () => {
      const homeDir = join(testDir, 'home', 'workflows', 'personal-pack', 'daily');
      await mkdir(homeDir, { recursive: true });
      await writeFile(
        join(homeDir, 'daily.yaml'),
        `name: daily\ndescription: daily\nnodes:\n  - id: run\n    command: summarize\n`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflow = result.workflows.find(entry => entry.workflow.name === 'daily');
      expect(workflow?.source).toBe('global');
      expect(
        parsePackagedResourceReference(
          (workflow?.workflow.nodes[0] as { source: { name: string } }).source.name
        )
      ).toEqual({
        owner: { source: 'global', pack: 'personal-pack', workflow: 'daily' },
        name: 'summarize',
      });
    });

    it('reports same-scope packaged workflow filename collisions', async () => {
      for (const [pack, workflow, name] of [
        ['one', 'first', 'first'],
        ['two', 'second', 'second'],
      ] as const) {
        const dir = join(testDir, '.archon', 'workflows', pack, workflow);
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, 'same.yaml'),
          `name: ${name}\ndescription: collision\nnodes:\n  - id: run\n    prompt: hi\n`
        );
      }

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows.some(entry => entry.workflow.name === 'first')).toBe(false);
      expect(result.workflows.some(entry => entry.workflow.name === 'second')).toBe(false);
      expect(result.errors.some(error => error.error.includes('filename collision'))).toBe(true);
    });

    it('reports a filename collision between flat and packaged workflows', async () => {
      const workflowsRoot = join(testDir, '.archon', 'workflows');
      const packageDir = join(workflowsRoot, 'one', 'first');
      await mkdir(packageDir, { recursive: true });
      await writeFile(
        join(workflowsRoot, 'same.yaml'),
        'name: flat\ndescription: flat\nnodes:\n  - id: run\n    prompt: hi\n'
      );
      await writeFile(
        join(packageDir, 'same.yaml'),
        'name: packaged\ndescription: packaged\nnodes:\n  - id: run\n    prompt: hi\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows.some(entry => entry.workflow.name === 'flat')).toBe(false);
      expect(result.workflows.some(entry => entry.workflow.name === 'packaged')).toBe(false);
      expect(result.errors.some(error => error.error.includes('collision within one scope'))).toBe(
        true
      );
    });

    it('repo filename override selects the repo packaged resource owner', async () => {
      const homeDir = join(testDir, 'home', 'workflows', 'home-pack', 'flow');
      const repoDir = join(testDir, '.archon', 'workflows', 'repo-pack', 'flow');
      await mkdir(homeDir, { recursive: true });
      await mkdir(repoDir, { recursive: true });
      await writeFile(
        join(homeDir, 'same.yaml'),
        `name: home-version\ndescription: home\nnodes:\n  - id: run\n    command: shared\n`
      );
      await writeFile(
        join(repoDir, 'same.yaml'),
        `name: repo-version\ndescription: repo\nnodes:\n  - id: run\n    command: shared\n`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows.some(entry => entry.workflow.name === 'home-version')).toBe(false);
      const repo = result.workflows.find(entry => entry.workflow.name === 'repo-version');
      expect(repo?.source).toBe('project');
      expect(
        parsePackagedResourceReference(
          (repo?.workflow.nodes[0] as { source: { name: string } }).source.name
        )
      ).toEqual({
        owner: { source: 'project', pack: 'repo-pack', workflow: 'flow' },
        name: 'shared',
      });
    });
  });

  describe('parseWorkflow (via discoverWorkflows)', () => {
    it('should parse interactive: true when present', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: test\ndescription: test\ninteractive: true\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'test.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows[0].workflow.interactive).toBe(true);
    });

    it('should omit interactive field when not present', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: test\ndescription: test\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'test.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows[0].workflow.interactive).toBeUndefined();
    });

    it('should preserve interactive: false when explicitly set', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: test\ndescription: test\ninteractive: false\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'test.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows[0].workflow.interactive).toBe(false);
    });

    it('should treat non-boolean interactive value as undefined', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      // YAML string "yes" is not a boolean — should be dropped
      const yaml = `name: test\ndescription: test\ninteractive: "yes"\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'test.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows[0].workflow.interactive).toBeUndefined();
    });

    it('should parse worktree.enabled: false', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: triage\ndescription: read-only\nworktree:\n  enabled: false\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'triage.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows[0].workflow.worktree).toEqual({ enabled: false });
    });

    it('should parse worktree.enabled: true', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: build\ndescription: needs worktree\nworktree:\n  enabled: true\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'build.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows[0].workflow.worktree).toEqual({ enabled: true });
    });

    it('should omit worktree block when not present (policy is caller-decides)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: normal\ndescription: no policy\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'normal.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows[0].workflow.worktree).toBeUndefined();
    });

    it('should parse container policy (enabled + write_back)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: ops\ndescription: containerized\ncontainer:\n  enabled: true\n  write_back: auto\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'ops.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows[0].workflow.container).toEqual({ enabled: true, write_back: 'auto' });
    });

    it('should ignore an invalid container.write_back value but keep the block', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: ops2\ndescription: bad\ncontainer:\n  enabled: true\n  write_back: bogus\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'ops2.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows[0].workflow.container).toEqual({ enabled: true });
    });

    it('should parse evidence_policy.required: true (#2230)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: gated\ndescription: evidence gated\nevidence_policy:\n  required: true\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'gated.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows[0].workflow.evidence_policy).toEqual({ required: true });
    });

    it('should parse evidence_policy.required: false', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: ungated\ndescription: opt-out\nevidence_policy:\n  required: false\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'ungated.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows[0].workflow.evidence_policy).toEqual({ required: false });
    });

    it('should omit evidence_policy when not present', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: no-evidence\ndescription: none\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'no-evidence.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows[0].workflow.evidence_policy).toBeUndefined();
    });

    it('should REJECT a malformed evidence_policy block (fail-safe, not warn-and-ignore)', async () => {
      // Silently dropping a declared terminal-success gate would let runs
      // complete ungated — a malformed block must fail validation loudly.
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: bad-evidence\ndescription: bad\nevidence_policy:\n  required: "yes"\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'bad-evidence.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].errorType).toBe('validation_error');
      expect(result.errors[0].error).toContain('evidence_policy');
    });

    it('should REJECT an empty evidence_policy block (required is mandatory)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: empty-evidence\ndescription: bad\nevidence_policy: {}\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'empty-evidence.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].errorType).toBe('validation_error');
      expect(result.errors[0].error).toContain('required: boolean');
    });

    it('should omit container block when not present', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: plain\ndescription: none\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'plain.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows[0].workflow.container).toBeUndefined();
    });

    it('should parse explicit tags array', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: review-mr\ndescription: GitLab MR review\ntags: [GitLab, Review]\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'review-mr.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows[0].workflow.tags).toEqual(['GitLab', 'Review']);
    });

    it('should omit tags when not present', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: test\ndescription: no tags\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'test.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows[0].workflow.tags).toBeUndefined();
    });

    it('should preserve explicit empty tags array (suppresses inference)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: test\ndescription: no tags wanted\ntags: []\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'test.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows[0].workflow.tags).toEqual([]);
    });

    it('should trim and dedupe tags', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: test\ndescription: messy tags\ntags: ["GitLab", "GitLab ", "  GitLab  ", "Review"]\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'test.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows[0].workflow.tags).toEqual(['GitLab', 'Review']);
    });

    it('should filter non-string tag entries', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      // YAML coerces unquoted scalars: 123 → number, null → null
      const yaml = `name: test\ndescription: mixed\ntags:\n  - GitLab\n  - 123\n  - null\n  - Review\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'test.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows[0].workflow.tags).toEqual(['GitLab', 'Review']);
    });

    it('should reduce all-blank tags to empty array (still suppresses inference)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: test\ndescription: blanks\ntags: ["", "  "]\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'test.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows[0].workflow.tags).toEqual([]);
    });

    it('should ignore tags when not an array', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      // Authoring mistake: scalar instead of list — discarded, workflow still loads
      const yaml = `name: test\ndescription: scalar tags\ntags: GitLab\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'test.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows).toHaveLength(1);
      expect(result.workflows[0].workflow.tags).toBeUndefined();
    });

    it('should parse mutates_checkout: false correctly', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: test\ndescription: read-only workflow\nmutates_checkout: false\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'test.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows[0].workflow.mutates_checkout).toBe(false);
    });

    it('should parse mutates_checkout: true correctly', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: test\ndescription: explicit true\nmutates_checkout: true\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'test.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows[0].workflow.mutates_checkout).toBe(true);
    });

    it('should omit mutates_checkout when not set', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: test\ndescription: no field\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'test.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows[0].workflow.mutates_checkout).toBeUndefined();
    });

    it('should warn and omit mutates_checkout for invalid value', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      // YAML string "yes" is not a boolean — should be dropped and field omitted
      const yaml = `name: test\ndescription: typo\nmutates_checkout: "yes"\nnodes:\n  - id: n\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'test.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows).toHaveLength(1);
      expect(result.workflows[0].workflow.mutates_checkout).toBeUndefined();
    });

    it('should parse valid DAG workflow YAML', () => {
      const { workflow } = parseWorkflowYaml(`name: test-workflow
description: A test workflow
provider: claude
nodes:
  - id: plan
    command: plan
  - id: implement
    command: implement
    depends_on: [plan]
`);

      expect(workflow.name).toBe('test-workflow');
      expect(workflow.description).toBe('A test workflow');
      expect(workflow.provider).toBe('claude');
      expect(workflow.nodes).toHaveLength(2);
      expect(workflow.nodes[0].id).toBe('plan');
      expect(workflow.nodes[1].id).toBe('implement');
    });

    it('should return empty array for YAML missing name', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const invalidYaml = `description: Missing name
nodes:
  - id: plan
    command: plan
`;
      await writeFile(join(workflowDir, 'invalid.yaml'), invalidYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows).toHaveLength(0);
    });

    it('should return empty array for YAML missing description', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const invalidYaml = `name: no-description
nodes:
  - id: plan
    command: plan
`;
      await writeFile(join(workflowDir, 'invalid.yaml'), invalidYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows).toHaveLength(0);
    });

    it('should reject workflow with steps: and provide clear error message', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const stepsYaml = `name: legacy-workflow
description: Uses deprecated steps format
steps:
  - command: plan
  - command: implement
`;
      await writeFile(join(workflowDir, 'legacy.yaml'), stepsYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].errorType).toBe('validation_error');
      expect(result.errors[0].error).toContain('steps:');
      expect(result.errors[0].error).toContain('has been removed');
    });

    it('should leave provider undefined when not specified (executor handles fallback)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const yamlNoProvider = `name: default-provider
description: No provider specified
nodes:
  - id: test
    command: test
`;
      await writeFile(join(workflowDir, 'test.yaml'), yamlNoProvider);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows).toHaveLength(1);
      expect(workflows[0].provider).toBeUndefined();
    });

    it('should reject unknown provider at load time', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const yamlInvalidProvider = `name: invalid-provider
description: Invalid provider specified
provider: claud
nodes:
  - id: test
    command: test
`;
      await writeFile(join(workflowDir, 'test.yaml'), yamlInvalidProvider);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].errorType).toBe('validation_error');
      expect(result.errors[0].error).toContain("Unknown provider 'claud'");
    });

    it('should accept any model string with a known provider (SDK validates at run time)', () => {
      // Whatever the user wrote in `model:` passes through to the SDK; the
      // SDK is the source of truth for what model strings exist. Errors
      // surface at run time, not load time.
      const { workflow } = parseWorkflowYaml(`name: any-model
description: Any model string with a known provider
provider: claude
model: claude-opus-4-7[1m]
nodes:
  - id: test
    command: test
`);

      expect(workflow.provider).toBe('claude');
      expect(workflow.model).toBe('claude-opus-4-7[1m]');
    });

    it('should parse codex options fields (and ignore the removed additionalDirectories field)', () => {
      // additionalDirectories was a dead workflow-level field (parsed but never
      // consumed by the DAG executor) — it has been removed. A YAML that still
      // declares it must load fine, with the field simply ignored.
      const { workflow } = parseWorkflowYaml(`name: codex-options
description: Codex options are parsed
provider: codex
model: gpt-5.6-sol
modelReasoningEffort: medium
webSearchMode: live
additionalDirectories:
  - /repo/a
  - 123
nodes:
  - id: test
    command: test
`);

      // #2556: translated into `effort:` at load, never carried forward.
      expect(workflow.effort).toBe('medium');
      expect(workflow.modelReasoningEffort).toBeUndefined();
      expect(workflow.webSearchMode).toBe('live');
      // The removed field is not carried onto the workflow object.
      expect((workflow as Record<string, unknown>).additionalDirectories).toBeUndefined();
    });

    it('should translate modelReasoningEffort into effort and say so', () => {
      // #2556: warn-and-TRANSLATE. The value must survive to the executor — an
      // author who reads the warning and does nothing must see no change in the
      // depth their nodes run at — but it survives as `effort:`, the field that
      // has a node-level counterpart. That is what makes the deprecation
      // terminal, and what lets a later pass collapse workflow-level config onto
      // nodes (#1764) without a hole for this field.
      const { workflow, warnings } = parseWorkflowYaml(`name: deprecated-effort-spelling
description: Uses the old Codex-only spelling
provider: codex
modelReasoningEffort: xhigh
nodes:
  - id: test
    command: test
`);

      // The value arrives under the canonical spelling; the deprecated key is gone.
      expect(workflow.effort).toBe('xhigh');
      expect(workflow.modelReasoningEffort).toBeUndefined();

      const deprecation = warnings.find(w => w.includes('modelReasoningEffort'));
      expect(deprecation).toBeDefined();
      expect(deprecation).toContain('deprecated');
      // The message must name what actually happened, not just what to write —
      // an author who reads "deprecated" and nothing else cannot tell whether
      // their value still applies.
      expect(deprecation).toContain("has been applied as 'effort: xhigh'");
      // The scope change must be disclosed, not just the rename. The old field
      // was Codex-only; `effort:` is not, so a workflow that declares only the
      // deprecated field now reasons deeper on its Claude/Pi/Copilot nodes too,
      // where before it affected none of them. Silent is exactly what this
      // issue exists to remove.
      expect(deprecation).toContain('EVERY node');
      expect(deprecation).toContain('non-Codex');
    });

    it('translates for a NON-Codex workflow too — the widening, pinned', () => {
      // R22's cost, as behavior rather than a sentence. The deprecated field was
      // Codex-gated in the executor: on a Claude workflow it applied to nothing
      // and warned. Translation is provider-blind (the loader cannot know which
      // nodes resolve to Codex), so it now applies. That is deliberate and
      // disclosed — and a plausible "fix" would be to re-add a Codex gate here,
      // which would silently restore the two-field hole #1764 Task 1 needs gone.
      // This test is what makes that regression fail.
      const { workflow } = parseWorkflowYaml(`name: deprecated-on-claude
description: Codex-only spelling on a Claude workflow
provider: claude
modelReasoningEffort: high
nodes:
  - id: test
    command: test
`);

      expect(workflow.provider).toBe('claude');
      // Applied, not dropped, and under the canonical spelling.
      expect(workflow.effort).toBe('high');
      expect(workflow.modelReasoningEffort).toBeUndefined();
    });

    it('should ignore modelReasoningEffort when effort is also declared, and say which won', () => {
      // The loader cannot know which nodes resolve to Codex, so the deprecated
      // field's Codex-only precedence is not expressible at load time. `effort:`
      // wins, and the warning has to say so plainly — silently picking one of
      // two declared depths is the failure this issue exists to remove.
      const { workflow, warnings } = parseWorkflowYaml(`name: both-spellings
description: Declares both reasoning-depth fields
provider: codex
effort: minimal
modelReasoningEffort: xhigh
nodes:
  - id: test
    command: test
`);

      expect(workflow.effort).toBe('minimal');
      expect(workflow.modelReasoningEffort).toBeUndefined();

      const deprecation = warnings.find(w => w.includes('modelReasoningEffort'));
      expect(deprecation).toBeDefined();
      expect(deprecation).toContain('IGNORED');
      expect(deprecation).toContain('effort: minimal');
    });

    it('should not warn about deprecation when modelReasoningEffort is absent', () => {
      const { workflow, warnings } = parseWorkflowYaml(`name: current-effort-spelling
description: Uses the one spelling
provider: codex
effort: xhigh
nodes:
  - id: test
    command: test
`);

      expect(workflow.effort).toBe('xhigh');
      expect(warnings).toEqual([]);
    });

    it('should accept the widened effort ladder on NODES, not just at workflow level', async () => {
      // `effortLevelSchema` backs both the workflow field and the node field, but
      // only the workflow one was proven against real YAML. The node field is the
      // headline of #2556 — "effort: works per node on every provider" — and it
      // crosses `dagNodeSchema.safeParse()`, a boundary no other effort test
      // touches (the executor and provider suites build objects in memory).
      // Narrowing the node enum would pass every one of those and fail the WHOLE
      // workflow to load, not just the field.
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: node-effort-rungs
description: Node-level effort across the full ladder
provider: codex
nodes:
  - id: shallow
    command: test
    effort: minimal
  - id: deep
    command: test
    effort: xhigh
    depends_on: [shallow]
`;
      await writeFile(join(workflowDir, 'node-effort.yaml'), yaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toEqual([]);
      expect(result.workflows).toHaveLength(1);

      const nodes = result.workflows[0].workflow.nodes as DagNode[];
      expect(nodes.find(n => n.id === 'shallow')?.effort).toBe('minimal');
      expect(nodes.find(n => n.id === 'deep')?.effort).toBe('xhigh');
      expect(result.workflows[0].parseWarnings ?? []).toEqual([]);
    });

    it('should round-trip workflow-level effort/thinking/fallbackModel/betas/sandbox', () => {
      // Regression: these 5 workflow-level fields are declared on
      // workflowBaseSchema and consumed by the DAG executor's workflowLevelOptions
      // (the object literal at the top of executeDagWorkflow), but the loader's
      // manual workflow constructor used to silently drop them. YAML → loader →
      // executor would lose the workflow-level defaults, so a node without its own
      // value never inherited them. See `dag-executor.test.ts`
      // "forwards workflow-level effort to node when no per-node override" — that
      // test passes because it bypasses the loader.
      const wf = parseWorkflowYaml(`name: defaults
description: workflow-level fallback options
provider: claude
effort: high
thinking:
  type: enabled
  budgetTokens: 4000
fallbackModel: claude-haiku-4-5
betas:
  - foo
  - bar
sandbox:
  enabled: true
nodes:
  - id: only
    prompt: p
`).workflow;
      expect(wf.effort).toBe('high');
      expect(wf.thinking).toEqual({ type: 'enabled', budgetTokens: 4000 });
      expect(wf.fallbackModel).toBe('claude-haiku-4-5');
      expect(wf.betas).toEqual(['foo', 'bar']);
      expect(wf.sandbox).toEqual({ enabled: true });
    });

    it('should omit workflow-level fallback fields when not present', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: bare\ndescription: no fallbacks\nnodes:\n  - id: only\n    prompt: p\n`;
      await writeFile(join(workflowDir, 'bare.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const wf = result.workflows[0].workflow as Record<string, unknown>;
      expect(wf.effort).toBeUndefined();
      expect(wf.thinking).toBeUndefined();
      expect(wf.fallbackModel).toBeUndefined();
      expect(wf.betas).toBeUndefined();
      expect(wf.sandbox).toBeUndefined();
    });

    it('should warn-and-drop invalid workflow-level fallback fields without rejecting the workflow', async () => {
      // Same warn-and-ignore policy as `interactive` / `modelReasoningEffort`:
      // a typo in one workflow-level field must not nuke the whole discovery pass.
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: bad
description: invalid fallback fields are dropped
provider: claude
effort: nuclear
thinking:
  type: enhanced
fallbackModel: ''
betas: []
sandbox: 'yes'
nodes:
  - id: only
    prompt: p
`;
      await writeFile(join(workflowDir, 'bad.yaml'), yaml);
      mockLogger.warn.mockClear();
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toEqual([]);
      expect(result.workflows).toHaveLength(1);
      const wf = result.workflows[0].workflow as Record<string, unknown>;
      expect(wf.effort).toBeUndefined();
      expect(wf.thinking).toBeUndefined();
      expect(wf.fallbackModel).toBeUndefined();
      expect(wf.betas).toBeUndefined();
      expect(wf.sandbox).toBeUndefined();

      // The structured warn events are the operator-facing surface — assert each fired.
      const events = mockLogger.warn.mock.calls.map(call => call[1]);
      expect(events).toContain('invalid_workflow_effort_value_ignored');
      expect(events).toContain('invalid_workflow_thinking_value_ignored');
      expect(events).toContain('invalid_workflow_fallback_model_value_ignored');
      expect(events).toContain('invalid_workflow_betas_value_ignored');
      expect(events).toContain('invalid_workflow_sandbox_value_ignored');
    });

    it('should accept the thinking string shorthand at the workflow level', () => {
      // thinkingConfigSchema preprocesses 'enabled' → { type: 'enabled' }. The
      // round-trip test covers the object form; this covers the shorthand path.
      const wf = parseWorkflowYaml(`name: thinking-shorthand
description: thinking as a bare string
thinking: enabled
nodes:
  - id: only
    prompt: p
`).workflow;
      expect(wf.thinking).toEqual({ type: 'enabled' });
    });

    it('should trim surrounding whitespace from workflow-level fallbackModel', () => {
      // The inline trim (rather than safeParse) exists specifically so a stray
      // surrounding space is normalised rather than rejected.
      const wf = parseWorkflowYaml(`name: fm-trim
description: fallbackModel with whitespace
fallbackModel: '  claude-haiku-4-5  '
nodes:
  - id: only
    prompt: p
`).workflow;
      expect(wf.fallbackModel).toBe('claude-haiku-4-5');
    });

    it('should trim and filter empty strings out of workflow-level betas', () => {
      const wf = parseWorkflowYaml(`name: beta-trim
description: betas with whitespace
betas:
  - '  alpha  '
  - ''
  - 'beta'
nodes:
  - id: only
    prompt: p
`).workflow;
      expect(wf.betas).toEqual(['alpha', 'beta']);
    });
  });

  describe('discoverWorkflows', () => {
    it('should discover workflows from .archon/workflows/', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const validYaml = `name: discovered
description: Discovered workflow
nodes:
  - id: test
    command: test
`;
      await writeFile(join(workflowDir, 'workflow.yaml'), validYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe('discovered');
    });

    it('should return empty array when no workflow folders exist', async () => {
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);
      expect(workflows).toHaveLength(0);
    });

    it('should load both .yaml and .yml files', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const yaml1 = `name: workflow-one
description: First workflow
nodes:
  - id: one
    command: one
`;
      const yaml2 = `name: workflow-two
description: Second workflow
nodes:
  - id: two
    command: two
`;
      await writeFile(join(workflowDir, 'one.yaml'), yaml1);
      await writeFile(join(workflowDir, 'two.yml'), yaml2);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows).toHaveLength(2);
    });

    it('should recursively load workflows from subdirectories (like defaults/)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      const defaultsDir = join(workflowDir, 'defaults');
      await mkdir(defaultsDir, { recursive: true });

      // Workflow in root
      const rootWorkflow = `name: root-workflow
description: Root level workflow
nodes:
  - id: root
    command: root
`;
      // Workflow in subdirectory
      const subWorkflow = `name: sub-workflow
description: Subdirectory workflow
nodes:
  - id: sub
    command: sub
`;
      await writeFile(join(workflowDir, 'root.yaml'), rootWorkflow);
      await writeFile(join(defaultsDir, 'sub.yaml'), subWorkflow);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows).toHaveLength(2);
      const names = workflows.map(w => w.name).sort();
      expect(names).toEqual(['root-workflow', 'sub-workflow']);
    });
  });

  describe('command name validation (Issue #129)', () => {
    it('should reject DAG workflow with path traversal command name', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const pathTraversalYaml = `name: path-traversal
description: Has invalid command name
nodes:
  - id: bad
    command: ../../../etc/passwd
`;
      await writeFile(join(workflowDir, 'invalid.yaml'), pathTraversalYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows).toHaveLength(0);
    });

    it('should reject DAG workflow with dotfile command name', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const dotfileYaml = `name: dotfile-workflow
description: Has dotfile command name
nodes:
  - id: bad
    command: .hidden
`;
      await writeFile(join(workflowDir, 'dotfile.yaml'), dotfileYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows).toHaveLength(0);
    });

    it('should accept valid command names in DAG nodes', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const validYaml = `name: valid-commands
description: Has valid command names
nodes:
  - id: plan
    command: plan
  - id: implement
    command: implement
    depends_on: [plan]
  - id: review
    command: review-pr
    depends_on: [implement]
`;
      await writeFile(join(workflowDir, 'valid.yaml'), validYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows).toHaveLength(1);
      expect(workflows[0].nodes).toHaveLength(3);
    });
  });

  describe('edge cases', () => {
    it('should ignore non-yaml files in workflows directory', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      // Create a valid yaml and some non-yaml files
      const validYaml = `name: valid-workflow
description: Valid workflow
nodes:
  - id: test
    command: test
`;
      await writeFile(join(workflowDir, 'valid.yaml'), validYaml);
      await writeFile(join(workflowDir, 'readme.md'), '# Readme');
      await writeFile(join(workflowDir, 'config.json'), '{}');
      await writeFile(join(workflowDir, '.gitkeep'), '');

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe('valid-workflow');
    });

    it('should handle malformed YAML gracefully', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const malformedYaml = `name: test
description: test
nodes:
  - id: invalid
    command: invalid
    invalid yaml here: [
`;
      await writeFile(join(workflowDir, 'malformed.yaml'), malformedYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      // Should not throw, just return empty array
      expect(workflows).toHaveLength(0);
    });

    it('should handle workflow with all optional fields', () => {
      const { workflow } = parseWorkflowYaml(`name: full-workflow
description: A workflow with all fields
provider: codex
model: gpt-4
nodes:
  - id: step-one
    command: step-one
  - id: step-two
    command: step-two
    depends_on: [step-one]
`);

      expect(workflow.provider).toBe('codex');
      expect(workflow.model).toBe('gpt-4');
    });

    it('should handle empty workflow directory', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      // Directory exists but is empty

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows).toHaveLength(0);
    });

    it('should handle workflow with missing nodes field', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const noNodes = `name: no-nodes
description: Missing nodes
`;
      await writeFile(join(workflowDir, 'nonodes.yaml'), noNodes);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows).toHaveLength(0);
    });

    it('should handle workflow with null values', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const nullValues = `name: null-test
description: ~
nodes:
  - id: test
    command: test
`;
      await writeFile(join(workflowDir, 'nulltest.yaml'), nullValues);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      // Should fail validation due to null description
      expect(workflows).toHaveLength(0);
    });

    it('parses always_run: true on a node', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const yaml = `name: always-run-test
description: Producer opts out of resume caching
nodes:
  - id: persist
    bash: 'echo hi'
    always_run: true
  - id: consumer
    command: consume
    depends_on: [persist]
`;
      await writeFile(join(workflowDir, 'always-run.yaml'), yaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows).toHaveLength(1);
      const alwaysRunNodes = workflows[0].nodes as DagNode[];
      expect(alwaysRunNodes[0].id).toBe('persist');
      expect(alwaysRunNodes[0].always_run).toBe(true);
      expect(alwaysRunNodes[1].always_run).toBeUndefined();
    });

    it('preserves an optional description on a node', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const yaml = `name: node-description-test
description: Node-level description is kept, not stripped
nodes:
  - id: documented
    bash: 'echo hi'
    description: Runs the full security gate against the target repo
  - id: undocumented
    bash: 'echo bye'
    depends_on: [documented]
`;
      await writeFile(join(workflowDir, 'node-description.yaml'), yaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows).toHaveLength(1);
      expect(workflows[0].nodes[0].description).toBe(
        'Runs the full security gate against the target repo'
      );
      expect(workflows[0].nodes[1].description).toBeUndefined();
    });
  });

  describe('multi-source loading', () => {
    it('should load real app defaults when enabled', async () => {
      // Test dir has no .archon/workflows/
      const result = await discoverWorkflows(testDir, { loadDefaults: true });
      const workflows = result.workflows.map(ws => ws.workflow);

      // Should load the real archon-* prefixed app defaults
      expect(workflows.length).toBeGreaterThanOrEqual(1);
      // Check for at least one of the known app defaults
      const archonAssist = workflows.find(w => w.name === 'archon-assist');
      expect(archonAssist).toBeDefined();
    });

    it('should override app defaults with repo workflows of same filename', async () => {
      // Create repo workflow with same filename as an app default
      const repoWorkflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(repoWorkflowDir, { recursive: true });
      const repoWorkflowYaml = `name: my-custom-assist
description: My custom assist (overrides archon-assist)
nodes:
  - id: custom
    command: custom-command
`;
      // Use exact same filename as app default to override
      await writeFile(join(repoWorkflowDir, 'archon-assist.yaml'), repoWorkflowYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: true });
      const workflows = result.workflows.map(ws => ws.workflow);

      // Should have the repo version, not the app default
      const assistWorkflow = workflows.find(
        w => w.name === 'my-custom-assist' || w.name === 'archon-assist'
      );
      expect(assistWorkflow).toBeDefined();
      // Repo version should win (has custom name)
      expect(assistWorkflow?.name).toBe('my-custom-assist');
      expect(assistWorkflow?.description).toBe('My custom assist (overrides archon-assist)');
    });

    it('should skip app defaults when loadDefaults is false', async () => {
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      // Should NOT find any archon-* workflows since app defaults are disabled
      const archonWorkflow = workflows.find(w => w.name.startsWith('archon-'));
      expect(archonWorkflow).toBeUndefined();
    });

    it('should combine app defaults with repo workflows', async () => {
      // Create repo workflow with unique name (no collision)
      const repoWorkflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(repoWorkflowDir, { recursive: true });
      const repoWorkflowYaml = `name: my-custom-workflow
description: My custom workflow
nodes:
  - id: custom
    command: custom-command
`;
      await writeFile(join(repoWorkflowDir, 'my-custom.yaml'), repoWorkflowYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: true });
      const workflows = result.workflows.map(ws => ws.workflow);

      // Should have both app defaults and repo workflows
      const archonAssist = workflows.find(w => w.name === 'archon-assist');
      const customWorkflow = workflows.find(w => w.name === 'my-custom-workflow');
      expect(archonAssist).toBeDefined();
      expect(customWorkflow).toBeDefined();
    });
  });

  describe('home-scoped workflows (~/.archon/workflows/)', () => {
    // Home-scope is read unconditionally by discovery — no caller option. Tests
    // redirect `getArchonHome()` to a temp dir via the `ARCHON_HOME` env var so
    // they don't touch the user's real `~/.archon/`.
    let homeDir: string;
    const originalArchonHome = process.env.ARCHON_HOME;
    const originalArchonDocker = process.env.ARCHON_DOCKER;

    beforeEach(async () => {
      homeDir = join(tmpdir(), `home-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(homeDir, { recursive: true });
      process.env.ARCHON_HOME = homeDir;
      delete process.env.ARCHON_DOCKER;
      // The deprecation warning uses a module-scoped flag; reset between tests
      // so each case is independent.
      const { resetLegacyHomeWarningForTests } = await import('./workflow-discovery');
      resetLegacyHomeWarningForTests();
      mockLogger.warn.mockClear();
    });

    afterEach(async () => {
      try {
        await rm(homeDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
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

    it('loads home-scoped workflows from ~/.archon/workflows/ and merges with repo', async () => {
      const homeWorkflowDir = join(homeDir, 'workflows');
      const repoWorkflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(homeWorkflowDir, { recursive: true });
      await mkdir(repoWorkflowDir, { recursive: true });

      await writeFile(
        join(homeWorkflowDir, 'home-wf.yaml'),
        'name: home-workflow\ndescription: From home\nnodes:\n  - id: foo\n    command: foo\n'
      );
      await writeFile(
        join(repoWorkflowDir, 'repo-wf.yaml'),
        'name: repo-workflow\ndescription: From repo\nnodes:\n  - id: bar\n    command: bar\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const names = result.workflows.map(w => w.workflow.name);
      expect(names).toContain('home-workflow');
      expect(names).toContain('repo-workflow');
    });

    it("classifies home-scoped workflows as source: 'global'", async () => {
      const homeWorkflowDir = join(homeDir, 'workflows');
      await mkdir(homeWorkflowDir, { recursive: true });
      await writeFile(
        join(homeWorkflowDir, 'only-home.yaml'),
        'name: only-home\ndescription: From home\nnodes:\n  - id: n\n    command: c\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const entry = result.workflows.find(w => w.workflow.name === 'only-home');
      expect(entry?.source).toBe('global');
    });

    it('repo workflow overrides home workflow with the same filename', async () => {
      const homeWorkflowDir = join(homeDir, 'workflows');
      const repoWorkflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(homeWorkflowDir, { recursive: true });
      await mkdir(repoWorkflowDir, { recursive: true });

      await writeFile(
        join(homeWorkflowDir, 'shared.yaml'),
        'name: home-version\ndescription: Home version\nnodes:\n  - id: h\n    command: c\n'
      );
      await writeFile(
        join(repoWorkflowDir, 'shared.yaml'),
        'name: repo-version\ndescription: Repo override\nnodes:\n  - id: r\n    command: c\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const shared = result.workflows.find(
        w => w.workflow.name === 'home-version' || w.workflow.name === 'repo-version'
      );
      expect(shared?.workflow.name).toBe('repo-version');
      expect(shared?.source).toBe('project');
    });

    it('silently skips when ~/.archon/workflows/ does not exist', async () => {
      // homeDir exists but no workflows/ subdirectory — should not error.
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toEqual([]);
    });

    it('supports 1-level subfolders under ~/.archon/workflows/ (e.g. triage/foo.yaml)', async () => {
      const homeWorkflowDir = join(homeDir, 'workflows', 'triage');
      await mkdir(homeWorkflowDir, { recursive: true });
      await writeFile(
        join(homeWorkflowDir, 'grouped.yaml'),
        'name: grouped-workflow\ndescription: In a subfolder\nnodes:\n  - id: n\n    command: c\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const entry = result.workflows.find(w => w.workflow.name === 'grouped-workflow');
      expect(entry).toBeDefined();
      expect(entry?.source).toBe('global');
    });

    it('does NOT descend past the fixed pack/workflow boundary', async () => {
      const nestedDir = join(homeDir, 'workflows', 'a', 'b', 'c');
      await mkdir(nestedDir, { recursive: true });
      await writeFile(
        join(nestedDir, 'too-deep.yaml'),
        'name: too-deep\ndescription: Nested too deep\nnodes:\n  - id: n\n    command: c\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const entry = result.workflows.find(w => w.workflow.name === 'too-deep');
      expect(entry).toBeUndefined();
    });
  });

  describe('legacy ~/.archon/.archon/workflows/ deprecation warning', () => {
    let homeDir: string;
    const originalArchonHome = process.env.ARCHON_HOME;
    const originalArchonDocker = process.env.ARCHON_DOCKER;

    beforeEach(async () => {
      homeDir = join(tmpdir(), `legacy-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(homeDir, { recursive: true });
      process.env.ARCHON_HOME = homeDir;
      delete process.env.ARCHON_DOCKER;
      const { resetLegacyHomeWarningForTests } = await import('./workflow-discovery');
      resetLegacyHomeWarningForTests();
      mockLogger.warn.mockClear();
    });

    afterEach(async () => {
      try {
        await rm(homeDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
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

    it('emits a WARN with the migration command when the legacy path exists', async () => {
      const legacyDir = join(homeDir, '.archon', 'workflows');
      await mkdir(legacyDir, { recursive: true });
      await writeFile(
        join(legacyDir, 'stranded.yaml'),
        'name: stranded\ndescription: At the old path\nnodes:\n  - id: n\n    command: c\n'
      );

      await discoverWorkflows(testDir, { loadDefaults: false });

      const warnCalls = mockLogger.warn.mock.calls;
      const legacyWarn = warnCalls.find(call => call[1] === 'workflow.legacy_home_path_detected');
      expect(legacyWarn).toBeDefined();
      expect(legacyWarn?.[0]).toMatchObject({
        legacyPath: legacyDir,
        newPath: join(homeDir, 'workflows'),
        moveCommand: expect.stringContaining('mv'),
      });
    });

    it('does NOT load workflows from the legacy path (clean cut)', async () => {
      const legacyDir = join(homeDir, '.archon', 'workflows');
      await mkdir(legacyDir, { recursive: true });
      await writeFile(
        join(legacyDir, 'stranded.yaml'),
        'name: stranded\ndescription: At the old path\nnodes:\n  - id: n\n    command: c\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const stranded = result.workflows.find(w => w.workflow.name === 'stranded');
      expect(stranded).toBeUndefined();
    });

    it('warns exactly once per process, even across multiple discovery calls', async () => {
      const legacyDir = join(homeDir, '.archon', 'workflows');
      await mkdir(legacyDir, { recursive: true });

      await discoverWorkflows(testDir, { loadDefaults: false });
      await discoverWorkflows(testDir, { loadDefaults: false });
      await discoverWorkflows(testDir, { loadDefaults: false });

      const warnCalls = mockLogger.warn.mock.calls.filter(
        call => call[1] === 'workflow.legacy_home_path_detected'
      );
      expect(warnCalls).toHaveLength(1);
    });

    it('does not emit the warning when the legacy path is absent', async () => {
      // No legacy directory created — warning should not fire.
      await discoverWorkflows(testDir, { loadDefaults: false });

      const warnCalls = mockLogger.warn.mock.calls.filter(
        call => call[1] === 'workflow.legacy_home_path_detected'
      );
      expect(warnCalls).toHaveLength(0);
    });
  });

  describe('discoverWorkflowsWithConfig', () => {
    it('should pass loadDefaults from config to discoverWorkflows', async () => {
      const { discoverWorkflowsWithConfig } = await import('./workflow-discovery');
      const mockLoadConfig = mock(async () => ({
        defaults: { loadDefaultWorkflows: false },
      }));

      const result = await discoverWorkflowsWithConfig(testDir, mockLoadConfig);

      // With loadDefaults: false, no archon-* defaults should appear
      const archonWorkflow = result.workflows.find(w => w.workflow.name.startsWith('archon-'));
      expect(archonWorkflow).toBeUndefined();
      expect(mockLoadConfig).toHaveBeenCalledWith(testDir);
    });

    it('should default to loadDefaults: true when config load fails', async () => {
      const { discoverWorkflowsWithConfig } = await import('./workflow-discovery');
      const mockLoadConfig = mock(async () => {
        throw new Error('Config not found');
      });

      const result = await discoverWorkflowsWithConfig(testDir, mockLoadConfig);

      // With config failure, defaults to true, so archon-* should appear
      const archonWorkflow = result.workflows.find(w => w.workflow.name === 'archon-assist');
      expect(archonWorkflow).toBeDefined();
    });

    it('surfaces home-scoped workflows without any option — discovery reads ~/.archon/workflows/ internally', async () => {
      const { discoverWorkflowsWithConfig, resetLegacyHomeWarningForTests } =
        await import('./workflow-discovery');
      resetLegacyHomeWarningForTests();

      const homeDir = join(
        tmpdir(),
        `home-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      const homeWorkflowDir = join(homeDir, 'workflows');
      await mkdir(homeWorkflowDir, { recursive: true });
      await writeFile(
        join(homeWorkflowDir, 'home-only.yaml'),
        'name: home-only\ndescription: From home\nnodes:\n  - id: foo\n    command: foo\n'
      );

      const originalArchonHome = process.env.ARCHON_HOME;
      const originalArchonDocker = process.env.ARCHON_DOCKER;
      process.env.ARCHON_HOME = homeDir;
      delete process.env.ARCHON_DOCKER;
      try {
        const mockLoadConfig = mock(async () => ({
          defaults: { loadDefaultWorkflows: false },
        }));

        const result = await discoverWorkflowsWithConfig(testDir, mockLoadConfig);
        const entry = result.workflows.find(w => w.workflow.name === 'home-only');
        expect(entry).toBeDefined();
        expect(entry?.source).toBe('global');
      } finally {
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
        await rm(homeDir, { recursive: true, force: true });
      }
    });
  });

  describe('binary build bundled workflows', () => {
    let isBinaryBuildSpy: Mock<typeof bundledDefaults.isBinaryBuild>;

    beforeEach(() => {
      isBinaryBuildSpy = spyOn(bundledDefaults, 'isBinaryBuild');
    });

    afterEach(() => {
      isBinaryBuildSpy.mockRestore();
    });

    it('should load bundled workflows when running as binary', async () => {
      // Simulate binary build
      isBinaryBuildSpy.mockReturnValue(true);

      const result = await discoverWorkflows(testDir, { loadDefaults: true });
      const workflows = result.workflows.map(ws => ws.workflow);

      // Should load bundled workflows
      expect(workflows.length).toBeGreaterThanOrEqual(1);
      // Check that known bundled workflows are loaded
      const archonAssist = workflows.find(w => w.name === 'archon-assist');
      expect(archonAssist).toBeDefined();
    });

    it('should skip bundled workflows when loadDefaults is false', async () => {
      // Simulate binary build
      isBinaryBuildSpy.mockReturnValue(true);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      // Should not have any bundled defaults
      const archonWorkflow = workflows.find(w => w.name.startsWith('archon-'));
      expect(archonWorkflow).toBeUndefined();
    });

    it('should allow repo workflows to override bundled defaults', async () => {
      // Simulate binary build
      isBinaryBuildSpy.mockReturnValue(true);

      // Create repo workflow with same filename as bundled default
      const repoWorkflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(repoWorkflowDir, { recursive: true });
      const repoWorkflowYaml = `name: custom-assist-override
description: Custom override of archon-assist
nodes:
  - id: custom
    command: custom
`;
      await writeFile(join(repoWorkflowDir, 'archon-assist.yaml'), repoWorkflowYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: true });
      const workflows = result.workflows.map(ws => ws.workflow);

      // Repo workflow should override bundled default
      const assistWorkflow = workflows.find(
        w => w.name === 'custom-assist-override' || w.name === 'archon-assist'
      );
      expect(assistWorkflow).toBeDefined();
      expect(assistWorkflow?.name).toBe('custom-assist-override');
    });

    it('should combine bundled workflows with repo workflows', async () => {
      // Simulate binary build
      isBinaryBuildSpy.mockReturnValue(true);

      // Create repo workflow with unique name
      const repoWorkflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(repoWorkflowDir, { recursive: true });
      const repoWorkflowYaml = `name: my-repo-workflow
description: A repo-specific workflow
nodes:
  - id: custom
    command: custom
`;
      await writeFile(join(repoWorkflowDir, 'my-repo.yaml'), repoWorkflowYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: true });
      const workflows = result.workflows.map(ws => ws.workflow);

      // Should have both bundled and repo workflows
      const archonAssist = workflows.find(w => w.name === 'archon-assist');
      const repoWorkflow = workflows.find(w => w.name === 'my-repo-workflow');
      expect(archonAssist).toBeDefined();
      expect(repoWorkflow).toBeDefined();
    });
  });

  describe('error accumulation', () => {
    it('should return errors for YAML missing name', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'invalid.yaml'),
        'description: Missing name\nnodes:\n  - id: plan\n    command: plan\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].filename).toBe('invalid.yaml');
      expect(result.errors[0].errorType).toBe('validation_error');
      expect(result.errors[0].error).toContain('name');
    });

    it('should load valid workflows and report errors for invalid ones', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'good.yaml'),
        'name: good\ndescription: Works\nnodes:\n  - id: plan\n    command: plan\n'
      );
      await writeFile(
        join(workflowDir, 'bad.yaml'),
        'description: Bad name type\nnodes:\n  - id: plan\n    command: plan\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(1);
      expect(result.workflows[0].workflow.name).toBe('good');
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].filename).toBe('bad.yaml');
    });

    it('should return empty errors array when all workflows are valid', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'valid.yaml'),
        'name: valid\ndescription: Valid\nnodes:\n  - id: plan\n    command: plan\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(1);
      expect(result.errors).toHaveLength(0);
    });

    it('should return empty errors when no workflows exist', async () => {
      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should report YAML parse errors', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(join(workflowDir, 'broken.yaml'), 'name: test\ninvalid: [');

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].filename).toBe('broken.yaml');
      expect(result.errors[0].errorType).toBe('parse_error');
      expect(result.errors[0].error).toContain('YAML parse error');
    });

    it('should accumulate errors from subdirectories', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      const subDir = join(workflowDir, 'sub');
      await mkdir(subDir, { recursive: true });

      // Invalid in root
      await writeFile(
        join(workflowDir, 'root-bad.yaml'),
        'description: No name\nnodes:\n  - id: plan\n    command: plan\n'
      );
      // Invalid in subdirectory
      await writeFile(
        join(subDir, 'sub-bad.yaml'),
        'name: sub\nnodes:\n  - id: plan\n    command: plan\n'
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(2);
      const filenames = result.errors.map(e => e.filename).sort();
      expect(filenames).toEqual(['root-bad.yaml', 'sub-bad.yaml']);
    });

    it('should report validation error for empty YAML content', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(join(workflowDir, 'empty.yaml'), '');

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].filename).toBe('empty.yaml');
      expect(result.errors[0].errorType).toBe('validation_error');
      expect(result.errors[0].error).toContain('empty');
    });

    it('should report validation error for YAML that parses to non-object', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(join(workflowDir, 'scalar.yaml'), 'just a string');

      const result = await discoverWorkflows(testDir, { loadDefaults: false });

      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].filename).toBe('scalar.yaml');
      expect(result.errors[0].error).toContain('empty');
    });

    it.skipIf(isWindows)(
      'should report directory read errors for non-ENOENT failures',
      async () => {
        const workflowDir = join(testDir, '.archon', 'workflows');
        await mkdir(workflowDir, { recursive: true });

        // Create a file where a directory is expected (causes ENOTDIR on readdir)
        await writeFile(join(workflowDir, 'not-a-dir'), 'file content');

        // Create a YAML file that references the fake dir as a subdirectory
        // The loader recurses into directories, so create a setup that triggers readdir error
        // Simplest: create a workflow dir, then a symlink to nowhere
        const brokenLink = join(workflowDir, 'broken-subdir');
        const { symlink } = await import('fs/promises');
        await symlink('/nonexistent/path', brokenLink);

        const result = await discoverWorkflows(testDir, { loadDefaults: false });

        // The symlink stat will fail, producing a read_error
        const readErrors = result.errors.filter(e => e.errorType === 'read_error');
        expect(readErrors.length).toBeGreaterThanOrEqual(1);
      }
    );
  });

  describe('bash node parsing', () => {
    it('should parse a valid bash node', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bash-test.yaml'),
        `
name: bash-test
description: Test bash node
nodes:
  - id: stats
    bash: "echo hello"
  - id: process
    command: my-cmd
    depends_on: [stats]
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);

      const wf = result.workflows[0].workflow;
      const nodes = wf.nodes as DagNode[];
      expect(nodes).toBeDefined();

      expect(nodes).toHaveLength(2);
      const node0 = nodes[0];
      expect(isExecNode(node0)).toBe(true);
      if (isExecNode(node0)) {
        expect(node0.script).toBe('echo hello');
      }
    });

    it('should parse bash node with timeout', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bash-timeout.yaml'),
        `
name: bash-timeout
description: Bash with timeout
nodes:
  - id: slow
    bash: "sleep 1 && echo done"
    timeout: 30000
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      const wf = result.workflows[0].workflow;
      const nodes = wf.nodes as DagNode[];
      expect(nodes).toBeDefined();
      const node0 = nodes[0];
      if (isExecNode(node0)) {
        expect(node0.timeout).toBe(30000);
      }
    });

    it('should reject bash + command combination', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bash-cmd.yaml'),
        `
name: bash-cmd-conflict
description: Bash and command
nodes:
  - id: bad
    bash: "echo hi"
    command: my-cmd
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/mutually exclusive/i);
    });

    it('should reject bash + prompt combination', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bash-prompt.yaml'),
        `
name: bash-prompt-conflict
description: Bash and prompt
nodes:
  - id: bad
    bash: "echo hi"
    prompt: "do something"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/mutually exclusive/i);
    });

    it('should reject invalid timeout (negative)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bad-timeout.yaml'),
        `
name: bad-timeout
description: Invalid timeout
nodes:
  - id: bad
    bash: "echo hi"
    timeout: -1
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/timeout.*positive/i);
    });

    it('should reject invalid timeout (string)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'string-timeout.yaml'),
        `
name: string-timeout
description: String timeout
nodes:
  - id: bad
    bash: "echo hi"
    timeout: "fast"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/timeout/i);
    });

    it('should parse idle_timeout on command node', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'idle-timeout.yaml'),
        `
name: idle-timeout
description: Node with idle timeout
nodes:
  - id: long-running
    command: my-cmd
    idle_timeout: 1800000
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      const wf = result.workflows[0].workflow;
      expect(wf.nodes as DagNode[]).toBeDefined();
      expect((wf.nodes as DagNode[])[0].idle_timeout).toBe(1800000);
    });

    it('should parse idle_timeout on prompt node', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'idle-timeout-prompt.yaml'),
        `
name: idle-timeout-prompt
description: Prompt node with idle timeout
nodes:
  - id: long-prompt
    prompt: "do something slow"
    idle_timeout: 600000
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      const wf = result.workflows[0].workflow;
      expect(wf.nodes as DagNode[]).toBeDefined();
      expect((wf.nodes as DagNode[])[0].idle_timeout).toBe(600000);
    });

    it('should parse idle_timeout on bash node', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'idle-timeout-bash.yaml'),
        `
name: idle-timeout-bash
description: Bash node with idle timeout
nodes:
  - id: slow-bash
    bash: "sleep 100"
    idle_timeout: 900000
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      const wf = result.workflows[0].workflow;
      expect(wf.nodes as DagNode[]).toBeDefined();
      if (isExecNode((wf.nodes as DagNode[])[0])) {
        expect((wf.nodes as DagNode[])[0].idle_timeout).toBe(900000);
      }
    });

    it('should reject invalid idle_timeout (negative)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bad-idle-timeout.yaml'),
        `
name: bad-idle-timeout
description: Invalid idle timeout
nodes:
  - id: bad
    command: my-cmd
    idle_timeout: -1
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/idle_timeout.*positive/i);
    });

    it('should reject invalid idle_timeout (string)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'string-idle-timeout.yaml'),
        `
name: string-idle-timeout
description: String idle timeout
nodes:
  - id: bad
    prompt: "do something"
    idle_timeout: "slow"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/idle_timeout/i);
    });

    it('should reject invalid idle_timeout (Infinity)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'inf-idle-timeout.yaml'),
        `
name: inf-idle-timeout
description: Infinity idle timeout
nodes:
  - id: bad
    prompt: "do something"
    idle_timeout: .inf
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      // zod v4's base `z.number()` rejects Infinity before the custom finite/positive
      // refinement runs, so the message is the base "expected number" form; either is fine.
      expect(result.errors[0].error).toMatch(/idle_timeout.*(finite.*positive|expected number)/i);
    });

    it('should ignore AI-specific fields on bash nodes (parses successfully, fields stripped)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bash-ai-fields.yaml'),
        `
name: bash-ai-fields
description: Bash with AI fields
nodes:
  - id: stats
    bash: "wc -l *.ts"
    provider: claude
    model: haiku
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      // Should parse successfully (warning only, not error)
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);

      const wf = result.workflows[0].workflow;
      expect(wf.nodes as DagNode[]).toBeDefined();
      // AI fields should NOT appear on the parsed bash node
      const node = (wf.nodes as DagNode[])[0];
      expect(isExecNode(node)).toBe(true);
      expect(node.provider).toBeUndefined();
      expect(node.model).toBeUndefined();
    });

    it('should NOT warn about model/provider on loop nodes (they are supported)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-model.yaml'),
        `
name: loop-model
description: Loop with model override
nodes:
  - id: iterate
    loop:
      prompt: "Do something"
      until: "COMPLETE"
      max_iterations: 3
    provider: claude
    model: claude-opus-4-6
`
      );

      mockLogger.warn.mockClear();
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);

      const node = (result.workflows[0].workflow.nodes as DagNode[])[0];
      expect(isLoopNode(node)).toBe(true);

      // model and provider should NOT trigger a warning
      const warnCalls = mockLogger.warn.mock.calls;
      const aiFieldWarnings = warnCalls.filter(
        call => typeof call[1] === 'string' && call[1].includes('ai_fields_ignored')
      );
      expect(aiFieldWarnings).toHaveLength(0);
    });

    it('should warn about unsupported AI fields on loop nodes (not model/provider)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-unsupported.yaml'),
        `
name: loop-unsupported
description: Loop with unsupported AI fields
nodes:
  - id: iterate
    loop:
      prompt: "Do something"
      until: "COMPLETE"
      max_iterations: 3
    model: claude-opus-4-6
    mcp: ./mcp.json
`
      );

      mockLogger.warn.mockClear();
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);

      // Should warn about mcp but NOT about model
      const warnCalls = mockLogger.warn.mock.calls;
      const aiFieldWarnings = warnCalls.filter(
        call => typeof call[1] === 'string' && call[1].includes('ai_fields_ignored')
      );
      expect(aiFieldWarnings).toHaveLength(1);
      const warnedFields = (aiFieldWarnings[0][0] as { fields: string[] }).fields;
      expect(warnedFields).toContain('mcp');
      expect(warnedFields).not.toContain('model');
      expect(warnedFields).not.toContain('provider');
    });

    it('should NOT warn about output_format on a loop node (#2563)', async () => {
      // A loop: node makes its own sendQuery, so the schema is honoured rather than
      // warned-and-dropped. It stays warned on loop_group, which never calls sendQuery.
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-structured.yaml'),
        `
name: loop-structured
description: Loop with a structured completion channel
nodes:
  - id: iterate
    output_format:
      type: object
      properties:
        done:
          type: boolean
      required: [done]
    loop:
      prompt: "Do something"
      max_iterations: 3
      until_field: done
`
      );

      mockLogger.warn.mockClear();
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);

      const aiFieldWarnings = mockLogger.warn.mock.calls.filter(
        call => typeof call[1] === 'string' && call[1].includes('ai_fields_ignored')
      );
      expect(aiFieldWarnings).toHaveLength(0);

      const wf = result.workflows[0].workflow;
      const node0 = (wf.nodes as DagNode[])[0];
      expect(isLoopNode(node0)).toBe(true);
      if (isLoopNode(node0)) {
        expect(node0.loop.until_field).toBe('done');
        expect(node0.output_format).toBeDefined();
      }
    });

    it('warns that output_format is ignored on a loop_group', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-group-structured.yaml'),
        `
name: loop-group-structured
description: Group with an unsupported structured output declaration
nodes:
  - id: iterate
    provider: claude
    model: claude-opus-4-6
    output_format:
      type: object
      properties:
        done:
          type: boolean
      required: [done]
    loop_group:
      until_bash: exit 0
      max_iterations: 1
      nodes:
        - id: work
          bash: echo done
`
      );

      mockLogger.warn.mockClear();
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
      expect(isLoopGroupNode((result.workflows[0].workflow.nodes as DagNode[])[0])).toBe(true);

      const aiFieldWarnings = mockLogger.warn.mock.calls.filter(
        call => typeof call[1] === 'string' && call[1].includes('ai_fields_ignored')
      );
      expect(aiFieldWarnings).toHaveLength(1);
      const warnedFields = (aiFieldWarnings[0][0] as { fields: string[] }).fields;
      expect(warnedFields).toContain('output_format');
      expect(warnedFields).not.toContain('model');
      expect(warnedFields).not.toContain('provider');
    });

    it('should NOT warn about pi: on loop nodes and should preserve it (#2133)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      // The portable pi: posture is threaded into each loop iteration's sendQuery,
      // so it must survive the transform AND not be flagged as an ignored AI field.
      await writeFile(
        join(workflowDir, 'loop-pi.yaml'),
        // No workflow-level provider: (unregistered in this unit context) — the
        // pi: block is plain node data the loader preserves regardless of provider.
        `
name: loop-pi
description: Loop with per-node Pi posture
nodes:
  - id: implement
    loop:
      prompt: "Do something"
      until: "COMPLETE"
      max_iterations: 3
    pi:
      interactive: false
      extensionFlags:
        plan: false
`
      );

      mockLogger.warn.mockClear();
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);

      const node = (result.workflows[0].workflow.nodes as DagNode[])[0];
      expect(isLoopNode(node)).toBe(true);
      expect((node as typeof node & { pi?: unknown }).pi).toEqual({
        interactive: false,
        extensionFlags: { plan: false },
      });

      const warnCalls = mockLogger.warn.mock.calls;
      const aiFieldWarnings = warnCalls.filter(
        call => typeof call[1] === 'string' && call[1].includes('ai_fields_ignored')
      );
      expect(aiFieldWarnings).toHaveLength(0);
    });
  });

  describe('DAG output ref validation', () => {
    it('should reject a workflow where when: references an unknown node output', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bad-when-ref.yaml'),
        `
name: bad-when-ref
description: Unknown output ref in when
nodes:
  - id: classify
    prompt: "Classify the input"
  - id: implement
    prompt: "Implement the fix"
    depends_on: [classify]
    when: "$clasify.output == 'BUG'"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/unknown node/i);
      expect(result.errors[0].error).toContain('clasify');
    });

    it('should reject a workflow where prompt: references an unknown node output', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bad-prompt-ref.yaml'),
        `
name: bad-prompt-ref
description: Unknown output ref in prompt
nodes:
  - id: analyze
    prompt: "Analyze the code"
  - id: fix
    prompt: "Fix this: $analyize.output"
    depends_on: [analyze]
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/unknown node/i);
      expect(result.errors[0].error).toContain('analyize');
    });

    it('should accept a workflow where output refs use valid existing node IDs', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'valid-refs.yaml'),
        `
name: valid-refs
description: Valid output refs
nodes:
  - id: classify
    prompt: "Classify the input"
  - id: implement
    prompt: "Fix this: $classify.output"
    depends_on: [classify]
    when: "$classify.output.type == 'BUG'"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
    });

    it('should accept a workflow where a node has both when: and prompt: with valid refs', async () => {
      // Exercises the lastIndex = 0 reset across multiple sources per node
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'multi-source.yaml'),
        `
name: multi-source
description: Node with both when and prompt refs
nodes:
  - id: step1
    prompt: "Do step 1"
  - id: step2
    prompt: "Based on $step1.output, do step 2"
    depends_on: [step1]
    when: "$step1.output.verdict == 'go'"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
    });

    it('should validate bash node $nodeId.output refs at load time', async () => {
      // bash: (like script/cancel/approval.message/until_bash) is substituted at
      // runtime, so a dangling ref there silently resolves to '' — it must be caught
      // at load time, same as prompt/when refs.
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bash-unknown-ref.yaml'),
        `
name: bash-unknown-ref
description: Bash node with a dangling output ref
nodes:
  - id: step1
    prompt: "Do step 1"
  - id: step2
    bash: "echo $typo.output"
    depends_on: [step1]
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].error).toContain('$typo.output');
      expect(result.workflows).toHaveLength(0);
    });

    it('treats $INPUTS.output as a declared input macro before include expansion', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      await Promise.all([
        writeFile(
          join(workflowDir, 'input-output-block.yaml'),
          `
name: input-output-block
description: Block with an input named output
inputs:
  output:
    required: true
nodes:
  - id: review
    prompt: "Review $INPUTS.output"
`
        ),
        writeFile(
          join(workflowDir, 'input-output-parent.yaml'),
          `
name: input-output-parent
description: Includes the input output block
nodes:
  - id: inc
    include: input-output-block
    with:
      output: bound-value
`
        ),
      ]);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      const parent = result.workflows.find(
        item => item.workflow.name === 'input-output-parent'
      )?.workflow;
      const review = parent?.nodes.find(node => node.id === 'inc__review');
      expect(inlinePrompt(review)).toBe('Review bound-value');
    });

    it('should validate script/cancel/approval.message/until_bash refs at load time', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      // A script node with a dangling ref is rejected (representative of the other
      // newly-scanned code/text surfaces).
      await writeFile(
        join(workflowDir, 'script-unknown-ref.yaml'),
        `
name: script-unknown-ref
description: Script node with a dangling output ref
nodes:
  - id: step1
    prompt: "Do step 1"
  - id: step2
    script: "console.log($missing.output)"
    runtime: bun
    depends_on: [step1]
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].error).toContain('$missing.output');
    });

    it('should validate $nodeId.output inside fenced code blocks in prompt: bodies', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'fenced-doc.yaml'),
        `
name: fenced-doc
description: Prompt body with a fenced code example mentioning a literal output ref
nodes:
  - id: writer
    prompt: |
      Author a workflow that uses a script node:

      \`\`\`yaml
      script: |
        const data = $other-node.output;
        console.log(data);
      \`\`\`
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain('$other-node.output');
      expect(result.workflows).toHaveLength(0);
    });

    it('should validate $nodeId.output inside inline backtick code in prompt: bodies', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'inline-doc.yaml'),
        `
name: inline-doc
description: Prompt body that mentions a placeholder via inline backticks
nodes:
  - id: writer
    prompt: |
      Use \`$nodeId.output\` to reference a sibling node's output.
      For Python, prefer \`json.loads("""$nodeId.output""")\`.
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain('$nodeId.output');
      expect(result.workflows).toHaveLength(0);
    });

    it('should validate shorthand when refs at load time', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      await writeFile(
        join(workflowDir, 'bad-when-shorthand.yaml'),
        `name: bad-when-shorthand
description: dangling shorthand condition
nodes:
  - id: task
    prompt: work
    when: "$caller.status == 'ok'"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain("field 'when'");
      expect(result.errors[0].error).toContain('$caller.status');
    });

    it('should validate approval.on_reject.prompt refs at load time', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      await writeFile(
        join(workflowDir, 'bad-rejection-ref.yaml'),
        `name: bad-rejection-ref
description: dangling rejection prompt ref
nodes:
  - id: gate
    approval:
      message: Approve?
      on_reject:
        prompt: "Revise $caller.output"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain("field 'approval.on_reject.prompt'");
      expect(result.errors[0].error).toContain('$caller.output');
    });

    it('should still reject unknown $nodeId.output refs outside code', async () => {
      // Stripping fenced/inline code must not weaken validation of real refs
      // that appear in prose outside any code marker.
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'mixed-ref.yaml'),
        `
name: mixed-ref
description: Real (unknown) ref in prose plus a fenced doc example
nodes:
  - id: step1
    prompt: |
      Build on $missing-node.output to do the work.

      Example:

      \`\`\`
      const x = $other-node.output;
      \`\`\`
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain('missing-node');
    });

    it('should validate $nodeId.output inside fenced code in loop.prompt', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-fenced.yaml'),
        `
name: loop-fenced
description: Loop with a fenced doc example in its prompt
nodes:
  - id: my-loop
    loop:
      prompt: |
        Iterate. Example syntax:

        \`\`\`
        $other-node.output
        \`\`\`
      until: DONE
      max_iterations: 3
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain('$other-node.output');
      expect(result.workflows).toHaveLength(0);
    });
  });

  describe('when: whole-output comparison against an AI producer (#2566)', () => {
    /** Write one workflow YAML and load it. */
    async function loadYaml(filename: string, yaml: string) {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      await writeFile(join(workflowDir, filename), yaml);
      return discoverWorkflows(testDir, { loadDefaults: false });
    }

    it('rejects a bare $node.output comparison when the producer is a prompt node', async () => {
      const result = await loadYaml(
        'ai-whole-output.yaml',
        `
name: ai-whole-output
description: Compares a whole AI reply to a literal
nodes:
  - id: analyze
    prompt: "Analyze the issue"
  - id: decide
    prompt: "Decide"
    depends_on: [analyze]
    when: "$analyze.output == 'BUG'"
`
      );
      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      const message = result.errors[0].error;
      expect(message).toContain("compares the whole output of AI node 'analyze'");
      // The message must name the fix, not just the problem.
      expect(message).toContain('output_format');
      expect(message).toContain("$analyze.output.status == 'BUG'");
    });

    it('rejects it for a command producer — a command file is a prompt in another file', async () => {
      const result = await loadYaml(
        'ai-command-output.yaml',
        `
name: ai-command-output
description: Command producer
nodes:
  - id: analyze
    command: analyze-issue
  - id: decide
    prompt: "Decide"
    depends_on: [analyze]
    when: "$analyze.output == 'BUG'"
`
      );
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain("whole output of AI node 'analyze'");
    });

    it('rejects it for a loop producer', async () => {
      const result = await loadYaml(
        'ai-loop-output.yaml',
        `
name: ai-loop-output
description: Loop producer
nodes:
  - id: refine
    loop:
      prompt: "Refine until done"
      until: DONE
      max_iterations: 3
  - id: decide
    prompt: "Decide"
    depends_on: [refine]
    when: "$refine.output == 'DONE'"
`
      );
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain("whole output of AI node 'refine'");
      // Since #2563 a `loop:` is schema-capable, so it gets the SAME remedy as a
      // prompt node: declare output_format and compare a field. (A `loop_group:` still
      // gets its own reason — it never calls the provider itself.)
      expect(result.errors[0].error).toContain("Declare 'output_format'");
    });

    it('ACCEPTS a loop producer that declares an output_format (#2563)', async () => {
      // `output_format` now reaches a LoopNode — it runs its own sendQuery — so the
      // loop's output IS the validated JSON document and declaring a schema is a real
      // opt-out, exactly as it is for a prompt node. Before #2563 this was rejected on
      // the grounds that the schema was dropped at parse, which is no longer true.
      const result = await loadYaml(
        'ai-loop-declared-format.yaml',
        `
name: ai-loop-declared-format
description: output_format on a loop node is a real opt-out
nodes:
  - id: refine
    output_format:
      type: object
      properties:
        status:
          type: string
    loop:
      prompt: "Refine until done"
      until: DONE
      max_iterations: 3
  - id: decide
    prompt: "Decide"
    depends_on: [refine]
    when: "$refine.output == 'DONE'"
`
      );
      expect(result.errors).toHaveLength(0);
    });

    it('rejects it for a loop_group producer that declares output_format, for its own reason', async () => {
      // Unlike `loop:`, a loop_group KEEPS `output_format` through the transform — so the
      // "dropped at parse" reason would be wrong here. The group is still rejected
      // because its completion returns the last iteration's text, never the JSON.
      const result = await loadYaml(
        'ai-loop-group-declared-format.yaml',
        `
name: ai-loop-group-declared-format
description: a loop_group keeps output_format but its output is still iteration text
nodes:
  - id: refine
    output_format:
      type: object
      properties:
        status:
          type: string
    loop_group:
      until: DONE
      max_iterations: 3
      nodes:
        - id: body
          prompt: "Do a pass"
  - id: decide
    prompt: "Decide"
    depends_on: [refine]
    when: "$refine.output == 'DONE'"
`
      );
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain("last iteration's raw text");
      expect(result.errors[0].error).not.toContain("dropped from a 'loop:' node");
    });

    it('rejects it for a loop_group producer', async () => {
      const result = await loadYaml(
        'ai-loop-group-output.yaml',
        `
name: ai-loop-group-output
description: Loop group producer
nodes:
  - id: refine
    loop_group:
      until: DONE
      max_iterations: 3
      nodes:
        - id: body
          prompt: "Do a pass"
  - id: decide
    prompt: "Decide"
    depends_on: [refine]
    when: "$refine.output == 'DONE'"
`
      );
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain("whole output of AI node 'refine'");
      expect(result.errors[0].error).toContain("last iteration's raw text");
    });

    it('rejects it under a numeric operator too', async () => {
      const result = await loadYaml(
        'ai-numeric.yaml',
        `
name: ai-numeric
description: Numeric comparison on free-form output
nodes:
  - id: score
    prompt: "Score it"
  - id: gate
    prompt: "Gate"
    depends_on: [score]
    when: "$score.output > '80'"
`
      );
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain("whole output of AI node 'score'");
    });

    it('rejects it inside a compound expression', async () => {
      const result = await loadYaml(
        'ai-compound.yaml',
        `
name: ai-compound
description: Hazard hidden in the second half of an AND
nodes:
  - id: flag
    bash: "echo yes"
  - id: analyze
    prompt: "Analyze"
  - id: decide
    prompt: "Decide"
    depends_on: [flag, analyze]
    when: "$flag.output == 'yes' && $analyze.output == 'BUG'"
`
      );
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain("whole output of AI node 'analyze'");
    });

    it('rejects it from a loop_group body referencing an enclosing AI node', async () => {
      const result = await loadYaml(
        'ai-enclosing.yaml',
        `
name: ai-enclosing
description: Body node branching on an outer AI node's whole output
nodes:
  - id: analyze
    prompt: "Analyze"
  - id: refine
    depends_on: [analyze]
    loop_group:
      until: DONE
      max_iterations: 3
      nodes:
        - id: body
          prompt: "Do a pass"
          when: "$analyze.output == 'BUG'"
`
      );
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain("whole output of AI node 'analyze'");
    });

    it('accepts a bash producer — its stdout is author-controlled and exact', async () => {
      const result = await loadYaml(
        'bash-whole-output.yaml',
        `
name: bash-whole-output
description: Whole-output equality against a shell producer
nodes:
  - id: check
    bash: "test -f README.md && echo 'true' || echo 'false'"
  - id: notify
    prompt: "Notify"
    depends_on: [check]
    when: "$check.output == 'true'"
`
      );
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
    });

    it('accepts a script producer', async () => {
      const result = await loadYaml(
        'script-whole-output.yaml',
        `
name: script-whole-output
description: Whole-output equality against a script producer
nodes:
  - id: check
    runtime: bun
    script: "console.log('ok')"
  - id: notify
    prompt: "Notify"
    depends_on: [check]
    when: "$check.output == 'ok'"
`
      );
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
    });

    it('accepts an AI producer that declares output_format', async () => {
      const result = await loadYaml(
        'declared-output-format.yaml',
        `
name: declared-output-format
description: AI producer with a declared schema
nodes:
  - id: analyze
    prompt: "Analyze"
    output_format:
      type: object
      properties:
        status:
          type: string
  - id: decide
    prompt: "Decide"
    depends_on: [analyze]
    when: "$analyze.output == '{}'"
`
      );
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
    });

    it('accepts a field access on an AI producer', async () => {
      const result = await loadYaml(
        'field-access.yaml',
        `
name: field-access
description: Field access is the supported pattern
nodes:
  - id: analyze
    prompt: "Analyze"
  - id: decide
    prompt: "Decide"
    depends_on: [analyze]
    when: "$analyze.output.status == 'BUG'"
`
      );
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
    });

    it('accepts a $INPUTS ref, which names no producer at all', async () => {
      const result = await loadYaml(
        'inputs-when.yaml',
        `
name: inputs-when
description: Branching on a caller-supplied input
inputs:
  mode:
    default: fast
nodes:
  - id: fast-path
    prompt: "Go fast"
    when: "$INPUTS.mode == 'fast'"
`
      );
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
    });

    it('fires on the FLATTENED graph, catching a hazard that only appears after include expansion', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      // The block's sink is an AI node; the caller gates on `$blk.output`, which the
      // expander rewrites to that sink. Pre-expansion the producer is an `include:`
      // node (exempt), so only the post-expansion revalidation can catch this.
      await writeFile(
        join(workflowDir, 'block.yaml'),
        `
name: block
description: block whose sink is an AI node
nodes:
  - id: verdict
    prompt: "Give a verdict"
`
      );
      const result = await loadYaml(
        'includes-block.yaml',
        `
name: includes-block
description: gates on an included block's whole output
nodes:
  - id: blk
    include: block
  - id: act
    prompt: "Act"
    depends_on: [blk]
    when: "$blk.output == 'PASS'"
`
      );
      expect(result.workflows.find(w => w.workflow.name === 'includes-block')).toBeUndefined();
      const error = result.errors.find(e => e.filename.includes('includes-block'));
      expect(error?.error).toContain('compares the whole output of AI node');
    });

    it('leaves an unparseable when: to the executor rather than guessing at load', async () => {
      const result = await loadYaml(
        'unparseable-when.yaml',
        `
name: unparseable-when
description: Malformed condition, valid refs
nodes:
  - id: analyze
    prompt: "Analyze"
  - id: decide
    prompt: "Decide"
    depends_on: [analyze]
    when: "$analyze.output = 'BUG'"
`
      );
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
    });
  });

  describe('retry config parsing', () => {
    it('should parse retry config on DAG command node', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'retry-dag.yaml'),
        `
name: retry-dag
description: DAG node with retry
nodes:
  - id: sync
    command: sync-cmd
    retry:
      max_attempts: 2
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      const wf = result.workflows[0].workflow;
      expect((wf.nodes as DagNode[])[0].retry).toEqual({ max_attempts: 2 });
    });

    it('should parse retry config on DAG bash node', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'retry-bash.yaml'),
        `
name: retry-bash
description: Bash node with retry
nodes:
  - id: deploy
    bash: "npm run deploy"
    retry:
      max_attempts: 1
      delay_ms: 2000
      on_error: all
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      const wf = result.workflows[0].workflow;
      if (isExecNode((wf.nodes as DagNode[])[0])) {
        expect((wf.nodes as DagNode[])[0].retry).toEqual({
          max_attempts: 1,
          delay_ms: 2000,
          on_error: 'all',
        });
      }
    });

    it('should parse retry config on DAG prompt node', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'retry-prompt.yaml'),
        `
name: retry-prompt
description: Prompt node with retry config
nodes:
  - id: summarise
    prompt: "Summarise the changes"
    retry:
      max_attempts: 2
      delay_ms: 4000
      on_error: transient
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      const wf = result.workflows[0].workflow;
      expect((wf.nodes as DagNode[])[0].retry).toEqual({
        max_attempts: 2,
        delay_ms: 4000,
        on_error: 'transient',
      });
    });

    it('should reject retry with missing max_attempts', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bad-retry.yaml'),
        `
name: bad-retry
description: Missing required field
nodes:
  - id: my-cmd
    command: my-cmd
    retry:
      delay_ms: 5000
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      // zod v4 reports a missing required field as "expected number, received undefined"
      // (v3 said "Required"); the field path is the stable part.
      expect(result.errors[0].error).toMatch(/max_attempts.*(required|expected number)/i);
    });

    it('should reject retry with max_attempts out of range', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bad-retry-range.yaml'),
        `
name: bad-retry-range
description: max_attempts too high
nodes:
  - id: my-cmd
    command: my-cmd
    retry:
      max_attempts: 10
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/max_attempts.*between 1 and 5/i);
    });

    it('should reject retry with invalid on_error value', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bad-retry-onerror.yaml'),
        `
name: bad-retry-onerror
description: Invalid on_error value
nodes:
  - id: my-cmd
    command: my-cmd
    retry:
      max_attempts: 2
      on_error: always
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/on_error.*transient.*all/i);
    });

    it('should reject retry with delay_ms out of range', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bad-retry-delay.yaml'),
        `
name: bad-retry-delay
description: delay_ms too low
nodes:
  - id: my-cmd
    command: my-cmd
    retry:
      max_attempts: 2
      delay_ms: 100
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toMatch(/delay_ms.*1000.*60000/i);
    });

    it('should use defaults when retry fields are omitted', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'retry-defaults.yaml'),
        `
name: retry-defaults
description: Minimal retry config
nodes:
  - id: my-cmd
    command: my-cmd
    retry:
      max_attempts: 1
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      const wf = result.workflows[0].workflow;
      expect((wf.nodes as DagNode[])[0].retry).toEqual({ max_attempts: 1 });
      expect((wf.nodes as DagNode[])[0].retry?.delay_ms).toBeUndefined();
      expect((wf.nodes as DagNode[])[0].retry?.on_error).toBeUndefined();
    });
  });

  describe('loop node parsing', () => {
    it('should parse a valid loop node with all fields', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-test.yaml'),
        `
name: loop-test
description: Test loop node
nodes:
  - id: my-loop
    loop:
      prompt: "Do one task. Output <promise>COMPLETE</promise> when done."
      until: COMPLETE
      max_iterations: 10
      fresh_context: true
      until_bash: "test -f done.txt"
    idle_timeout: 300000
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);

      const wf = result.workflows[0].workflow;
      const nodes = wf.nodes as DagNode[];
      expect(nodes).toBeDefined();

      expect(nodes).toHaveLength(1);
      const node0 = nodes[0];
      expect(isLoopNode(node0)).toBe(true);
      if (isLoopNode(node0)) {
        expect(node0.loop.prompt).toContain('Do one task');
        expect(node0.loop.until).toBe('COMPLETE');
        expect(node0.loop.max_iterations).toBe(10);
        expect(node0.loop.fresh_context).toBe(true);
        expect(node0.loop.until_bash).toBe('test -f done.txt');
        expect(node0.idle_timeout).toBe(300000);
      }
    });

    it('should parse minimal loop node (only required fields)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-min.yaml'),
        `
name: loop-minimal
description: Minimal loop node
nodes:
  - id: simple-loop
    loop:
      prompt: "Iterate."
      until: DONE
      max_iterations: 3
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      const wf = result.workflows[0].workflow;
      const nodes = wf.nodes as DagNode[];
      expect(nodes).toBeDefined();
      const node0 = nodes[0];
      expect(isLoopNode(node0)).toBe(true);
      if (isLoopNode(node0)) {
        expect(node0.loop.fresh_context).toBe(false);
        expect(node0.loop.until_bash).toBeUndefined();
      }
    });

    it('should reject loop node missing loop.prompt', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-no-prompt.yaml'),
        `
name: loop-no-prompt
description: Missing prompt
nodes:
  - id: bad-loop
    loop:
      until: COMPLETE
      max_iterations: 5
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].error).toContain('loop.prompt');
    });

    it('should reject a loop node that declares no completion channel', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-no-until.yaml'),
        `
name: loop-no-until
description: Missing until
nodes:
  - id: bad-loop
    loop:
      prompt: "Do stuff"
      max_iterations: 5
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].error).toContain('completion channel');
      expect(result.errors[0].error).toContain('loop.until_bash');
    });

    it('should load a loop node that declares only until_bash (#2563)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-deterministic.yaml'),
        `
name: loop-deterministic
description: Deterministic completion, no prose sentinel
nodes:
  - id: fix
    loop:
      prompt: "Fix the failing tests"
      max_iterations: 5
      until_bash: "bun run test"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      const wf = result.workflows[0].workflow;
      expect(wf.name).toBe('loop-deterministic');
      const node0 = (wf.nodes as DagNode[])[0];
      expect(isLoopNode(node0)).toBe(true);
      if (isLoopNode(node0)) {
        expect(node0.loop.until).toBeUndefined();
        expect(node0.loop.until_bash).toBe('bun run test');
      }
    });

    it('should reject loop node with invalid max_iterations', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-bad-max.yaml'),
        `
name: loop-bad-max
description: Invalid max_iterations
nodes:
  - id: bad-loop
    loop:
      prompt: "Do stuff"
      until: DONE
      max_iterations: 0
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].error).toContain('max_iterations');
    });

    it('should reject node with both loop and command', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-cmd.yaml'),
        `
name: loop-cmd-conflict
description: Loop + command
nodes:
  - id: bad
    command: my-cmd
    loop:
      prompt: "Do stuff"
      until: DONE
      max_iterations: 5
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].error).toContain('mutually exclusive');
    });

    it('should reject node with both loop and bash', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-bash.yaml'),
        `
name: loop-bash-conflict
description: Loop + bash
nodes:
  - id: bad
    bash: "echo hi"
    loop:
      prompt: "Do stuff"
      until: DONE
      max_iterations: 5
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].error).toContain('mutually exclusive');
    });

    it('should validate $nodeId.output refs in loop.prompt', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-bad-ref.yaml'),
        `
name: loop-bad-ref
description: Bad ref in loop prompt
nodes:
  - id: my-loop
    loop:
      prompt: "Use $nonexistent.output to do stuff"
      until: DONE
      max_iterations: 5
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].error).toContain('nonexistent');
    });

    it('should parse loop node with depends_on', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-deps.yaml'),
        `
name: loop-deps
description: Loop with dependencies
nodes:
  - id: setup
    bash: "echo ready"
  - id: my-loop
    depends_on: [setup]
    loop:
      prompt: "Use $setup.output. Do task."
      until: COMPLETE
      max_iterations: 5
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      const wf = result.workflows[0].workflow;
      expect(wf.nodes as DagNode[]).toBeDefined();
      expect(wf.nodes as DagNode[]).toHaveLength(2);
      expect(isLoopNode((wf.nodes as DagNode[])[1])).toBe(true);
      if (isLoopNode((wf.nodes as DagNode[])[1])) {
        expect((wf.nodes as DagNode[])[1].depends_on).toEqual(['setup']);
      }
    });

    it('should accept interactive loop with gate_message', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'valid-interactive.yaml'),
        `
name: valid-interactive
description: Valid interactive loop
interactive: true
nodes:
  - id: my-loop
    loop:
      prompt: Do something.
      until: DONE
      max_iterations: 5
      interactive: true
      gate_message: Review and respond.
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
      const node0 = (result.workflows[0].workflow.nodes as DagNode[])[0];
      if (isLoopNode(node0)) {
        expect(node0.loop.interactive).toBe(true);
        expect(node0.loop.gate_message).toBe('Review and respond.');
      }
    });

    it('should reject interactive loop without gate_message', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'bad-interactive.yaml'),
        `
name: bad-interactive
description: Missing gate_message
interactive: true
nodes:
  - id: my-loop
    loop:
      prompt: Do something.
      until: DONE
      max_iterations: 5
      interactive: true
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain('gate_message');
    });

    it('should infer interactive: true (with a warning) when an interactive loop node is in an undeclared workflow (#2707 step 2 / #2736)', async () => {
      // Grace period (#2736/#2738): this used to be a hard load error. It now loads
      // successfully with `interactive` coerced to `true`, so #1991's background-dispatch
      // refusal still protects the run even though the author never declared the class.
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'warn-test.yaml'),
        `
name: warn-test
description: Non-interactive workflow with interactive loop
nodes:
  - id: my-loop
    loop:
      prompt: Iterate.
      until: DONE
      max_iterations: 5
      interactive: true
      gate_message: Review.
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
      expect(result.workflows[0].workflow.interactive).toBe(true);
      // Also carries the pre-existing "node-level loop interactive: is deprecated"
      // warning (#2707 step 3) for this same node — unrelated to this check, so
      // find the class-placement warning by content rather than asserting length.
      const pw = result.workflows[0].parseWarnings ?? [];
      const classWarning = pw.find(w => w.includes("Node 'my-loop' is a pause node"));
      expect(classWarning).toBeDefined();
      expect(classWarning).toContain('has been applied for this run only');
    });

    // -----------------------------------------------------------------------
    // loop.command — alternative to loop.prompt that loads the iteration
    // prompt from a command file (parallel to how `command:` nodes work).
    // The loader only enforces the schema-level "exactly one" rule and the
    // command-name safety rule; file resolution is validator-level (Level 3)
    // and is covered separately in validator.test.ts.
    // -----------------------------------------------------------------------

    it('should parse a loop node with loop.command (no inline prompt)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-cmd-only.yaml'),
        `
name: loop-cmd-only
description: Command-backed loop
nodes:
  - id: my-loop
    loop:
      command: my-loop-cmd
      until: COMPLETE
      max_iterations: 5
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);

      const node = (result.workflows[0].workflow.nodes as DagNode[])[0];
      expect(isLoopNode(node)).toBe(true);
      if (isLoopNode(node)) {
        expect(node.loop.command).toBe('my-loop-cmd');
        expect(node.loop.prompt).toBeUndefined();
      }
    });

    it('should reject a loop node with both loop.prompt and loop.command', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-both.yaml'),
        `
name: loop-both
description: Both prompt and command on loop
nodes:
  - id: my-loop
    loop:
      prompt: "Do stuff."
      command: my-loop-cmd
      until: DONE
      max_iterations: 5
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors.length).toBeGreaterThan(0);
      // Error must mention the "exactly one" rule and both candidate fields,
      // so authors immediately understand the conflict.
      expect(result.errors[0].error).toContain('exactly one');
      expect(result.errors[0].error).toContain('loop.prompt');
      expect(result.errors[0].error).toContain('loop.command');
    });

    it('should reject a loop node with neither loop.prompt nor loop.command (message mentions both options)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-neither.yaml'),
        `
name: loop-neither
description: Loop with no prompt source
nodes:
  - id: my-loop
    loop:
      until: DONE
      max_iterations: 5
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors.length).toBeGreaterThan(0);
      // Error must offer both alternatives, not just the legacy 'loop.prompt'
      // path, so authors discover loop.command exists.
      expect(result.errors[0].error).toContain('loop.prompt');
      expect(result.errors[0].error).toContain('loop.command');
    });

    it("should reject a loop node whose loop.command is an unsafe name ('../escape')", async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-unsafe-cmd.yaml'),
        `
name: loop-unsafe-cmd
description: Loop with unsafe command name
nodes:
  - id: my-loop
    loop:
      command: "../escape"
      until: DONE
      max_iterations: 5
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].error).toContain('invalid command name');
      expect(result.errors[0].error).toContain('../escape');
    });

    it('should not false-positive the $nodeId.output ref scan on a command-backed loop with a sibling that consumes its output', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      // Regression guard for the loader change that skips the ref scan when
      // loop.prompt is absent: the scanner must (a) not crash trying to read
      // the missing inline prompt, and (b) still register the loop's id so a
      // sibling can reference `$my-loop.output` like any other node output.
      await writeFile(
        join(workflowDir, 'loop-cmd-with-sibling.yaml'),
        `
name: loop-cmd-with-sibling
description: Command-backed loop with a downstream consumer
nodes:
  - id: my-loop
    loop:
      command: my-loop-cmd
      until: DONE
      max_iterations: 3
  - id: consumer
    depends_on: [my-loop]
    prompt: "Process the loop output: $my-loop.output"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
      expect(result.workflows[0].workflow.nodes).toHaveLength(2);
    });

    it('should trim surrounding whitespace from loop.command so resolution sees the normalized name', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      // Parsing NORMALIZES the command name (schema-level trim) rather than
      // rejecting it: a quoted YAML value like `" my-loop-cmd "` (or one with a
      // stray trailing newline from awkward block scalars) is stored trimmed,
      // so downstream `loadCommandPrompt` — which resolves the literal filename
      // — sees the same name the author meant instead of failing at runtime
      // with a confusing "not found".
      await writeFile(
        join(workflowDir, 'loop-cmd-whitespace.yaml'),
        `
name: loop-cmd-whitespace
description: Command-backed loop with stray whitespace around the name
nodes:
  - id: my-loop
    loop:
      command: "  my-loop-cmd  "
      until: DONE
      max_iterations: 3
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);

      const node = (result.workflows[0].workflow.nodes as DagNode[])[0];
      expect(isLoopNode(node)).toBe(true);
      if (isLoopNode(node)) {
        expect(node.loop.command).toBe('my-loop-cmd');
      }
    });

    it('should accept a loop with signal_completes (loads without errors)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'signal-completes.yaml'),
        `
name: signal-completes
description: Interactive loop that completes autonomously on the signal
interactive: true
nodes:
  - id: validate
    loop:
      prompt: Validate.
      until: VALIDATED
      max_iterations: 5
      interactive: true
      gate_message: Review.
      signal_completes: true
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
    });

    it('should warn (non-blocking) when signal_completes is set without interactive', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'sc-no-interactive.yaml'),
        `
name: sc-no-interactive
description: signal_completes without interactive is a no-op
nodes:
  - id: validate
    loop:
      prompt: Validate.
      until: VALIDATED
      max_iterations: 5
      signal_completes: true
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      // Workflow loads successfully — this is a warning, not an error
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ filename: expect.stringContaining('sc-no-interactive') }),
        'signal_completes_without_interactive_ignored'
      );
    });

    it('should reject loop_group with a cyclic body', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-group-cycle.yaml'),
        `
name: loop-group-cycle
description: Cyclic loop_group body
nodes:
  - id: grp
    loop_group:
      until: DONE
      max_iterations: 5
      nodes:
        - id: a
          prompt: "a"
          depends_on: [b]
        - id: b
          prompt: "b"
          depends_on: [a]
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].error).toContain('loop_group');
      expect(result.errors[0].error).toContain('Cycle');
    });

    it('should reject loop_group body depends_on referencing an unknown node', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-group-bad-dep.yaml'),
        `
name: loop-group-bad-dep
description: Body depends_on to unknown node
nodes:
  - id: grp
    loop_group:
      until: DONE
      max_iterations: 5
      nodes:
        - id: a
          prompt: "a"
        - id: b
          prompt: "b"
          depends_on: [missing]
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].error).toContain('loop_group');
      expect(result.errors[0].error).toContain('unknown node');
    });

    // --- gate placement inside a loop_group body (#2707 step 3) -------------------
    // Guidance only (parseWarnings), not a load error — a mid-body/co-terminal gate
    // predates this pattern (e.g. via the legacy `on_reject` mechanism) and must keep
    // loading; see the '#2707 step 1 gate/loop deprecation warnings' describe block
    // below for the equivalent warning-content assertions.

    it('should accept the canonical Design A gate-terminated loop_group, with no warning', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-group-gate-terminal.yaml'),
        `
name: loop-group-gate-terminal
description: A gate as the body's sole terminal sink, completion reading its decision
interactive: true
nodes:
  - id: grp
    loop_group:
      until_bash: '[ "$check.output.decision" = "approve" ]'
      max_iterations: 3
      nodes:
        - id: work
          prompt: "do work"
        - id: check
          depends_on: [work]
          approval:
            message: "Continue?"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
      expect(result.workflows[0].parseWarnings ?? []).toEqual([]);
    });

    it("warns when a gate-terminated loop_group's until_bash does not reference the gate", async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-group-gate-completion-not-referenced.yaml'),
        `
name: loop-group-gate-completion-not-referenced
description: A gate-terminated body whose completion channel ignores the gate
interactive: true
nodes:
  - id: grp
    loop_group:
      until_bash: "exit 0"
      max_iterations: 3
      nodes:
        - id: work
          prompt: "do work"
        - id: check
          depends_on: [work]
          approval:
            message: "Continue?"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      const pw = result.workflows[0].parseWarnings ?? [];
      expect(pw).toHaveLength(1);
      expect(pw[0]).toContain("Node 'check'");
      expect(pw[0]).toContain('does not reference');
      expect(pw[0]).toContain('$check.output');
    });

    it('does NOT warn about completion-not-referenced when the gate is not the terminal sink (avoids piling on)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-group-gate-mid-body-no-pileup.yaml'),
        `
name: loop-group-gate-mid-body-no-pileup
description: A non-terminal gate — only the placement warning should fire
interactive: true
nodes:
  - id: grp
    loop_group:
      until_bash: "exit 0"
      max_iterations: 3
      nodes:
        - id: check
          approval:
            message: "Continue?"
        - id: after
          depends_on: [check]
          prompt: "do more work"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const pw = result.workflows[0].parseWarnings ?? [];
      expect(pw).toHaveLength(1);
      expect(pw[0]).toContain('terminal sink');
      expect(pw.some(w => w.includes('does not reference'))).toBe(false);
    });

    it('checks EVERY gate in a body, not just the first (review fix)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      // 'first-gate' is not terminal (has a dependent, 'work'). 'second-gate' IS
      // the body's true terminal sink, but until_bash never references it. Before
      // the fix, `.find()` stopped at 'first-gate' and 'second-gate' was never
      // checked at all — its completion-not-referenced footgun went undetected.
      await writeFile(
        join(workflowDir, 'loop-group-multiple-gates.yaml'),
        `
name: loop-group-multiple-gates
description: Two gates in one body — each needs its own verdict
interactive: true
nodes:
  - id: grp
    loop_group:
      until_bash: "exit 0"
      max_iterations: 3
      nodes:
        - id: first-gate
          approval:
            message: "Start?"
        - id: work
          depends_on: [first-gate]
          prompt: "do work"
        - id: second-gate
          depends_on: [work]
          approval:
            message: "Continue?"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const pw = result.workflows[0].parseWarnings ?? [];
      expect(pw).toHaveLength(2);
      expect(pw.some(w => w.includes("Node 'first-gate'") && w.includes('terminal sink'))).toBe(
        true
      );
      expect(
        pw.some(w => w.includes("Node 'second-gate'") && w.includes('does not reference'))
      ).toBe(true);
    });

    it("counts an include: directive's own depends_on when computing terminal-sink status (review fix)", async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'block.yaml'),
        `
name: block
description: Reusable step
nodes:
  - id: step
    prompt: do the reusable thing
`
      );
      // 'check' has a dependent — the included 'review' node — so it is NOT the
      // body's terminal sink. Before the fix, an include directive's own
      // depends_on was excluded from the dependency set, so 'check' was silently
      // misclassified as terminal (no warning at all, and a factually wrong
      // "sole terminal sink" verdict).
      await writeFile(
        join(workflowDir, 'loop-group-gate-include-dependent.yaml'),
        `
name: loop-group-gate-include-dependent
description: A downstream include node depends on the gate
interactive: true
nodes:
  - id: grp
    loop_group:
      until_bash: "exit 0"
      max_iterations: 3
      nodes:
        - id: check
          approval:
            message: "Continue?"
        - id: review
          include: block
          depends_on: [check]
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      // 'block.yaml' is itself a discoverable workflow, so it's also in
      // result.workflows — select by name rather than assuming index 0.
      const target = result.workflows.find(
        w => w.workflow.name === 'loop-group-gate-include-dependent'
      );
      const pw = target?.parseWarnings ?? [];
      expect(pw.some(w => w.includes("Node 'check'") && w.includes('terminal sink'))).toBe(true);
    });

    it('counts an include: directive as a co-terminal sink (review fix)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'block.yaml'),
        `
name: block
description: Reusable step
nodes:
  - id: step
    prompt: do the reusable thing
`
      );
      // 'independent-include' has no dependents and nothing depends on it — a
      // second, genuine terminal sink alongside the gate. Before the fix, include
      // directives were excluded from the sink set entirely, so this second sink
      // was invisible and 'check' was wrongly treated as the sole terminal node.
      await writeFile(
        join(workflowDir, 'loop-group-gate-include-co-terminal.yaml'),
        `
name: loop-group-gate-include-co-terminal
description: An independent include node is a second terminal sink
interactive: true
nodes:
  - id: grp
    loop_group:
      until_bash: "exit 0"
      max_iterations: 3
      nodes:
        - id: check
          approval:
            message: "Continue?"
        - id: independent-include
          include: block
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      // 'block.yaml' is itself a discoverable workflow, so it's also in
      // result.workflows — select by name rather than assuming index 0.
      const target = result.workflows.find(
        w => w.workflow.name === 'loop-group-gate-include-co-terminal'
      );
      const pw = target?.parseWarnings ?? [];
      expect(pw.some(w => w.includes("Node 'check'") && w.includes('terminal sink'))).toBe(true);
    });

    it('should accept a well-formed loop_group', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-group-ok.yaml'),
        `
name: loop-group-ok
description: Valid loop_group
nodes:
  - id: grp
    loop_group:
      until: DONE
      max_iterations: 3
      nodes:
        - id: work
          prompt: "do work"
          depends_on: []
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
    });

    it('should load loop_group until_bash referencing a direct body output', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-group-body-completion-ref.yaml'),
        `
name: loop-group-body-completion-ref
description: Group completion reads the current body output
nodes:
  - id: group
    loop_group:
      until_bash: "test $ready-flag.output = ready"
      max_iterations: 2
      nodes:
        - id: ready-flag
          bash: "echo ready"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
    });

    it('should reject unknown loop_group until_bash refs with body-scope guidance', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-group-unknown-completion-ref.yaml'),
        `
name: loop-group-unknown-completion-ref
description: Group completion references a node outside its visible scopes
nodes:
  - id: group
    loop_group:
      until_bash: "test $ghost.output = ready"
      max_iterations: 2
      nodes:
        - id: ready-flag
          bash: "echo ready"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain("field 'loop_group.until_bash'");
      expect(result.errors[0].error).toContain("unknown node '$ghost.output'");
      expect(result.errors[0].error).toContain('loop_group body or current/enclosing DAG scope');
      expect(result.errors[0].error).not.toContain('In a composed workflow');
    });

    it('should accept a body prompt referencing an outer-DAG node via $nodeId.output', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-group-outer-ref.yaml'),
        `
name: loop-group-outer-ref
description: Body prompt reads an outer node output
nodes:
  - id: setup
    bash: "echo hi"
  - id: grp
    depends_on: [setup]
    loop_group:
      until: DONE
      max_iterations: 3
      nodes:
        - id: work
          prompt: "Use this context: $setup.output"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
    });

    it('should still reject a body prompt referencing a truly unknown node', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-group-unknown-ref.yaml'),
        `
name: loop-group-unknown-ref
description: Body prompt references a node that exists nowhere
nodes:
  - id: setup
    bash: "echo hi"
  - id: grp
    depends_on: [setup]
    loop_group:
      until: DONE
      max_iterations: 3
      nodes:
        - id: work
          prompt: "Use this context: $nowhere.output"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].error).toContain("unknown node '$nowhere.output'");
    });

    it('should reject a body node id that shadows an outer-DAG node id', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-group-shadow.yaml'),
        `
name: loop-group-shadow
description: Body node id collides with outer node id
nodes:
  - id: setup
    bash: "echo hi"
  - id: grp
    depends_on: [setup]
    loop_group:
      until: DONE
      max_iterations: 3
      nodes:
        - id: setup
          prompt: "shadows the outer setup node"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].error).toContain('shadows a node id in the enclosing DAG');
    });

    it('should infer interactive: true (with a warning) when an interactive loop_group is in an undeclared workflow (#2707 step 2 / #2736)', async () => {
      // Grace period (#2736/#2738) — see the loop: sibling test above.
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'loop-group-gate-warn.yaml'),
        `
name: loop-group-gate-warn
description: Interactive loop_group without workflow-level interactive
nodes:
  - id: grp
    loop_group:
      until: DONE
      max_iterations: 3
      interactive: true
      gate_message: "Review this iteration"
      nodes:
        - id: work
          prompt: "do work"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
      expect(result.workflows[0].workflow.interactive).toBe(true);
      // Also carries the pre-existing "node-level loop interactive: is deprecated"
      // warning (#2707 step 3) for this same node — find by content, not length.
      const pw = result.workflows[0].parseWarnings ?? [];
      const classWarning = pw.find(w => w.includes("Node 'grp' is a pause node"));
      expect(classWarning).toBeDefined();
    });
  });

  // A gate-authoring leaf block (a workflow whose only purpose is to be composed via
  // `include:`, but which directly authors its own native gate) is now covered by the
  // grace-period inference like any other workflow (#2736/#2738) — it loads with a
  // warning and `interactive: true` inferred, rather than failing outright, so a
  // composer of it succeeds too instead of seeing a cascaded failure. Exercised through
  // the REAL discovery pipeline (discoverWorkflows -> parseWorkflow per file ->
  // expandWorkflowIncludes), not expandWorkflowIncludes called directly on hand-built
  // WorkflowDefinition objects — that bypass never reaches parseWorkflow's class check.
  describe('workflow-class placement — leaf gate-authoring block composed via include: (#2707 step 2 / #2736)', () => {
    async function writeAndDiscover(files: Record<string, string>) {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      for (const [filename, content] of Object.entries(files)) {
        await writeFile(join(workflowDir, filename), content);
      }
      return discoverWorkflows(testDir, { loadDefaults: false });
    }

    it('a leaf block with a native gate and no interactive: true loads on its own with interactive inferred', async () => {
      const result = await writeAndDiscover({
        'gate-blk.yaml': `
name: gate-blk
description: reusable review gate, composed by other workflows
nodes:
  - id: gate
    approval:
      message: "Review?"
`,
      });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
      expect(result.workflows[0].workflow.interactive).toBe(true);
    });

    it('a composer of that leaf block also succeeds — the inference propagates through include: composition', async () => {
      const result = await writeAndDiscover({
        'gate-blk.yaml': `
name: gate-blk
description: reusable review gate, composed by other workflows
nodes:
  - id: gate
    approval:
      message: "Review?"
`,
        'top.yaml': `
name: top
description: composes the review gate
interactive: true
nodes:
  - id: inc
    include: gate-blk
`,
      });
      expect(result.errors).toHaveLength(0);
      const names = result.workflows.map(w => w.workflow.name).sort();
      expect(names).toEqual(['gate-blk', 'top']);
    });

    it('once the leaf block also declares interactive: true, both it and its composer load correctly with no warning', async () => {
      const result = await writeAndDiscover({
        'gate-blk.yaml': `
name: gate-blk
description: reusable review gate, composed by other workflows
interactive: true
nodes:
  - id: gate
    approval:
      message: "Review?"
`,
        'top.yaml': `
name: top
description: composes the review gate
interactive: true
nodes:
  - id: inc
    include: gate-blk
`,
      });
      expect(result.errors).toHaveLength(0);
      const names = result.workflows.map(w => w.workflow.name).sort();
      expect(names).toEqual(['gate-blk', 'top']);
      for (const w of result.workflows) {
        expect(w.parseWarnings ?? []).toEqual([]);
      }
    });
  });

  describe('workflow-class placement inference — log dedup (#2736/#2738)', () => {
    beforeEach(() => {
      resetClassPlacementWarningForTests();
      mockLogger.warn.mockClear();
    });

    const undeclaredGateYaml = `
name: warn-once-test
description: Non-interactive workflow with a native gate
nodes:
  - id: gate
    approval:
      message: "Review?"
`;

    it('warns on the log channel exactly once per filename across repeated parses, but coerces every time', () => {
      const first = parseWorkflow(undeclaredGateYaml, 'warn-once-test.yaml');
      const second = parseWorkflow(undeclaredGateYaml, 'warn-once-test.yaml');
      const third = parseWorkflow(undeclaredGateYaml, 'warn-once-test.yaml');

      for (const result of [first, second, third]) {
        expect(result.error).toBeNull();
        expect(result.workflow?.interactive).toBe(true);
        expect(result.warnings).toHaveLength(1);
      }

      const warnCalls = mockLogger.warn.mock.calls.filter(
        call => call[1] === 'workflow_class_placement_inferred'
      );
      expect(warnCalls).toHaveLength(1);
    });

    it('warns again for a different filename with the same violation', () => {
      parseWorkflow(undeclaredGateYaml, 'warn-once-test.yaml');
      parseWorkflow(
        undeclaredGateYaml.replace('warn-once-test', 'a-different-workflow'),
        'other.yaml'
      );

      const warnCalls = mockLogger.warn.mock.calls.filter(
        call => call[1] === 'workflow_class_placement_inferred'
      );
      expect(warnCalls).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Include nodes (load-time inlining)
  // -------------------------------------------------------------------------
  describe('workflow (sub-run) nodes', () => {
    async function loadOne(name: string, yaml: string) {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      await writeFile(join(workflowDir, `${name}.yaml`), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      return result;
    }

    it('loads a workflow with a valid workflow: node (input + depends_on)', async () => {
      const result = await loadOne(
        'compose',
        `
name: compose
description: Composes a sub-run
nodes:
  - id: plan
    prompt: "plan"
  - id: sub
    workflow: child-wf
    input: "$plan.output"
    depends_on: [plan]
  - id: after
    prompt: "after"
    depends_on: [sub]
`
      );
      const errs = result.errors.filter(e => e.filename === 'compose.yaml');
      expect(errs).toHaveLength(0);
      const wf = result.workflows.find(w => w.workflow.name === 'compose');
      expect(wf).toBeDefined();
      const sub = wf!.workflow.nodes.find(n => n.id === 'sub');
      expect(sub && 'workflow' in sub ? sub.workflow : undefined).toBe('child-wf');
      expect(sub && 'input' in sub ? sub.input : undefined).toBe('$plan.output');
      // A workflow: node is NOT expanded at load time (unlike include:).
      expect(wf!.workflow.nodes.some(n => n.id === 'sub')).toBe(true);
    });

    it('catches a workflow.input $output ref to an unknown node', async () => {
      const result = await loadOne(
        'bad-ref',
        `
name: bad-ref
description: input references a node that does not exist
nodes:
  - id: sub
    workflow: child-wf
    input: "$ghost.output"
`
      );
      const err = result.errors.find(e => e.filename === 'bad-ref.yaml');
      expect(err).toBeDefined();
      expect(err?.error).toContain("references unknown node '$ghost.output'");
    });

    it.each([
      ['systemPrompt', '    systemPrompt: "context $ghost.output"'],
      [
        'agents.*.prompt',
        '    agents:\n      helper:\n        description: d\n        prompt: "use $ghost.output"',
      ],
      [
        'agents.*.description',
        '    agents:\n      helper:\n        description: "reads $ghost.output"\n        prompt: p',
      ],
    ])('catches a dangling $node.output ref in %s', async (field, snippet) => {
      // These three are runtime substitution surfaces since #1764, so a dangling ref has
      // to fail at load like every other one — before it reaches the provider as text.
      const name = `bad-${field.replace(/[^a-z]/gi, '')}`;
      const result = await loadOne(
        name,
        `name: ${name}\ndescription: dangling ref in ${field}\nnodes:\n  - id: use\n    prompt: go\n${snippet}\n`
      );
      const err = result.errors.find(e => e.filename === `${name}.yaml`);
      expect(err?.error).toContain("references unknown node '$ghost.output'");
    });

    it("accepts 'with:' on a workflow node (#2470)", async () => {
      const result = await loadOne(
        'with-accept',
        `
name: with-accept
description: with on a workflow node
nodes:
  - id: sub
    workflow: child-wf
    with:
      foo: bar
`
      );
      const err = result.errors.find(e => e.filename === 'with-accept.yaml');
      expect(err).toBeUndefined();
      const wf = result.workflows.find(w => w.workflow.name === 'with-accept');
      const node = wf?.workflow.nodes.find(n => n.id === 'sub');
      expect(nodeWith(node)).toEqual({ foo: 'bar' });
    });

    it("rejects 'with:' and 'input:' together on a workflow node (#2470)", async () => {
      const result = await loadOne(
        'with-input-reject',
        `
name: with-input-reject
description: with and input on a workflow node
nodes:
  - id: sub
    workflow: child-wf
    input: hello
    with:
      foo: bar
`
      );
      const err = result.errors.find(e => e.filename === 'with-input-reject.yaml');
      expect(err).toBeDefined();
      expect(err?.error).toContain("'with:' and 'input:'");
    });

    it("rejects 'retry:' on a workflow node", async () => {
      const result = await loadOne(
        'retry-reject',
        `
name: retry-reject
description: retry on a workflow node
nodes:
  - id: sub
    workflow: child-wf
    retry:
      max_attempts: 2
`
      );
      const err = result.errors.find(e => e.filename === 'retry-reject.yaml');
      expect(err).toBeDefined();
      expect(err?.error).toContain("'retry' is not supported on workflow nodes");
    });

    it("accepts isolation: 'worktree' on a workflow node (slice 2, PR-A)", async () => {
      const result = await loadOne(
        'iso-worktree',
        `
name: iso-worktree
description: per-child worktree isolation on a workflow node
nodes:
  - id: sub
    workflow: child-wf
    isolation: worktree
`
      );
      const errs = result.errors.filter(e => e.filename === 'iso-worktree.yaml');
      expect(errs).toHaveLength(0);
    });

    it("accepts isolation: 'inherit' on a workflow node", async () => {
      const result = await loadOne(
        'iso-ok',
        `
name: iso-ok
description: isolation inherit is fine
nodes:
  - id: sub
    workflow: child-wf
    isolation: inherit
`
      );
      const errs = result.errors.filter(e => e.filename === 'iso-ok.yaml');
      expect(errs).toHaveLength(0);
    });

    it("rejects 'isolation:' on a non-workflow node (S1)", async () => {
      const result = await loadOne(
        'iso-wrong-node',
        `
name: iso-wrong-node
description: isolation on a prompt node is meaningless
nodes:
  - id: think
    prompt: "do a thing"
    isolation: worktree
`
      );
      const err = result.errors.find(e => e.filename === 'iso-wrong-node.yaml');
      expect(err).toBeDefined();
      expect(err?.error).toContain('only supported on workflow');
    });

    it('rejects a workflow node inside a loop_group body', async () => {
      const result = await loadOne(
        'wf-in-loop-group',
        `
name: wf-in-loop-group
description: workflow node nested in a loop_group body (rejected in slice 1)
nodes:
  - id: grp
    loop_group:
      until: DONE
      max_iterations: 3
      nodes:
        - id: bad
          workflow: child-wf
`
      );
      const err = result.errors.find(e => e.filename === 'wf-in-loop-group.yaml');
      expect(err).toBeDefined();
      expect(err?.error).toContain('loop_group');
      expect(err?.error).toContain("'workflow' (sub-run) is not supported");
    });

    it('rejects a node that sets both workflow and prompt (mutual exclusion)', async () => {
      const result = await loadOne(
        'both',
        `
name: both
description: workflow and prompt together
nodes:
  - id: sub
    workflow: child-wf
    prompt: "also a prompt"
`
      );
      const err = result.errors.find(e => e.filename === 'both.yaml');
      expect(err).toBeDefined();
      expect(err?.error).toMatch(/mutually exclusive/i);
    });

    // --- slice 2, PR-C: dynamic fan-out ------------------------------------------

    it('accepts a valid fan_out node and defaults max_parallel=5, join=all_done', async () => {
      const result = await loadOne(
        'fan-ok',
        `
name: fan-ok
description: fan out over a produced item list
nodes:
  - id: plan
    prompt: "emit tasks"
  - id: work
    workflow: child-wf
    isolation: worktree
    depends_on: [plan]
    fan_out:
      items: "$plan.output.tasks"
`
      );
      const errs = result.errors.filter(e => e.filename === 'fan-ok.yaml');
      expect(errs).toHaveLength(0);
      const wf = result.workflows.find(w => w.workflow.name === 'fan-ok');
      const work = wf!.workflow.nodes.find(n => n.id === 'work');
      const fanOut = work && 'fan_out' in work ? work.fan_out : undefined;
      expect(fanOut?.items).toBe('$plan.output.tasks');
      // Defaults applied by the schema.
      expect(fanOut?.max_parallel).toBe(5);
      // Independent children by default: a failed child must not discard its siblings'
      // output at the join. all_success is the opt-in for the genuinely dependent case.
      expect(fanOut?.join).toBe('all_done');
      // The explicit isolation the author wrote survives the transform.
      expect(work && 'isolation' in work ? work.isolation : undefined).toBe('worktree');
    });

    it('does NOT infer isolation from fan_out — an omitted isolation stays omitted', async () => {
      const result = await loadOne(
        'fan-no-iso',
        `
name: fan-no-iso
description: fan out with no isolation declared
nodes:
  - id: plan
    prompt: "emit tasks"
  - id: work
    workflow: child-wf
    depends_on: [plan]
    fan_out:
      items: "$plan.output.tasks"
`
      );
      expect(result.errors.filter(e => e.filename === 'fan-no-iso.yaml')).toHaveLength(0);
      const wf = result.workflows.find(w => w.workflow.name === 'fan-no-iso');
      const work = wf!.workflow.nodes.find(n => n.id === 'work');
      // A child gets a worktree ONLY when the author writes `isolation: worktree`.
      // Fanning out is not a write operation, so it never implies one.
      expect(work && 'isolation' in work ? work.isolation : undefined).toBeUndefined();
    });

    it('catches a fan_out.items ref to an unknown node (dangling ref)', async () => {
      const result = await loadOne(
        'fan-dangling',
        `
name: fan-dangling
description: fan_out.items references a node that does not exist
nodes:
  - id: work
    workflow: child-wf
    fan_out:
      items: "$ghost.output.tasks"
`
      );
      const err = result.errors.find(e => e.filename === 'fan-dangling.yaml');
      expect(err).toBeDefined();
      expect(err?.error).toContain("references unknown node '$ghost.output'");
    });

    it('rejects fan_out.items referencing a non-dependency producer', async () => {
      const result = await loadOne(
        'fan-not-dep',
        `
name: fan-not-dep
description: items producer is real but not an upstream dependency (would race)
nodes:
  - id: plan
    prompt: "emit tasks"
  - id: work
    workflow: child-wf
    fan_out:
      items: "$plan.output.tasks"
`
      );
      const err = result.errors.find(e => e.filename === 'fan-not-dep.yaml');
      expect(err).toBeDefined();
      expect(err?.error).toContain('not an upstream dependency');
      expect(err?.error).toContain('depends_on');
    });

    it("rejects 'fan_out' on a non-workflow node", async () => {
      const result = await loadOne(
        'fan-wrong-node',
        `
name: fan-wrong-node
description: fan_out on a prompt node is meaningless
nodes:
  - id: think
    prompt: "do a thing"
    fan_out:
      items: "$think.output"
`
      );
      const err = result.errors.find(e => e.filename === 'fan-wrong-node.yaml');
      expect(err).toBeDefined();
      expect(err?.error).toContain("'fan_out' is only supported on workflow");
    });

    it("rejects 'fan_out.join: first_success' as REJECTED, not deferred", async () => {
      const result = await loadOne(
        'fan-race',
        `
name: fan-race
description: first_success join is not supported yet
nodes:
  - id: plan
    prompt: "emit tasks"
  - id: work
    workflow: child-wf
    depends_on: [plan]
    fan_out:
      items: "$plan.output.tasks"
      join: first_success
`
      );
      const err = result.errors.find(e => e.filename === 'fan-race.yaml');
      expect(err).toBeDefined();
      expect(err?.error).toContain('first_success');
      // The message must not promise a future that no longer exists — racing is rejected
      // outright, so "not yet supported" / a PR to wait for would be acted on wrongly.
      expect(err?.error).toContain('rejected, not deferred');
      expect(err?.error).not.toContain('not yet supported');
      expect(err?.error).not.toContain('PR-D');
      // …and it names the shape that actually serves the want.
      expect(err?.error).toContain('collector');
    });

    it("accepts 'fan_out.as' now that the $INPUTS channel exists (#2470)", async () => {
      const result = await loadOne(
        'fan-as',
        `
name: fan-as
description: as names the per-item $INPUTS channel
nodes:
  - id: plan
    prompt: "emit tasks"
  - id: work
    workflow: child-wf
    depends_on: [plan]
    fan_out:
      items: "$plan.output.tasks"
      as: task
`
      );
      const err = result.errors.find(e => e.filename === 'fan-as.yaml');
      expect(err).toBeUndefined();
      const wf = result.workflows.find(w => w.workflow.name === 'fan-as');
      const node = wf?.workflow.nodes.find(n => n.id === 'work');
      expect(node && 'fan_out' in node ? node.fan_out?.as : undefined).toBe('task');
    });

    it("rejects 'fan_out.as' colliding with a 'with:' key (#2470)", async () => {
      const result = await loadOne(
        'fan-as-collide',
        `
name: fan-as-collide
description: as collides with a with key
nodes:
  - id: plan
    prompt: "emit tasks"
  - id: work
    workflow: child-wf
    depends_on: [plan]
    with:
      task: static
    fan_out:
      items: "$plan.output.tasks"
      as: task
`
      );
      const err = result.errors.find(e => e.filename === 'fan-as-collide.yaml');
      expect(err).toBeDefined();
      expect(err?.error).toContain('fan_out.as');
      expect(err?.error).toContain('collides');
    });

    it("rejects 'max_parallel: 0' (must be >= 1)", async () => {
      const result = await loadOne(
        'fan-zero',
        `
name: fan-zero
description: max_parallel must be at least 1
nodes:
  - id: plan
    prompt: "emit tasks"
  - id: work
    workflow: child-wf
    depends_on: [plan]
    fan_out:
      items: "$plan.output.tasks"
      max_parallel: 0
`
      );
      const err = result.errors.find(e => e.filename === 'fan-zero.yaml');
      expect(err).toBeDefined();
      expect(err?.error).toMatch(/max_parallel/);
    });

    it('rejects a fan_out workflow node inside a loop_group body', async () => {
      const result = await loadOne(
        'fan-in-loop-group',
        `
name: fan-in-loop-group
description: fan-out sub-run nested in a loop_group body (rejected — it is a workflow node)
nodes:
  - id: grp
    loop_group:
      until: DONE
      max_iterations: 3
      nodes:
        - id: bad
          workflow: child-wf
          fan_out:
            items: "$grp.output"
`
      );
      const err = result.errors.find(e => e.filename === 'fan-in-loop-group.yaml');
      expect(err).toBeDefined();
      expect(err?.error).toContain('loop_group');
      expect(err?.error).toContain("'workflow' (sub-run) is not supported");
    });
  });

  describe('include nodes', () => {
    it('should load and expand a workflow with an include node', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'block.yaml'),
        `
name: block
description: Reusable building block
nodes:
  - id: first
    prompt: "first"
  - id: second
    prompt: "second"
    depends_on: [first]
`
      );
      await writeFile(
        join(workflowDir, 'parent.yaml'),
        `
name: parent
description: Includes the block
nodes:
  - id: setup
    bash: "echo setup"
  - id: sub
    include: block
    depends_on: [setup]
  - id: finish
    prompt: "finish"
    depends_on: [sub]
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const parentErrors = result.errors.filter(e => e.filename === 'parent.yaml');
      expect(parentErrors).toHaveLength(0);

      const parent = result.workflows.find(w => w.workflow.name === 'parent');
      expect(parent).toBeDefined();
      const ids = parent!.workflow.nodes.map(n => n.id);
      // include node is gone; block nodes are namespaced under the include id.
      expect(ids).toContain('sub__first');
      expect(ids).toContain('sub__second');
      expect(ids).not.toContain('sub');
      expect(parent!.workflow.nodes.some(n => 'include' in n)).toBe(false);

      // Entry node (block's `first`) inherits the include node's upstream dep.
      const entry = parent!.workflow.nodes.find(n => n.id === 'sub__first');
      expect(entry?.depends_on).toEqual(['setup']);
      // Downstream node's depends_on: [sub] rewired to the block's sink.
      const finish = parent!.workflow.nodes.find(n => n.id === 'finish');
      expect(finish?.depends_on).toEqual(['sub__second']);
    });

    it('should expand an include node inside a loop_group body', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'block.yaml'),
        `
name: block
description: Reusable review block
returns: decide
nodes:
  - id: decide
    prompt: Decide whether the work is done
    output_format:
      type: object
      properties:
        done:
          type: boolean
      required: [done]
  - id: cleanup
    bash: echo cleanup
    depends_on: [decide]
`
      );
      await writeFile(
        join(workflowDir, 'include-in-loop-group.yaml'),
        `
name: include-in-loop-group
description: Include nested in a loop_group body
nodes:
  - id: grp
    loop_group:
      until_bash: test "$review.output.done" = true
      max_iterations: 3
      nodes:
        - id: setup
          bash: echo setup
        - id: review
          include: block
          depends_on: [setup]
        - id: summarize
          prompt: result=$review.output.done
          depends_on: [review]
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors.filter(e => e.filename === 'include-in-loop-group.yaml')).toHaveLength(
        0
      );
      const workflow = result.workflows.find(
        entry => entry.workflow.name === 'include-in-loop-group'
      )?.workflow;
      expect(workflow).toBeDefined();
      const group = (workflow?.nodes as DagNode[] | undefined)?.find(node => node.id === 'grp');
      expect(group && isLoopGroupNode(group)).toBe(true);
      if (!group || !isLoopGroupNode(group)) throw new Error('expected loop_group');
      expect(group.loop_group.nodes.map(node => node.id)).toEqual([
        'setup',
        'review__decide',
        'review__cleanup',
        'summarize',
      ]);
      expect(group.loop_group.nodes.some(node => 'include' in node)).toBe(false);
      expect(group.loop_group.until_bash).toBe('test "$review__decide.output.done" = true');
      expect(group.loop_group.nodes.find(node => node.id === 'summarize')).toMatchObject({
        source: { kind: 'inline', prompt: 'result=$review__decide.output.done' },
        depends_on: ['review__cleanup'],
      });
    });

    it('should error two files that declare the same workflow name', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'first.yaml'),
        `
name: dup-name
description: First file with this name
nodes:
  - id: a
    prompt: "a"
`
      );
      await writeFile(
        join(workflowDir, 'second.yaml'),
        `
name: dup-name
description: Second file with the same name
nodes:
  - id: b
    prompt: "b"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      // Overrides are by filename, not name — same-name files are ambiguous, so both are
      // dropped and errored rather than silently last-wins (which would make include
      // resolution order-dependent).
      expect(result.workflows.some(w => w.workflow.name === 'dup-name')).toBe(false);
      const dupErrors = result.errors.filter(e =>
        e.error.includes("Duplicate workflow name 'dup-name'")
      );
      expect(dupErrors.length).toBe(2);
      expect(dupErrors.map(e => e.filename).sort()).toEqual(['first.yaml', 'second.yaml']);
    });

    it('should drop a workflow whose include target is missing but keep others', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'broken-include.yaml'),
        `
name: broken-include
description: Includes a target that does not exist
nodes:
  - id: sub
    include: does-not-exist
`
      );
      await writeFile(
        join(workflowDir, 'healthy.yaml'),
        `
name: healthy
description: No includes here
nodes:
  - id: only
    prompt: "hi"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      // Broken workflow is dropped with an error; the healthy one still loads.
      expect(result.workflows.some(w => w.workflow.name === 'broken-include')).toBe(false);
      expect(result.workflows.some(w => w.workflow.name === 'healthy')).toBe(true);
      // Expansion errors are re-keyed to the includer's real filename (not the workflow name).
      const err = result.errors.find(e => e.filename === 'broken-include.yaml');
      expect(err).toBeDefined();
      expect(err?.error).toContain('not found');
    });

    it("rejects 'mutates_checkout' on an include node, naming workflow level and workflow:", async () => {
      // The one launch-only option the schema cannot see — it is workflow-level, so Zod
      // strips it before superRefine runs (#1764 Task 8).
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      await writeFile(
        join(workflowDir, 'mc-block.yaml'),
        `name: mc-block\ndescription: b\nnodes:\n  - id: work\n    prompt: work\n`
      );
      await writeFile(
        join(workflowDir, 'mc-parent.yaml'),
        `name: mc-parent\ndescription: p\nnodes:\n  - id: sub\n    include: mc-block\n    mutates_checkout: false\n`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const err = result.errors.find(e => e.filename === 'mc-parent.yaml');
      expect(err?.error).toContain("'mutates_checkout' is not supported on an include node");
      expect(err?.error).toContain("'workflow:' node");
      expect(result.workflows.some(w => w.workflow.name === 'mc-parent')).toBe(false);
    });

    it('warns only about the RUN-owned fields a composed workflow cannot carry', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'gated-block.yaml'),
        `
name: gated-block
description: A block whose node config travels but whose run config cannot
provider: claude
requires: [github]
interactive: true
worktree:
  enabled: true
nodes:
  - id: work
    prompt: "do the work"
`
      );
      await writeFile(
        join(workflowDir, 'parent.yaml'),
        `
name: parent
description: Includes the gated block
nodes:
  - id: sub
    include: gated-block
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const parentErrors = result.errors.filter(e => e.filename === 'parent.yaml');
      expect(parentErrors).toHaveLength(0);

      // mockLogger is shared/accumulating across tests, so filter by this test's include id.
      const call = (mockLogger.warn as Mock<(...args: unknown[]) => unknown>).mock.calls.find(
        c =>
          c[1] === 'include.workflow_level_fields_dropped' &&
          (c[0] as { include?: string }).include === 'sub'
      );
      expect(call).toBeDefined();
      const payload = call![0] as {
        include: string;
        droppedFields: string[];
        requiresNote?: string;
        safetyNote?: string;
      };
      expect(payload.include).toBe('sub');
      // Run-owned: whoever starts the run decides these, so the composed file's
      // values cannot apply and the author gets told.
      expect(payload.droppedFields).toContain('interactive');
      expect(payload.droppedFields).toContain('worktree');
      // Node-affecting: `provider` travelled onto the block's own nodes (#1764), so
      // reporting it as dropped would now be a lie.
      expect(payload.droppedFields).not.toContain('provider');
      // `requires:` is unioned into the composing workflow's gate, not dropped.
      expect(payload.droppedFields).not.toContain('requires');
      expect(payload.requiresNote).toBeUndefined();
      // The always-present-but-undefined keys parseWorkflow emits are filtered out, so a
      // generic key derivation must NOT report them as dropped.
      expect(payload.droppedFields).not.toContain('model');
      expect(payload.safetyNote).toBeUndefined();
    });

    it("unions a composed block's requires: into the composing workflow", async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      await writeFile(
        join(workflowDir, 'gh-block.yaml'),
        `name: gh-block\ndescription: needs github\nrequires: [github]\nnodes:\n  - id: work\n    prompt: work\n`
      );
      await writeFile(
        join(workflowDir, 'gh-parent.yaml'),
        `name: gh-parent\ndescription: composes it\nnodes:\n  - id: sub\n    include: gh-block\n`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const parent = result.workflows.find(w => w.workflow.name === 'gh-parent');
      // The capability gate reads this, so a user without GitHub connected is refused at
      // invocation instead of failing mid-run inside a block the parent cannot inspect.
      expect(parent?.workflow.requires).toEqual(['github']);
    });

    it('should warn — with a safety callout — when a block drops mutates_checkout', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'safety-block.yaml'),
        `
name: safety-block
description: A block declaring concurrency-safety and a field that cannot travel
mutates_checkout: false
webSearchMode: live
sandbox:
  enabled: true
nodes:
  - id: work
    prompt: "do the work"
`
      );
      await writeFile(
        join(workflowDir, 'safety-parent.yaml'),
        `
name: safety-parent
description: Includes the safety block
nodes:
  - id: safety-sub
    include: safety-block
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors.filter(e => e.filename === 'safety-parent.yaml')).toHaveLength(0);

      const call = (mockLogger.warn as Mock<(...args: unknown[]) => unknown>).mock.calls.find(
        c =>
          c[1] === 'include.workflow_level_fields_dropped' &&
          (c[0] as { include?: string }).include === 'safety-sub'
      );
      expect(call).toBeDefined();
      const payload = call![0] as {
        droppedFields: string[];
        safetyNote?: string;
        webSearchModeNote?: string;
      };
      expect(payload.droppedFields).toContain('mutates_checkout');
      expect(payload.safetyNote).toContain('mutates_checkout');
      // `sandbox:` is node-affecting and now travels onto the block's own nodes.
      expect(payload.droppedFields).not.toContain('sandbox');
      const work = result.workflows
        .find(w => w.workflow.name === 'safety-parent')
        ?.workflow.nodes.find(n => n.id === 'safety-sub__work') as
        | Record<string, unknown>
        | undefined;
      expect(work?.sandbox).toEqual({ enabled: true });
      // `webSearchMode:` is the one node-affecting field with no per-node landing spot,
      // so it genuinely cannot travel — named explicitly rather than left to read as a
      // run-level decision it is not.
      expect(payload.droppedFields).toContain('webSearchMode');
      expect(payload.webSearchModeNote).toContain('no per-node form');
    });

    it('should compile a block command file and namespace a local sibling ref', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      const commandsDir = join(testDir, '.archon', 'commands');
      await mkdir(workflowDir, { recursive: true });
      await mkdir(commandsDir, { recursive: true });

      await writeFile(join(commandsDir, 'blk-runner.md'), 'Summarize $sib.output for the report.');
      await writeFile(
        join(workflowDir, 'cmd-block.yaml'),
        `
name: cmd-block
description: Block whose command references a sibling
nodes:
  - id: sib
    bash: "echo hi"
  - id: runner
    command: blk-runner
    depends_on: [sib]
`
      );
      await writeFile(
        join(workflowDir, 'cmd-parent.yaml'),
        `
name: cmd-parent
description: Includes the command block
nodes:
  - id: rev
    include: cmd-block
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors.filter(error => error.filename === 'cmd-parent.yaml')).toHaveLength(0);
      const parent = result.workflows.find(w => w.workflow.name === 'cmd-parent')?.workflow;
      const runner = parent?.nodes.find(node => node.id === 'rev__runner');
      expect(inlinePrompt(runner) ?? '').toBe('Summarize $rev__sib.output for the report.');
    });

    it('should compile a resolved block command file with a declared include input', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      const commandsDir = join(testDir, '.archon', 'commands');
      await mkdir(workflowDir, { recursive: true });
      await mkdir(commandsDir, { recursive: true });

      await writeFile(join(commandsDir, 'parameterized-runner.md'), 'Review $INPUTS.scope.');
      await writeFile(
        join(workflowDir, 'parameterized-block.yaml'),
        `
name: parameterized-block
description: Block whose command references an include input
inputs:
  scope: { required: true }
nodes:
  - id: runner
    command: parameterized-runner
`
      );
      await writeFile(
        join(workflowDir, 'parameterized-parent.yaml'),
        `
name: parameterized-parent
description: Includes the parameterized command block
nodes:
  - id: review
    include: parameterized-block
    with:
      scope: main
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(
        result.errors.filter(error => error.filename === 'parameterized-parent.yaml')
      ).toHaveLength(0);
      const parent = result.workflows.find(
        workflow => workflow.workflow.name === 'parameterized-parent'
      )?.workflow;
      const runner = parent?.nodes.find(node => node.id === 'review__runner');
      expect(inlinePrompt(runner) ?? '').toBe('Review main.');
    });

    it('should compile block commands from a configured custom command folder', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      const customCmds = join(testDir, 'my-cmds');
      await mkdir(workflowDir, { recursive: true });
      await mkdir(customCmds, { recursive: true });

      await writeFile(
        join(customCmds, 'custom-runner.md'),
        'Summarize $sib.output for the report.'
      );
      await writeFile(
        join(workflowDir, 'cc-block.yaml'),
        `
name: cc-block
description: block whose command lives in a custom folder
nodes:
  - id: sib
    bash: "echo hi"
  - id: runner
    command: custom-runner
    depends_on: [sib]
`
      );
      await writeFile(
        join(workflowDir, 'cc-parent.yaml'),
        `
name: cc-parent
description: includes cc-block
nodes:
  - id: rev
    include: cc-block
`
      );

      const result = await discoverWorkflowsWithConfig(testDir, () =>
        Promise.resolve({
          defaults: { loadDefaultWorkflows: false },
          commands: { folder: 'my-cmds' },
        })
      );
      expect(result.errors.filter(error => error.filename === 'cc-parent.yaml')).toHaveLength(0);
      const parent = result.workflows.find(
        workflow => workflow.workflow.name === 'cc-parent'
      )?.workflow;
      const runner = parent?.nodes.find(node => node.id === 'rev__runner');
      expect(inlinePrompt(runner) ?? '').toBe('Summarize $rev__sib.output for the report.');
    });

    it('should fail closed when a block command file cannot be resolved', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'ghost-block.yaml'),
        `
name: ghost-block
description: Block whose command file does not exist on disk
nodes:
  - id: runner
    command: ghost-cmd-does-not-exist-xyz
`
      );
      await writeFile(
        join(workflowDir, 'ghost-parent.yaml'),
        `
name: ghost-parent
description: Includes the ghost block
nodes:
  - id: g
    include: ghost-block
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const parentErrors = result.errors.filter(e => e.filename === 'ghost-parent.yaml');
      expect(parentErrors).toHaveLength(1);
      expect(result.workflows.some(w => w.workflow.name === 'ghost-parent')).toBe(false);
      expect(parentErrors[0].error).toContain("command 'ghost-cmd-does-not-exist-xyz'");
      expect(parentErrors[0].error).toContain('could not be resolved during composition');
    });

    it('should compile an included loop.command file with declared inputs', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      const commandDir = join(testDir, '.archon', 'commands');
      await mkdir(workflowDir, { recursive: true });
      await mkdir(commandDir, { recursive: true });
      await writeFile(join(commandDir, 'loop-review.md'), 'Review $INPUTS.scope.');
      await writeFile(
        join(workflowDir, 'loop-block.yaml'),
        `
name: loop-block
description: Block with a deferred loop prompt
inputs:
  scope: { required: true }
nodes:
  - id: repeat
    loop:
      command: loop-review
      until: DONE
      max_iterations: 1
`
      );
      await writeFile(
        join(workflowDir, 'loop-parent.yaml'),
        `
name: loop-parent
description: Includes the loop block
nodes:
  - id: review
    include: loop-block
    with:
      scope: production
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors.filter(error => error.filename === 'loop-parent.yaml')).toHaveLength(0);
      const parent = result.workflows.find(
        workflow => workflow.workflow.name === 'loop-parent'
      )?.workflow;
      const repeat = parent?.nodes.find(node => node.id === 'review__repeat');
      const compiled =
        repeat && 'loop' in repeat
          ? (repeat.loop as typeof repeat.loop & LoopWithCompiledCommand)[COMPILED_LOOP_COMMAND]
          : undefined;
      expect(compiled?.prompt).toBe('Review production.');
      expect(repeat && 'loop' in repeat && repeat.loop ? repeat.loop.command : undefined).toBe(
        'loop-review'
      );
    });
  });

  // -------------------------------------------------------------------------
  // Cancel nodes
  // -------------------------------------------------------------------------
  describe('cancel nodes', () => {
    it('should parse a valid cancel node', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'cancel-test.yaml'),
        `
name: cancel-test
description: Cancel node test
nodes:
  - id: check
    bash: "echo ok"
  - id: stop
    depends_on: [check]
    cancel: "Precondition failed"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      const wf = result.workflows[0].workflow;
      const nodes = wf.nodes as DagNode[];
      expect(nodes).toHaveLength(2);
      const node1 = nodes[1];
      expect(isHaltNode(node1)).toBe(true);
      if (isHaltNode(node1)) {
        expect(node1.reason).toBe('Precondition failed');
      }
    });

    it('should reject cancel node with empty reason', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'cancel-empty.yaml'),
        `
name: cancel-empty
description: Empty cancel
nodes:
  - id: stop
    cancel: ""
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject node with both cancel and prompt', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'cancel-prompt.yaml'),
        `
name: cancel-prompt-conflict
description: Cancel + prompt conflict
nodes:
  - id: bad
    cancel: "reason"
    prompt: "Do something"
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].error).toContain('mutually exclusive');
    });

    it('should warn about AI-specific fields on cancel nodes', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'cancel-ai-fields.yaml'),
        `
name: cancel-ai-fields
description: Cancel with AI fields
nodes:
  - id: stop
    cancel: "reason"
    model: opus
    provider: claude
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      // AI fields should produce a warning log
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('discoverWorkflows with null cwd (no project context)', () => {
    it('skips project scope and returns no project-source workflows', async () => {
      // When no codebase is registered the LIST endpoint passes null so bundled
      // + home scopes can still surface. Discovery must not attempt to read a
      // cwd-derived path and must not produce project-source entries.
      const result = await discoverWorkflows(null, { loadDefaults: false });

      // loadDefaults:false skips bundled and a clean test env has no home-
      // scoped workflows, so the full result must be empty — without this the
      // test would pass even if a stray project-path read were silently injected.
      expect(result.workflows).toHaveLength(0);

      const projectSourced = result.workflows.filter(w => w.source === 'project');
      expect(projectSourced).toHaveLength(0);

      // No project-step file/dir read errors — we never tried to access a project path.
      const readErrors = result.errors.filter(e => e.errorType === 'read_error');
      expect(readErrors).toHaveLength(0);
    });

    it('still loads bundled defaults when loadDefaults:true and cwd is null', async () => {
      const result = await discoverWorkflows(null, { loadDefaults: true });

      // No project-source entries (project step skipped).
      const projectSourced = result.workflows.filter(w => w.source === 'project');
      expect(projectSourced).toHaveLength(0);

      // Bundled-source entries must surface — without this assertion the test
      // would silently pass even if the bundled-defaults loader regressed.
      const bundledSourced = result.workflows.filter(w => w.source === 'bundled');
      expect(bundledSourced.length).toBeGreaterThan(0);
    });

    it('discoverWorkflowsWithConfig does not call loadConfig when cwd is null', async () => {
      // The per-project config opt-out must not be evaluated when there is no
      // project context — running loadConfig with no cwd would silently apply
      // home-dir or working-dir defaults to a request that has neither.
      const mockLoadConfig = mock(async () => ({ defaults: { loadDefaultWorkflows: true } }));
      await discoverWorkflowsWithConfig(null, mockLoadConfig);
      expect(mockLoadConfig).not.toHaveBeenCalled();
    });
  });

  describe('addressable session resume', () => {
    function parseAddressable(yaml: string): ParseResult {
      return parseWorkflow(yaml, 'addressable.yaml');
    }

    it('accepts transitively upstream command, prompt, and plain loop sources', () => {
      const result = parseAddressable(`
name: addressable
description: addressable sessions
provider: claude
nodes:
  - id: command-source
    command: scope
  - id: prompt-source
    prompt: review
    depends_on: [command-source]
  - id: loop-source
    loop:
      prompt: refine
      until: DONE
      max_iterations: 2
    depends_on: [prompt-source]
  - id: consumer
    prompt: synthesize
    depends_on: [loop-source]
    context:
      resume: command-source
`);
      expect(result.error).toBeNull();
      expect((result.workflow?.nodes as DagNode[] | undefined)?.at(-1)?.context).toEqual({
        resume: 'command-source',
      });
    });

    for (const [label, sourceNode] of [
      ['bash', '  - id: source\n    bash: echo scope'],
      ['script', '  - id: source\n    script: console.log(1)\n    runtime: bun'],
      ['approval', "  - id: source\n    approval:\n      message: 'Approve?'"],
      ['workflow', '  - id: source\n    workflow: child'],
    ] as const) {
      it(`rejects a ${label} source`, () => {
        const result = parseAddressable(`
name: bad-source
description: bad source
provider: claude
nodes:
${sourceNode}
  - id: consumer
    prompt: continue
    depends_on: [source]
    context: { resume: source }
`);
        expect(result.error?.error).toContain('not a session-producing command, prompt, or loop');
      });
    }

    it('rejects missing, self, downstream, and sibling sources', () => {
      const missing = parseAddressable(`
name: missing
description: missing
nodes:
  - id: consumer
    prompt: continue
    context: { resume: ghost }
`);
      expect(missing.error?.error).toContain("references unknown node 'ghost'");

      const self = parseAddressable(`
name: self
description: self
nodes:
  - id: consumer
    prompt: continue
    context: { resume: consumer }
`);
      expect(self.error?.error).toContain('not an upstream dependency');

      const downstream = parseAddressable(`
name: downstream
description: downstream
nodes:
  - id: consumer
    prompt: continue
    context: { resume: later }
  - id: later
    prompt: later
    depends_on: [consumer]
`);
      expect(downstream.error?.error).toContain('not an upstream dependency');

      const sibling = parseAddressable(`
name: sibling
description: sibling
nodes:
  - id: source
    prompt: source
  - id: consumer
    prompt: continue
    context: { resume: source }
`);
      expect(sibling.error?.error).toContain('not an upstream dependency');
    });

    it('rejects named resume inside a loop_group body', () => {
      const result = parseAddressable(`
name: nested
description: nested
nodes:
  - id: group
    loop_group:
      until: DONE
      max_iterations: 2
      nodes:
        - id: source
          prompt: source
        - id: consumer
          prompt: continue
          depends_on: [source]
          context: { resume: source }
`);
      expect(result.error?.error).toContain('inside a loop_group body');
    });

    it('rejects statically mismatched and fork-incapable providers', () => {
      const mismatch = parseAddressable(`
name: mismatch
description: mismatch
nodes:
  - id: source
    prompt: source
    provider: claude
  - id: consumer
    prompt: continue
    provider: codex
    depends_on: [source]
    context: { resume: source }
`);
      expect(mismatch.error?.error).toContain("source 'source' uses provider 'claude'");
      expect(mismatch.error?.error).toContain("consumer uses 'codex'");

      const incapable = parseAddressable(`
name: incapable
description: incapable
provider: codex
nodes:
  - id: source
    prompt: source
  - id: consumer
    prompt: continue
    depends_on: [source]
    context: { resume: source }
`);
      expect(incapable.error?.error).toContain("provider 'codex' does not support sessionFork");
    });

    it('defers implicit provider resolution to runtime', () => {
      const result = parseAddressable(`
name: implicit
description: implicit
nodes:
  - id: source
    prompt: source
  - id: consumer
    prompt: continue
    depends_on: [source]
    context: { resume: source }
`);
      expect(result.error).toBeNull();
    });
  });

  describe('persist_session capability gating', () => {
    it('parses persist_session: true on a node', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: t\ndescription: t\nprovider: claude\nnodes:\n  - id: planner\n    prompt: p\n    persist_session: true\n`;
      await writeFile(join(workflowDir, 't.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toEqual([]);
      const node = result.workflows[0].workflow.nodes[0];
      expect('persist_session' in node ? node.persist_session : undefined).toBe(true);
    });

    it('parses persist_sessions: true at workflow root', () => {
      const { workflow } = parseWorkflowYaml(
        `name: t\ndescription: t\nprovider: claude\npersist_sessions: true\nnodes:\n  - id: planner\n    prompt: p\n`
      );
      expect(workflow.persist_sessions).toBe(true);
    });

    it('collapses persist_sessions onto AI nodes only, so composition preserves it', async () => {
      // The workflow-level default is what the executor's `nodeUsesPersistedScope`
      // reads for a node with no `persist_session:` of its own. Once composition
      // removes the workflow-level layer (#1764) the default has to have landed on
      // the nodes that can use it — and NOT on the ones that cannot, or the loader's
      // capability gate and the executor's predicate disagree about the same file.
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      await writeFile(
        join(workflowDir, 'persist.yaml'),
        `name: persist-collapse\ndescription: t\nprovider: claude\npersist_sessions: true\nnodes:\n  - id: planner\n    prompt: p\n  - id: shell\n    bash: echo hi\n`
      );
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toEqual([]);
      const expanded = result.workflows[0].workflow;
      expect(expanded.persist_sessions).toBeUndefined();
      const byId = new Map((expanded.nodes as DagNode[]).map(n => [n.id, n]));
      expect(byId.get('planner')?.persist_session).toBe(true);
      expect(byId.get('shell')?.persist_session).toBeUndefined();
    });

    it('does NOT collapse persist_sessions into a loop_group body', async () => {
      // A body runs in a context the executor builds with `workflowPersistSessions: false`,
      // so the workflow-level default has never reached it. `nodeUsesPersistedScope` reads
      // the NODE value first, so pushing it here would override that deliberate false and
      // grant a body cross-run persistence it never had — and could trip the runtime
      // sessionResume guard on a provider that lacks it.
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      await writeFile(
        join(workflowDir, 'lg-persist.yaml'),
        `name: lg-persist\ndescription: t\nprovider: claude\npersist_sessions: true\nnodes:\n  - id: group\n    loop_group:\n      until: DONE\n      max_iterations: 2\n      nodes:\n        - id: body\n          prompt: p\n  - id: after\n    prompt: p\n`
      );
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toEqual([]);
      const nodes = result.workflows[0].workflow.nodes as DagNode[];
      const group = nodes.find(n => n.id === 'group');
      expect(group && isLoopGroupNode(group)).toBe(true);
      const body = group && isLoopGroupNode(group) ? group.loop_group.nodes[0] : undefined;
      expect(body).toBeDefined();
      expect((body as DagNode | undefined)?.persist_session).toBeUndefined();
      // The top-level AI node still receives it — only the body is excluded.
      expect(nodes.find(n => n.id === 'after')?.persist_session).toBe(true);
    });

    it('does NOT capability-check non-AI nodes when persist_sessions is workflow-level', async () => {
      // Regression for CodeRabbit #7: workflow-level persist_sessions: true with a bash
      // node would falsely trigger the capability check on a provider that can't even
      // be invoked from a bash node. Bash/script/approval/cancel/loop and context:'fresh'
      // nodes must skip the capability gate.
      const { registerProvider } = await import('@archon/providers');
      registerProvider({
        id: 'no-resume-skip-test',
        displayName: 'No Resume Skip Test',
        builtIn: false,
        credentials: { kind: 'static', specs: [] },
        capabilities: {
          sessionResume: false,
          mcp: false,
          hooks: false,
          skills: false,
          agents: false,
          toolRestrictions: false,
          structuredOutput: false,
          envInjection: false,
          costControl: false,
          effortControl: false,
          thinkingControl: false,
          fallbackModel: false,
          sandbox: false,
          settingSources: false,
          nativeTools: false,
          containerExec: false,
        },
        factory: () => ({
          getType: () => 'no-resume-skip-test',
          getCapabilities: () => ({
            sessionResume: false,
            mcp: false,
            hooks: false,
            skills: false,
            agents: false,
            toolRestrictions: false,
            structuredOutput: false,
            envInjection: false,
            costControl: false,
            effortControl: false,
            thinkingControl: false,
            fallbackModel: false,
            sandbox: false,
            settingSources: false,
            nativeTools: false,
            containerExec: false,
          }),
          // eslint-disable-next-line require-yield
          async *sendQuery() {
            return;
          },
        }),
      });
      try {
        const workflowDir = join(testDir, '.archon', 'workflows');
        await mkdir(workflowDir, { recursive: true });
        // Workflow opts in at root; the only node is bash. Should LOAD CLEAN because
        // bash never invokes a provider session.
        const yaml = `name: t\ndescription: t\nprovider: no-resume-skip-test\npersist_sessions: true\nnodes:\n  - id: build\n    bash: 'echo hello'\n`;
        await writeFile(join(workflowDir, 't.yaml'), yaml);
        const result = await discoverWorkflows(testDir, { loadDefaults: false });
        expect(result.errors).toEqual([]);
        expect(result.workflows.length).toBe(1);
      } finally {
        clearRegistry();
        registerBuiltinProviders();
      }
    });

    it('rejects persist_session: true on a provider without sessionResume', async () => {
      // Register an ephemeral provider with sessionResume: false to drive the capability gate.
      // No unregister API exists; restore via clearRegistry + registerBuiltinProviders in finally.
      const { registerProvider } = await import('@archon/providers');
      registerProvider({
        id: 'no-resume-test',
        displayName: 'No Resume Test',
        builtIn: false,
        credentials: { kind: 'static', specs: [] },
        capabilities: {
          sessionResume: false,
          mcp: false,
          hooks: false,
          skills: false,
          agents: false,
          toolRestrictions: false,
          structuredOutput: false,
          envInjection: false,
          costControl: false,
          effortControl: false,
          thinkingControl: false,
          fallbackModel: false,
          sandbox: false,
          settingSources: false,
          nativeTools: false,
          containerExec: false,
        },
        factory: () => ({
          getType: () => 'no-resume-test',
          getCapabilities: () => ({
            sessionResume: false,
            mcp: false,
            hooks: false,
            skills: false,
            agents: false,
            toolRestrictions: false,
            structuredOutput: false,
            envInjection: false,
            costControl: false,
            effortControl: false,
            thinkingControl: false,
            fallbackModel: false,
            sandbox: false,
            settingSources: false,
            nativeTools: false,
            containerExec: false,
          }),
          // eslint-disable-next-line require-yield
          async *sendQuery() {
            return;
          },
        }),
      });
      try {
        const workflowDir = join(testDir, '.archon', 'workflows');
        await mkdir(workflowDir, { recursive: true });
        const yaml = `name: t\ndescription: t\nprovider: no-resume-test\nnodes:\n  - id: planner\n    prompt: p\n    persist_session: true\n`;
        await writeFile(join(workflowDir, 't.yaml'), yaml);
        const result = await discoverWorkflows(testDir, { loadDefaults: false });
        expect(result.workflows).toEqual([]);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0].error).toContain('persist_session');
        expect(result.errors[0].error).toContain('sessionResume');
      } finally {
        clearRegistry();
        registerBuiltinProviders();
      }
    });
  });

  describe('unknown key warnings (#2213)', () => {
    it('should warn when a node has an unknown key', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = [
        'name: test',
        'description: test',
        'nodes:',
        '  - id: plan',
        '    command: my-command',
        '    unknown_field: true',
      ].join('\n');
      await writeFile(join(workflowDir, 'test.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows.length).toBe(1);
      const pw = result.workflows[0].parseWarnings ?? [];
      expect(pw.length).toBe(1);
      expect(pw[0]).toContain("unknown key 'unknown_field'");
      expect(pw[0]).toContain('will be ignored');
    });

    it('should hint when a workflow-level key is misplaced on a node', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      // 'interactive' is valid at workflow level but not on individual nodes
      const yaml = [
        'name: test',
        'description: test',
        'nodes:',
        '  - id: plan',
        '    command: my-command',
        '    interactive: true',
      ].join('\n');
      await writeFile(join(workflowDir, 'test.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows.length).toBe(1);
      const pw = result.workflows[0].parseWarnings ?? [];
      expect(pw.length).toBe(1);
      expect(pw[0]).toContain("'interactive'");
      // The hint must name BOTH loop fields: the executor gates on
      // `loop.interactive && loop.gate_message`, so an author who follows a
      // gate_message-only hint gets a loop with a message and no gate.
      expect(pw[0]).toContain('loop.interactive: true');
      expect(pw[0]).toContain('gate_message');
      expect(pw[0]).toContain('approval:');
    });

    it('should warn when the workflow itself has an unknown key', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = [
        'name: test',
        'description: test',
        'max_retries: 3',
        'nodes:',
        '  - id: n',
        '    prompt: p',
      ].join('\n');
      await writeFile(join(workflowDir, 'test.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows.length).toBe(1);
      const pw = result.workflows[0].parseWarnings ?? [];
      expect(pw.length).toBe(1);
      expect(pw[0]).toContain("unknown key 'max_retries'");
    });

    it('should not warn for valid node keys', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = [
        'name: test',
        'description: test',
        'nodes:',
        '  - id: n',
        '    prompt: hello',
        '    model: some-model',
        '    context: fresh',
      ].join('\n');
      await writeFile(join(workflowDir, 'test.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows.length).toBe(1);
      const pw = result.workflows[0].parseWarnings ?? [];
      expect(pw.length).toBe(0);
    });

    it('should collect warnings from multiple nodes', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = [
        'name: test',
        'description: test',
        'nodes:',
        '  - id: a',
        '    prompt: hello',
        '    typo_key: 1',
        '  - id: b',
        '    bash: echo hi',
        '    another_typo: 2',
      ].join('\n');
      await writeFile(join(workflowDir, 'test.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows.length).toBe(1);
      const pw = result.workflows[0].parseWarnings ?? [];
      expect(pw.length).toBe(2);
      expect(pw[0]).toContain("Node 'a'");
      expect(pw[1]).toContain("Node 'b'");
    });

    it('should hint when a node-only key is misplaced at workflow level', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      // 'command' is valid on nodes but not at workflow level
      const yaml = [
        'name: test',
        'description: test',
        'command: my-command',
        'nodes:',
        '  - id: n',
        '    prompt: p',
      ].join('\n');
      await writeFile(join(workflowDir, 'test.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows.length).toBe(1);
      const pw = result.workflows[0].parseWarnings ?? [];
      expect(pw.length).toBe(1);
      expect(pw[0]).toContain("'command'");
      expect(pw[0]).toContain('valid on individual nodes');
    });
  });

  describe('unknown key warnings — nested (#2213)', () => {
    /** Write a single workflow and return its parse warnings. */
    const warningsFor = async (lines: string[]): Promise<string[]> => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      await writeFile(join(workflowDir, 'test.yaml'), lines.join('\n'));
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows.length).toBe(1);
      return [...(result.workflows[0].parseWarnings ?? [])];
    };

    it('should warn on an unknown key inside approval:', async () => {
      const pw = await warningsFor([
        'name: test',
        'description: test',
        'interactive: true',
        'nodes:',
        '  - id: gate',
        '    approval:',
        '      message: ok?',
        '      capture_reponse: true', // typo for capture_response
      ]);
      expect(pw.length).toBe(1);
      expect(pw[0]).toContain("Node 'gate'");
      expect(pw[0]).toContain("unknown key 'approval.capture_reponse'");
    });

    it('should warn on an unknown key inside approval.on_reject (two levels down)', async () => {
      const pw = await warningsFor([
        'name: test',
        'description: test',
        'interactive: true',
        'nodes:',
        '  - id: gate',
        '    approval:',
        '      message: ok?',
        '      on_reject:',
        '        prompt: try again',
        '        max_retries: 2', // real field is max_attempts
      ]);
      // Also carries the #2707 step-1 on_reject deprecation warning now — the
      // unknown-key warning under test is asserted independently of it.
      const unknownKeyWarnings = pw.filter(w => w.includes('unknown key'));
      expect(unknownKeyWarnings.length).toBe(1);
      expect(unknownKeyWarnings[0]).toContain("unknown key 'approval.on_reject.max_retries'");
      expect(pw.some(w => w.includes("'approval.on_reject' is deprecated"))).toBe(true);
    });

    it('should warn on an unknown key inside retry:', async () => {
      const pw = await warningsFor([
        'name: test',
        'description: test',
        'nodes:',
        '  - id: n',
        '    prompt: hello',
        '    retry:',
        '      max_attempts: 2',
        '      backoff_ms: 5000', // real field is delay_ms
      ]);
      expect(pw.length).toBe(1);
      expect(pw[0]).toContain("unknown key 'retry.backoff_ms'");
    });

    it('should warn on an unknown key inside context:', async () => {
      const pw = await warningsFor([
        'name: test',
        'description: test',
        'nodes:',
        '  - id: source',
        '    prompt: source',
        '  - id: consumer',
        '    prompt: consumer',
        '    depends_on: [source]',
        '    context:',
        '      resume: source',
        '      fork: false',
      ]);
      expect(pw.length).toBe(1);
      expect(pw[0]).toContain("unknown key 'context.fork'");
    });

    it('should warn on an unknown key inside an agents entry', async () => {
      const pw = await warningsFor([
        'name: test',
        'description: test',
        'nodes:',
        '  - id: n',
        '    prompt: hello',
        '    agents:',
        '      my-agent:',
        '        description: does things',
        '        prompt: do it',
        '        disallowed_tools: [Bash]', // real field is disallowedTools
      ]);
      expect(pw.length).toBe(1);
      // The agent id is author-chosen, so it must appear in the path verbatim
      // rather than being reported as an unknown key itself.
      expect(pw[0]).toContain("unknown key 'agents.my-agent.disallowed_tools'");
    });

    it('should warn on an unknown key on a loop_group body node', async () => {
      const pw = await warningsFor([
        'name: test',
        'description: test',
        'nodes:',
        '  - id: refine',
        '    loop_group:',
        '      until_bash: "exit 0"',
        '      max_iterations: 3',
        '      nodes:',
        '        - id: check',
        '          prompt: check it',
        '          interactive: true',
      ]);
      expect(pw.length).toBe(1);
      expect(pw[0]).toContain("Node 'refine' → loop_group node 'check'");
      expect(pw[0]).toContain("unknown key 'interactive'");
      // The body node gets the same actionable guidance as a top-level node.
      expect(pw[0]).toContain('loop.interactive: true');
    });

    it('should warn on an unknown key inside the loop_group control block', async () => {
      const pw = await warningsFor([
        'name: test',
        'description: test',
        'nodes:',
        '  - id: refine',
        '    loop_group:',
        '      until_bash: "exit 0"',
        '      max_iterations: 3',
        '      max_attempts: 4', // not a loop control field
        '      nodes:',
        '        - id: check',
        '          prompt: check it',
      ]);
      expect(pw.length).toBe(1);
      expect(pw[0]).toContain("unknown key 'loop_group.max_attempts'");
    });

    it('should warn on an unknown key inside a workflow-level worktree block', async () => {
      const pw = await warningsFor([
        'name: test',
        'description: test',
        'worktree:',
        '  enabled: true',
        '  base_branch: main', // worktree policy has only `enabled`
        'nodes:',
        '  - id: n',
        '    prompt: p',
      ]);
      expect(pw.length).toBe(1);
      expect(pw[0]).toContain("Workflow 'test'");
      expect(pw[0]).toContain("unknown key 'worktree.base_branch'");
    });

    it('should not warn on valid nested keys, including a clean loop_group body', async () => {
      const pw = await warningsFor([
        'name: test',
        'description: test',
        'interactive: true',
        'worktree:',
        '  enabled: true',
        'nodes:',
        '  - id: refine',
        '    loop_group:',
        '      until: DONE',
        '      max_iterations: 3',
        '      interactive: true',
        '      gate_message: continue?',
        '      nodes:',
        '        - id: check',
        '          prompt: check it',
        '          retry:',
        '            max_attempts: 2',
        '            delay_ms: 1000',
        '  - id: gate',
        '    depends_on: [refine]',
        '    approval:',
        '      message: ok?',
        '      capture_response: true',
        '      on_reject:',
        '        prompt: again',
        '        max_attempts: 2',
      ]);
      // Every key used here IS valid — none should trip the unknown-key check
      // this describe block covers. `loop.interactive`/`on_reject`/the prose
      // `until:` channel are also deliberately deprecated (#2707 steps 1 and 3),
      // so this fixture now legitimately produces THOSE warnings too — asserted
      // separately below, not conflated with "unknown key" false positives.
      // `capture_response` combined with `on_reject` (no `decisions:` authored)
      // is still fully functional (R4 fix), so it does NOT warn here.
      expect(pw.some(w => w.includes('unknown key'))).toBe(false);
      expect(pw).toEqual([
        "Node 'refine': node-level loop 'interactive:' is deprecated. A future release re-expresses the interactive loop as a gate + loop_group composition (#2707 step 3). Continue using it for now.",
        "Node 'refine': the prose 'loop_group.until' completion signal is deprecated. Declare 'loop_group.until_bash' instead — it can read a body node's structured output (e.g. 'test \"$body-node.output.field\" = true') (#2707 step 3). Continue using it for now.",
        "Node 'gate': 'approval.on_reject' is deprecated. Declare 'approval.decisions' and wire a rework node with \"when: \\\"$gate.output.decision == 'reject'\\\"\" instead (loop it with loop_group if it should iterate). This gate keeps running via the legacy mechanism until migrated.",
      ]);
    });

    it('should not treat free-form output_format keys as unknown', async () => {
      const pw = await warningsFor([
        'name: test',
        'description: test',
        'nodes:',
        '  - id: n',
        '    prompt: hello',
        '    output_format:',
        '      type: object',
        '      properties:',
        '        anything_at_all:',
        '          type: string',
      ]);
      expect(pw).toEqual([]);
    });

    it('should not treat a thinking: config as an unknown-key surface', async () => {
      // `thinking` is a z.preprocess over a union, not an object shape — there
      // is nothing to compare keys against, so it must stay exempt rather than
      // warning on its own legitimate fields.
      const pw = await warningsFor([
        'name: test',
        'description: test',
        'nodes:',
        '  - id: n',
        '    prompt: hello',
        '    thinking:',
        '      type: enabled',
        '      budgetTokens: 4096',
      ]);
      expect(pw).toEqual([]);
    });
  });

  describe('include: warnings stay with the file that declared the key (#2213)', () => {
    // Pins CURRENT behaviour, which is a known gap documented in the authoring
    // guide: warnings are keyed by the file they were parsed from, so an
    // included block's unknown key is reported against the BLOCK, never against
    // the workflow that includes it. Propagating across the include boundary is
    // a deliberate follow-up — this test exists so that change is a visible,
    // intentional edit rather than a silent behaviour shift.
    it('reports on the included block, not the includer', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      await writeFile(
        join(workflowDir, 'block.yaml'),
        [
          'name: block',
          'description: shared block',
          'nodes:',
          '  - id: work',
          '    prompt: do it',
          '    interactive: true', // dropped, warned — on THIS file
        ].join('\n')
      );
      await writeFile(
        join(workflowDir, 'parent.yaml'),
        [
          'name: parent',
          'description: includes the block',
          'nodes:',
          '  - id: blk',
          '    include: block',
        ].join('\n')
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const byName = new Map(result.workflows.map(w => [w.workflow.name, w]));

      const block = byName.get('block');
      expect((block?.parseWarnings ?? []).length).toBe(1);
      expect(block?.parseWarnings?.[0]).toContain("unknown key 'interactive'");

      // The includer inlines the block's NODES but not its warnings.
      const parent = byName.get('parent');
      expect(parent).toBeDefined();
      expect(parent?.parseWarnings ?? []).toEqual([]);
    });
  });

  describe('parse warnings survive a filename collision (#2213)', () => {
    // Discovery keys files by BARE filename, so `foo.yaml` at the root and
    // `foo.yaml` in a 1-level subfolder (a supported layout) collide, and the
    // loser is dropped. `readdir()` order decides which one wins, so these
    // assert the ORDER-INDEPENDENT invariant instead of a fixed winner: the
    // warnings that survive must describe the workflow that survived. Before
    // the single-entry refactor the definition and the warnings came from two
    // parallel maps, and a clean file could inherit the dropped file's warning.
    //
    // READ THIS BEFORE TRUSTING THE PAIR: only ONE of these two is a live
    // regression test on any given platform, and which one depends on the
    // filesystem. The bug was that warnings were sticky — set, never cleared —
    // so it is only observable when the CLEAN file wins: post-fix its warnings
    // are empty, pre-fix it inherited the dirty file's. When the DIRTY file
    // wins, pre-fix and post-fix produce the same correct warning, so that
    // direction cannot distinguish them and passes either way. There is no
    // assertion that fixes this; it is inherent to the bug's shape.
    //
    // Forcing both orderings would need a test seam in `loadWorkflowsFromDir`
    // or a `mock.module('fs/promises')` that would break the real-I/O tests
    // throughout this file. Judged not worth it (#2455 review S5) — but do not
    // read this as two regression tests, because it is one plus a companion.
    const CLEAN = (name: string): string =>
      ['name: ' + name, 'description: test', 'nodes:', '  - id: a', '    prompt: hi'].join('\n');
    const DIRTY = (name: string): string =>
      [
        'name: ' + name,
        'description: test',
        'nodes:',
        '  - id: a',
        '    prompt: hi',
        '    interactive: true',
      ].join('\n');

    /** Write root/sub `foo.yaml`, discover, and return the single survivor. */
    const discoverColliding = async (
      rootYaml: string,
      subYaml: string
    ): Promise<{ name: string; warnings: string[] }> => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(join(workflowDir, 'zsub'), { recursive: true });
      await writeFile(join(workflowDir, 'foo.yaml'), rootYaml);
      await writeFile(join(workflowDir, 'zsub', 'foo.yaml'), subYaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      // One filename → one surviving entry, whichever side won.
      expect(result.workflows.length).toBe(1);
      return {
        name: result.workflows[0].workflow.name,
        warnings: [...(result.workflows[0].parseWarnings ?? [])],
      };
    };

    it('does not attach the dropped file’s warning to a clean survivor', async () => {
      const { name, warnings } = await discoverColliding(CLEAN('foo-root'), DIRTY('foo-sub'));
      if (name === 'foo-root') {
        expect(warnings).toEqual([]); // the clean file won — it declares no unknown key
      } else {
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain("unknown key 'interactive'");
      }
    });

    it('does not drop a dirty survivor’s warning when a clean file collides', async () => {
      const { name, warnings } = await discoverColliding(DIRTY('foo-root'), CLEAN('foo-sub'));
      if (name === 'foo-root') {
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain("unknown key 'interactive'");
      } else {
        expect(warnings).toEqual([]);
      }
    });
  });

  describe('no false positives on the real workflow corpus (#2213)', () => {
    /**
     * The unknown-key check is only useful if a legitimate key never trips it.
     * Detection reaches into nested config blocks and `loop_group` bodies, so a
     * schema field that drifts out of a derived key set would start warning on
     * valid YAML — and a warning nobody can act on is worse than none.
     *
     * Runs over Archon's own `.archon/workflows/` — its largest real corpus —
     * and asserts nothing OUTSIDE a known-bad allowlist warns. Deliberately
     * one-directional: the allowlist may shrink freely (fixing
     * `e2e-opencode-smoke.yaml` must not break this), but a new name appearing
     * is a false positive and fails.
     *
     * Calls `parseWorkflow` per file rather than `discoverWorkflows`. Parsing is
     * the only thing under test — running full discovery would additionally do
     * include expansion, command-file resolution and config loading, which is
     * both a looser unit and heavy enough to starve the other package test
     * processes running in parallel (`bun --filter '*' --parallel test`). It
     * measurably did: on a 2-core Windows CI runner it pushed an unrelated
     * SQLite test from 250 ms past Bun's 5000 ms per-test timeout.
     */
    const KNOWN_BAD = new Set([
      // `agent:` at workflow and node level — a real bug, silently dropped since
      // April. Remove from this list when the file is fixed.
      'e2e-opencode-smoke',
      // #2707 step 1: these bundled workflows use the deprecated legacy
      // approval.on_reject/capture_response mechanism and (for archon-piv-loop)
      // node-level loop interactive:. They still run unmodified (grow-then-
      // deprecate) — the warning is expected here, not a false positive.
      // Remove from this list once #2123's defaults rewrite migrates them.
      'archon-interactive-prd',
      'archon-piv-loop',
      // #2707 step 3: these bundled workflows declare the now-deprecated prose
      // 'until:' completion channel on a loop/loop_group — still fully
      // functional (grow-then-deprecate); the warning is expected, not a false
      // positive. Remove from this list once #2123's defaults rewrite migrates
      // them to 'until_bash'/'until_field'.
      'archon-adversarial-dev',
      'archon-test-loop-dag',
      'archon-ralph-dag',
      't1-fix-issue',
    ]);

    it('warns only on workflows already known to carry unknown keys', async () => {
      // packages/workflows/src/ → repo root
      const corpusDir = join(import.meta.dir, '..', '..', '..', '.archon', 'workflows');

      // Discovery descends one level; mirror that without invoking it.
      const files: string[] = [];
      for (const entry of await readdir(corpusDir, { withFileTypes: true })) {
        const full = join(corpusDir, entry.name);
        if (entry.isDirectory()) {
          for (const sub of await readdir(full)) {
            if (sub.endsWith('.yaml') || sub.endsWith('.yml')) files.push(join(full, sub));
          }
        } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
          files.push(full);
        }
      }
      // Guard against silently testing nothing if the corpus moves.
      expect(files.length).toBeGreaterThan(20);

      const unexpected: string[] = [];
      for (const file of files) {
        const result = parseWorkflow(await readFile(file, 'utf-8'), basename(file));
        if (!result.workflow || result.warnings.length === 0) continue;
        if (!KNOWN_BAD.has(result.workflow.name)) unexpected.push(result.workflow.name);
      }
      expect(unexpected).toEqual([]);
    });
  });

  describe('#2707 step 1 gate/loop deprecation warnings', () => {
    /** Write a single workflow and return its parse warnings. */
    const warningsFor = async (lines: string[]): Promise<string[]> => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      await writeFile(join(workflowDir, 'test.yaml'), lines.join('\n'));
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.workflows.length).toBe(1);
      return [...(result.workflows[0].parseWarnings ?? [])];
    };

    it('warns on approval.capture_response combined with explicitly authored decisions (R4 fix — only truly ignored there)', async () => {
      const pw = await warningsFor([
        'name: test',
        'description: test',
        'interactive: true',
        'nodes:',
        '  - id: gate',
        '    approval:',
        '      message: ok?',
        '      capture_response: true',
        '      decisions:',
        '        - id: approve',
        '        - id: reject',
      ]);
      expect(pw).toHaveLength(1);
      expect(pw[0]).toContain("Node 'gate': 'approval.capture_response' is deprecated");
    });

    it('does NOT warn on approval.capture_response without decisions: authored — still fully functional (R4 fix)', async () => {
      const pw = await warningsFor([
        'name: test',
        'description: test',
        'interactive: true',
        'nodes:',
        '  - id: gate',
        '    approval:',
        '      message: ok?',
        '      capture_response: true',
      ]);
      expect(pw).toEqual([]);
    });

    it('warns on approval.on_reject', async () => {
      const pw = await warningsFor([
        'name: test',
        'description: test',
        'interactive: true',
        'nodes:',
        '  - id: gate',
        '    approval:',
        '      message: ok?',
        '      on_reject:',
        '        prompt: fix it',
      ]);
      expect(pw).toHaveLength(1);
      expect(pw[0]).toContain("Node 'gate': 'approval.on_reject' is deprecated");
    });

    it('warns on node-level loop.interactive', async () => {
      const pw = await warningsFor([
        'name: test',
        'description: test',
        'interactive: true',
        'nodes:',
        '  - id: iterate',
        '    loop:',
        '      prompt: work',
        '      until_bash: "exit 0"',
        '      max_iterations: 5',
        '      interactive: true',
        '      gate_message: continue?',
      ]);
      expect(pw).toHaveLength(1);
      expect(pw[0]).toContain("Node 'iterate': node-level loop 'interactive:' is deprecated");
    });

    it('warns on a gate/interactive loop_group nested inside a loop_group body', async () => {
      // Exercises the recursion into loop_group.nodes — the outer group is
      // clean, only the inner body nodes carry deprecated fields. 'inner-gate' also
      // has a dependent ('inner-loop'), so it additionally trips the terminal-sink
      // placement warning below — three warnings on one gate/loop pair, not two.
      const pw = await warningsFor([
        'name: test',
        'description: test',
        'interactive: true',
        'nodes:',
        '  - id: outer',
        '    loop_group:',
        '      until_bash: "exit 0"',
        '      max_iterations: 2',
        '      nodes:',
        '        - id: inner-gate',
        '          approval:',
        '            message: ok?',
        '            on_reject:',
        '              prompt: fix it',
        '        - id: inner-loop',
        '          loop:',
        '            prompt: work',
        '            until_bash: "exit 0"',
        '            max_iterations: 5',
        '            interactive: true',
        '            gate_message: continue?',
        '          depends_on: [inner-gate]',
      ]);
      expect(pw).toHaveLength(3);
      expect(pw.some(w => w.includes("Node 'inner-gate'") && w.includes('on_reject'))).toBe(true);
      expect(pw.some(w => w.includes("Node 'inner-loop'") && w.includes('interactive'))).toBe(true);
      expect(pw.some(w => w.includes("Node 'inner-gate'") && w.includes('terminal sink'))).toBe(
        true
      );
    });

    it('warns on a gate node with a dependent inside a loop_group body (not a terminal sink)', async () => {
      const pw = await warningsFor([
        'name: test',
        'description: test',
        'interactive: true',
        'nodes:',
        '  - id: grp',
        '    loop_group:',
        '      until_bash: "exit 0"',
        '      max_iterations: 3',
        '      nodes:',
        '        - id: check',
        '          approval:',
        '            message: ok?',
        '        - id: after',
        '          depends_on: [check]',
        '          prompt: do more work',
      ]);
      expect(pw).toHaveLength(1);
      expect(pw[0]).toContain("Node 'check'");
      expect(pw[0]).toContain('terminal sink');
    });

    it('warns on a gate node sharing terminal-sink status with another body node', async () => {
      const pw = await warningsFor([
        'name: test',
        'description: test',
        'interactive: true',
        'nodes:',
        '  - id: grp',
        '    loop_group:',
        '      until_bash: "exit 0"',
        '      max_iterations: 3',
        '      nodes:',
        '        - id: check',
        '          approval:',
        '            message: ok?',
        '        - id: also-terminal',
        '          prompt: an independent branch',
      ]);
      expect(pw).toHaveLength(1);
      expect(pw[0]).toContain("Node 'check'");
      expect(pw[0]).toContain('terminal sink');
    });

    it('warns on the prose until: channel on a loop node', async () => {
      const pw = await warningsFor([
        'name: test',
        'description: test',
        'nodes:',
        '  - id: iterate',
        '    loop:',
        '      prompt: work',
        '      until: DONE',
        '      max_iterations: 5',
      ]);
      expect(pw).toHaveLength(1);
      expect(pw[0]).toContain(
        "Node 'iterate': the prose 'loop.until' completion signal is deprecated"
      );
      expect(pw[0]).toContain('until_bash');
      expect(pw[0]).toContain('until_field');
    });

    it('warns on the prose until: channel on a loop_group node, with loop_group-specific guidance (no until_field)', async () => {
      const pw = await warningsFor([
        'name: test',
        'description: test',
        'nodes:',
        '  - id: grp',
        '    loop_group:',
        '      until: DONE',
        '      max_iterations: 3',
        '      nodes:',
        '        - id: work',
        '          prompt: do work',
      ]);
      expect(pw).toHaveLength(1);
      expect(pw[0]).toContain(
        "Node 'grp': the prose 'loop_group.until' completion signal is deprecated"
      );
      expect(pw[0]).toContain('loop_group.until_bash');
      expect(pw[0]).not.toContain('until_field');
    });

    it('does NOT warn on until_bash or until_field alone', async () => {
      const pw = await warningsFor([
        'name: test',
        'description: test',
        'nodes:',
        '  - id: iterate',
        '    loop:',
        '      prompt: work',
        '      until_bash: "exit 0"',
        '      max_iterations: 5',
        '  - id: grp',
        '    depends_on: [iterate]',
        '    loop_group:',
        '      until_bash: "exit 0"',
        '      max_iterations: 3',
        '      nodes:',
        '        - id: work',
        '          prompt: do work',
      ]);
      expect(pw).toEqual([]);
    });

    it('warns on a typo inside a decisions: entry (R5 fix — array typo protection)', async () => {
      const pw = await warningsFor([
        'name: test',
        'description: test',
        'interactive: true',
        'nodes:',
        '  - id: gate',
        '    approval:',
        '      message: ok?',
        '      decisions:',
        '        - id: approve',
        '        - id: reject',
        '          lable: Needs work', // typo for 'label'
      ]);
      expect(pw.some(w => w.includes("unknown key 'approval.decisions.1.lable'"))).toBe(true);
    });

    it('produces no deprecation warnings for a new-mode gate with no deprecated fields', async () => {
      const pw = await warningsFor([
        'name: test',
        'description: test',
        'interactive: true',
        'nodes:',
        '  - id: gate',
        '    approval:',
        '      message: ok?',
        '      decisions:',
        '        - id: approve',
        '        - id: reject',
        '          label: Needs work',
      ]);
      expect(pw).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Workflow signature: inputs / returns (#2470)
// ---------------------------------------------------------------------------

describe('workflow signature: inputs / returns (#2470)', () => {
  it('parses declared inputs and returns', () => {
    const { workflow, error } = parseWorkflow(
      `
name: sig
description: signature block
returns: build
inputs:
  diff:
    required: true
    description: the diff to review
  style:
    default: strict
nodes:
  - id: build
    prompt: "do it with $INPUTS.diff and $INPUTS.style"
`,
      'sig.yaml'
    );
    expect(error).toBeNull();
    expect(workflow?.returns).toBe('build');
    expect(workflow?.inputs?.diff?.required).toBe(true);
    expect(workflow?.inputs?.style?.default).toBe('strict');
  });

  it('rejects returns naming a non-existent top-level node', () => {
    const { workflow, error } = parseWorkflow(
      `
name: bad-returns
description: returns names nothing
returns: nope
nodes:
  - id: build
    prompt: "hi"
`,
      'bad-returns.yaml'
    );
    expect(workflow).toBeNull();
    expect(error?.error).toContain("returns: 'nope'");
  });

  it('rejects an empty returns value instead of falling back to a positional sink', () => {
    const { workflow, error } = parseWorkflow(
      `
name: empty-returns
description: invalid empty selector
returns: "   "
nodes:
  - id: build
    prompt: "hi"
`,
      'empty-returns.yaml'
    );
    expect(workflow).toBeNull();
    expect(error?.errorType).toBe('validation_error');
    expect(error?.error).toContain("Invalid 'returns'");
  });

  it('rejects a non-string returns value instead of falling back to a positional sink', () => {
    const { workflow, error } = parseWorkflow(
      `
name: object-returns
description: invalid object selector
returns: { node: build }
nodes:
  - id: build
    prompt: "hi"
`,
      'object-returns.yaml'
    );
    expect(workflow).toBeNull();
    expect(error?.errorType).toBe('validation_error');
    expect(error?.error).toContain("Invalid 'returns'");
  });

  it('drops a contradictory required+default input (warn-and-drop)', () => {
    const { workflow, error } = parseWorkflow(
      `
name: contradiction
description: required and default together
inputs:
  x:
    required: true
    default: v
nodes:
  - id: build
    prompt: "hi"
`,
      'contradiction.yaml'
    );
    expect(error).toBeNull();
    // The single contradictory key is dropped, leaving no inputs.
    expect(workflow?.inputs).toBeUndefined();
  });

  it('drops an invalid input name with a warning while preserving the workflow', () => {
    mockLogger.warn.mockClear();
    const { workflow, error } = parseWorkflow(
      `
name: invalid-input-name
description: invalid input name
inputs:
  bad.name:
    default: value
nodes:
  - id: build
    prompt: "hi"
`,
      'invalid-input-name.yaml'
    );
    expect(error).toBeNull();
    expect(workflow?.inputs).toBeUndefined();
    expect(mockLogger.warn.mock.calls.map(call => call[1])).toContain(
      'invalid_workflow_input_name_ignored'
    );
  });

  it('ignores a non-object inputs block with a warning while preserving the workflow', () => {
    mockLogger.warn.mockClear();
    const { workflow, error } = parseWorkflow(
      `
name: invalid-inputs-block
description: invalid inputs block
inputs: [wrong]
nodes:
  - id: build
    prompt: "hi"
`,
      'invalid-inputs-block.yaml'
    );
    expect(error).toBeNull();
    expect(workflow?.inputs).toBeUndefined();
    expect(mockLogger.warn.mock.calls.map(call => call[1])).toContain(
      'invalid_workflow_inputs_block_ignored'
    );
  });

  it('rejects two input names that mangle to the same env key', () => {
    const { workflow, error } = parseWorkflow(
      `
name: collide
description: env-key collision
inputs:
  foo-bar:
    description: hyphen form
  foo_bar:
    description: underscore form
nodes:
  - id: build
    prompt: "hi"
`,
      'collide.yaml'
    );
    expect(workflow).toBeNull();
    expect(error?.error).toContain('INPUTS_FOO_BAR');
  });

  it('flags a dangling $node.output ref inside a workflow: with value', () => {
    const { workflow, error } = parseWorkflow(
      `
name: with-ref
description: with value references an unknown node
nodes:
  - id: sub
    workflow: child-wf
    with:
      plan: "$nosuch.output"
`,
      'with-ref.yaml'
    );
    expect(workflow).toBeNull();
    expect(error?.error).toContain('nosuch');
  });
});

// ---------------------------------------------------------------------------
// Authored workflow outcome (#2618)
// ---------------------------------------------------------------------------

describe('workflow authored outcome declaration (#2618)', () => {
  const parseOutcomeWorkflow = (
    declaration: string,
    outputFormat = `
    output_format:
      type: object
      properties:
        green:
          type: boolean
      required: [green]`
  ): ReturnType<typeof parseWorkflow> =>
    parseWorkflow(
      `
name: authored-outcome
description: independently reports the authored verdict
${declaration}
nodes:
  - id: result
    prompt: report the verdict${outputFormat}
`,
      'authored-outcome.yaml'
    );

  it('accepts a trimmed field naming a required boolean on the selected return node', () => {
    const { workflow, error } = parseOutcomeWorkflow('returns: result\noutcome_field: "  green  "');

    expect(error).toBeNull();
    expect(workflow?.returns).toBe('result');
    expect(workflow?.outcome_field).toBe('green');
  });

  it('rejects outcome_field without an explicit returns node', () => {
    const { workflow, error } = parseOutcomeWorkflow('outcome_field: green');

    expect(workflow).toBeNull();
    expect(error?.error).toContain('without returns:');
  });

  it.each([
    ['blank', 'returns: result\noutcome_field: "   "'],
    ['non-string', 'returns: result\noutcome_field: { field: green }'],
  ])('rejects a %s outcome_field instead of silently dropping it', (_label, declaration) => {
    const { workflow, error } = parseOutcomeWorkflow(declaration);

    expect(workflow).toBeNull();
    expect(error?.error).toContain("Invalid 'outcome_field'");
  });

  it.each([
    ['no output_format', ''],
    [
      'undeclared property',
      `
    output_format:
      type: object
      properties:
        ready: { type: boolean }
      required: [ready]`,
    ],
    [
      'optional property',
      `
    output_format:
      type: object
      properties:
        green: { type: boolean }`,
    ],
    [
      'non-boolean property',
      `
    output_format:
      type: object
      properties:
        green: { type: string }
      required: [green]`,
    ],
    [
      'non-object root schema',
      `
    output_format:
      type: string
      properties:
        green: { type: boolean }
      required: [green]`,
    ],
  ])('rejects an outcome field with %s', (_label, outputFormat) => {
    const { workflow, error } = parseOutcomeWorkflow(
      'returns: result\noutcome_field: green',
      outputFormat
    );

    expect(workflow).toBeNull();
    expect(error?.errorType).toBe('validation_error');
    expect(error?.error).toContain('outcome_field');
  });

  it('rejects a fan-out workflow node because its runtime output is an aggregate array', () => {
    const { workflow, error } = parseWorkflow(
      `
name: fan-out-outcome
description: invalid direct outcome over child aggregates
returns: work
outcome_field: green
nodes:
  - id: plan
    prompt: emit tasks
    output_format:
      type: object
      properties:
        tasks:
          type: array
          items: { type: string }
      required: [tasks]
  - id: work
    workflow: child-workflow
    depends_on: [plan]
    fan_out:
      items: "$plan.output.tasks"
    output_format:
      type: object
      properties:
        green: { type: boolean }
      required: [green]
`,
      'fan-out-outcome.yaml'
    );

    expect(workflow).toBeNull();
    expect(error?.error).toContain('fan-out workflow node');
    expect(error?.error).toContain('collector node');
  });

  it('rejects a loop_group because its declared output format is ignored at runtime', () => {
    const { workflow, error } = parseWorkflow(
      `
name: loop-group-outcome
description: invalid outcome over a raw loop group result
returns: group
outcome_field: green
nodes:
  - id: group
    output_format:
      type: object
      properties:
        green: { type: boolean }
      required: [green]
    loop_group:
      until: DONE
      max_iterations: 2
      nodes:
        - id: author
          prompt: author a result
`,
      'loop-group-outcome.yaml'
    );

    expect(workflow).toBeNull();
    expect(error?.error).toContain('loop_group');
    expect(error?.error).toContain('raw text');
    expect(error?.error).toContain('collector node');
  });
});

// ---------------------------------------------------------------------------
// Workflow-level field parity (#2457)
// ---------------------------------------------------------------------------

/**
 * `parseWorkflow` does not derive its result from `workflowDefinitionSchema` — it
 * hand-assembles a WorkflowDefinition field by field into an object literal. A field
 * added to the schema but not added to that literal is SILENTLY DISCARDED: the YAML
 * parses, the workflow loads, and the feature is simply inert.
 *
 * That is not hypothetical. `requires:` was added to `workflowBaseSchema` in ab81248d
 * (2026-06-01) without touching the loader, and was not added to that literal until
 * 2d7bf587 (2026-07-16) — six weeks in which the GitHub capability gate could never
 * fire for any discovered workflow, fixed incidentally inside an unrelated PR.
 *
 * This is the guard. The field list is DERIVED from `workflowDefinitionSchema.shape`,
 * so a new schema field fails the test until it is given a fixture here — the same
 * "the derived check fails until the new thing is registered" ratchet used by
 * `check:capability-matrix` and the schema-parity test in `sqlite.test.ts`.
 *
 * Deliberately NOT solved by deriving the assembly itself (`schema.parse(raw)`): most
 * fields warn-and-drop, logging a present-but-invalid value and continuing rather than
 * aborting the whole discovery pass, and `.parse()` would reject the workflow instead.
 * That is not universal — a few fields deliberately hard-reject and a few coerce
 * silently — but one warn-and-drop field is enough to make a blanket `.parse()` wrong.
 * `loader.ts` is the authority on which field does what; do not restate it here.
 * See #2457.
 */
describe('workflow-level field parity (#2457)', () => {
  /**
   * One fixture per workflow-level schema key: a YAML fragment setting the field, and a
   * predicate proving it survived `parseWorkflow`. `present` is deliberately a survival
   * check rather than deep equality — several fields are normalised on the way through
   * (tags deduped, betas trimmed, thinking preprocessed), and this guard is about the
   * field reaching the result at all, not about how it is parsed.
   */
  const FIELD_FIXTURES: Record<
    string,
    { yaml: string; present: (w: WorkflowDefinition) => boolean }
  > = {
    name: { yaml: '', present: w => w.name === 'parity' },
    description: { yaml: '', present: w => w.description === 'parity fixture' },
    nodes: { yaml: '', present: w => w.nodes?.length === 1 },
    provider: { yaml: 'provider: claude', present: w => w.provider === 'claude' },
    model: { yaml: 'model: sonnet', present: w => w.model === 'sonnet' },
    // The one field that survives as a DIFFERENT key. #2556 deprecated it and
    // the loader translates it into `effort:`, so asserting `w.modelReasoningEffort`
    // would now fail for the right reason. The guard's invariant is "a schema
    // field must not be silently inert", and translation satisfies it — so the
    // fixture proves the value arrived, and that the deprecated key did not.
    modelReasoningEffort: {
      yaml: 'modelReasoningEffort: high',
      present: w => w.effort === 'high' && w.modelReasoningEffort === undefined,
    },
    webSearchMode: { yaml: 'webSearchMode: live', present: w => w.webSearchMode === 'live' },
    interactive: { yaml: 'interactive: true', present: w => w.interactive === true },
    effort: { yaml: 'effort: high', present: w => w.effort === 'high' },
    thinking: { yaml: 'thinking: adaptive', present: w => w.thinking?.type === 'adaptive' },
    fallbackModel: {
      yaml: 'fallbackModel: haiku',
      present: w => w.fallbackModel === 'haiku',
    },
    betas: { yaml: 'betas:\n  - some-beta', present: w => w.betas?.includes('some-beta') === true },
    sandbox: { yaml: 'sandbox:\n  enabled: true', present: w => w.sandbox?.enabled === true },
    worktree: { yaml: 'worktree:\n  enabled: false', present: w => w.worktree?.enabled === false },
    container: {
      yaml: 'container:\n  enabled: true',
      present: w => w.container?.enabled === true,
    },
    evidence_policy: {
      yaml: 'evidence_policy:\n  required: true',
      present: w => w.evidence_policy?.required === true,
    },
    mutates_checkout: {
      yaml: 'mutates_checkout: false',
      present: w => w.mutates_checkout === false,
    },
    persist_sessions: {
      yaml: 'persist_sessions: true',
      present: w => w.persist_sessions === true,
    },
    tags: { yaml: 'tags:\n  - alpha', present: w => w.tags?.includes('alpha') === true },
    requires: {
      yaml: 'requires:\n  - github',
      present: w => w.requires?.includes('github') === true,
    },
    inputs: {
      yaml: 'inputs:\n  diff:\n    required: true',
      present: w => w.inputs?.diff?.required === true,
    },
    // `returns` must name a real top-level node id — the fixture's single node is `only`.
    returns: { yaml: 'returns: only', present: w => w.returns === 'only' },
    outcome_field: {
      yaml: 'returns: only\noutcome_field: green',
      present: w => w.outcome_field === 'green',
    },
  };

  const schemaKeys = Object.keys(workflowDefinitionSchema.shape);

  it('has a fixture for every workflow-level schema key (the ratchet)', () => {
    const missing = schemaKeys.filter(k => !(k in FIELD_FIXTURES));
    expect(
      missing,
      `Workflow-level schema keys with no parity fixture: ${missing.join(', ')}. ` +
        'Add a fixture in FIELD_FIXTURES AND make sure parseWorkflow actually carries the ' +
        'field into its returned object literal — a schema field missing from that literal ' +
        'is silently discarded at parse (see #2457).'
    ).toEqual([]);
  });

  it('has no fixture for a key that is not in the schema', () => {
    const stale = Object.keys(FIELD_FIXTURES).filter(k => !schemaKeys.includes(k));
    expect(stale, `Parity fixtures for keys no longer in the schema: ${stale.join(', ')}`).toEqual(
      []
    );
  });

  for (const key of Object.keys(FIELD_FIXTURES)) {
    it(`round-trips '${key}' through parseWorkflow`, () => {
      const fixture = FIELD_FIXTURES[key];
      const yaml = [
        'name: parity',
        'description: parity fixture',
        fixture.yaml,
        'nodes:',
        '  - id: only',
        '    prompt: hello',
        '    output_format:',
        '      type: object',
        '      properties:',
        '        green: { type: boolean }',
        '      required: [green]',
      ]
        .filter(line => line !== '')
        .join('\n');

      // An INVALID fixture value is dropped by design, which looks identical to the bug
      // this test hunts. Clearing the logger first lets the failure message rank the two
      // causes: a warning is strong evidence the fixture is at fault. Silence is NOT
      // proof of the opposite — a few fields coerce an invalid value away with no log at
      // all — so the silent branch names both causes rather than rendering a verdict.
      mockLogger.warn.mockClear();

      const result = parseWorkflow(yaml, `parity-${key}.yaml`);
      expect(
        result.error,
        `parseWorkflow rejected the '${key}' fixture: ${result.error?.error}`
      ).toBeNull();

      const warned = mockLogger.warn.mock.calls.length > 0;
      const message = warned
        ? `Field '${key}' did not survive parseWorkflow, and a warning fired — the FIXTURE ` +
          'value above is almost certainly invalid for this field, which warn-and-drop ' +
          'discards by design. Fix the fixture, not the loader.'
        : `Field '${key}' is declared on workflowDefinitionSchema and did NOT survive ` +
          'parseWorkflow, with no warning logged. Two possible causes, likeliest first: ' +
          "(1) the field is missing from the object literal parseWorkflow returns — that's " +
          'the #2457 bug, add it there; or (2) the fixture value is invalid for a field ' +
          'that coerces silently without logging, in which case fix the fixture. Check the ' +
          'fixture value against the schema first — it is the cheaper of the two to rule out.';
      expect(fixture.present(result.workflow as WorkflowDefinition), message).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// #2637 — node-local `with:` bindings on command/script nodes, and JSON-valued
// `with:` maps. Load-time validation: shape, whole-ref grammar, upstream
// dependency, env-key uniqueness, and the ignored-elsewhere warning.
// ---------------------------------------------------------------------------

describe('node-local with: bindings (#2637)', () => {
  it('accepts and round-trips typed values and a binding directive on command and script nodes', () => {
    const { workflow } = parseWorkflowYaml(`
name: bind-ok
description: node-local bindings load and survive the transform
nodes:
  - id: producer
    prompt: emit
    output_format:
      type: object
      properties:
        green: { type: boolean }
  - id: consume
    command: review
    depends_on: [producer]
    with:
      green: $producer.output.green
      typed: 42
      guarded:
        from: $producer.output.green
        if_skipped: false
  - id: emit
    script: console.log("x")
    runtime: bun
    depends_on: [producer]
    with:
      payload: $producer.output
`);
    const consume = workflow.nodes.find(n => n.id === 'consume');
    expect(nodeWith(consume)).toEqual({
      green: '$producer.output.green',
      typed: 42,
      guarded: { from: '$producer.output.green', if_skipped: false },
    });
    const emit = workflow.nodes.find(n => n.id === 'emit');
    expect(nodeWith(emit)).toEqual({
      payload: '$producer.output',
    });
  });

  it('accepts typed JSON values on a workflow node with: map (previously a load error)', () => {
    const { workflow } = parseWorkflowYaml(`
name: typed-with
description: pure relaxation — with values are JSON now
nodes:
  - id: sub
    workflow: some-child
    with:
      flag: true
      count: 3
      tags: [a, b]
`);
    const sub = workflow.nodes.find(n => n.id === 'sub');
    expect(nodeWith(sub)).toEqual({
      flag: true,
      count: 3,
      tags: ['a', 'b'],
    });
  });

  it('rejects a binding ref to an unknown producer at load time', () => {
    const result = parseWorkflow(
      `
name: bind-unknown
description: binding names a node that does not exist
nodes:
  - id: consume
    command: review
    with:
      v: $ghost.output
`,
      'bind-unknown.yaml'
    );
    expect(result.error?.error).toContain("references unknown node '$ghost.output'");
  });

  it('rejects a binding whose producer is not an upstream dependency, naming the fix', () => {
    const result = parseWorkflow(
      `
name: bind-not-upstream
description: producer exists but there is no depends_on edge
nodes:
  - id: producer
    prompt: emit
  - id: consume
    command: review
    with:
      v: $producer.output
`,
      'bind-not-upstream.yaml'
    );
    expect(result.error?.error).toContain(
      "add 'producer' to 'consume'.depends_on so its value is produced first"
    );
  });

  it('rejects a directive whose from is not a whole ref, and enforces upstream for directive refs too', () => {
    const badFrom = parseWorkflow(
      `
name: bind-bad-from
description: from must be exactly one whole ref
nodes:
  - id: producer
    prompt: emit
  - id: consume
    command: review
    depends_on: [producer]
    with:
      v:
        from: "prefix $producer.output"
`,
      'bind-bad-from.yaml'
    );
    expect(badFrom.error?.error).toContain("'from' must be exactly one whole");

    const notUpstream = parseWorkflow(
      `
name: bind-directive-race
description: directive producer without a depends_on edge
nodes:
  - id: producer
    prompt: emit
  - id: consume
    command: review
    with:
      v:
        from: $producer.output.green
`,
      'bind-directive-race.yaml'
    );
    expect(notUpstream.error?.error).toContain("add 'producer' to 'consume'.depends_on");
  });

  it('rejects an object binding value that is not the directive shape, naming both accepted forms', () => {
    const result = parseWorkflow(
      `
name: bind-bad-object
description: plain object literals are reserved for the directive
nodes:
  - id: consume
    command: review
    with:
      v:
        some: thing
`,
      'bind-bad-object.yaml'
    );
    expect(result.error?.error).toContain('must be a binding directive');
    expect(result.error?.error).toContain('literal value');
  });

  it("rejects $LOOP_PREV in a directive's from, naming the string form that works", () => {
    // $LOOP_PREV is per-iteration text substitution, not a node ref — the directive
    // needs a producer to check for `if_skipped`. The generic grammar error would be
    // technically true and useless; the message must point at the supported spelling.
    const result = parseWorkflow(
      `
name: bind-loopprev-directive
description: directive from cannot read the previous iteration
nodes:
  - id: grp
    loop_group:
      until: DONE
      max_iterations: 3
      nodes:
        - id: gen
          prompt: Draft.
        - id: consume
          script: console.log("x")
          runtime: bun
          depends_on: [gen]
          with:
            prev:
              from: $LOOP_PREV.gen.output
              if_skipped: ''
`,
      'bind-loopprev-directive.yaml'
    );
    expect(result.error?.error).toContain("'from' cannot read '$LOOP_PREV'");
    expect(result.error?.error).toContain('prev: $LOOP_PREV.gen.output');
  });

  it('rejects two binding names that fold to one INPUTS_<UPPER_SNAKE> env key', () => {
    const result = parseWorkflow(
      `
name: bind-env-collision
description: foo-bar and foo_bar collide on INPUTS_FOO_BAR
nodes:
  - id: emit
    script: console.log("x")
    runtime: bun
    with:
      foo-bar: a
      foo_bar: b
`,
      'bind-env-collision.yaml'
    );
    expect(result.error?.error).toContain("both map to env var 'INPUTS_FOO_BAR'");
  });

  it('warns (never errors) about with: on a node type that ignores it', () => {
    const { workflow, warnings } = parseWorkflowYaml(`
name: with-ignored
description: with on bash is dropped with a visible warning
nodes:
  - id: run
    bash: echo hi
    with:
      v: x
`);
    expect(workflow.nodes).toHaveLength(1);
    expect(
      warnings.some(w => w.includes("'with' is only supported on command, script, include"))
    ).toBe(true);
  });
});

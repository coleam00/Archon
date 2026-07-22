import { describe, it, expect, beforeEach, afterEach, spyOn, mock, type Mock } from 'bun:test';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const isWindows = process.platform === 'win32';

// Inline mock logger to suppress noisy output during tests
const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
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
import { isBashNode, isCancelNode, isLoopNode } from './schemas';
import * as bundledDefaults from './defaults/bundled-defaults';

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

    it('should parse valid DAG workflow YAML', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const validYaml = `name: test-workflow
description: A test workflow
provider: claude
nodes:
  - id: plan
    command: plan
  - id: implement
    command: implement
    depends_on: [plan]
`;
      await writeFile(join(workflowDir, 'test.yaml'), validYaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows).toHaveLength(1);
      expect(workflows[0].name).toBe('test-workflow');
      expect(workflows[0].description).toBe('A test workflow');
      expect(workflows[0].provider).toBe('claude');
      expect(workflows[0].nodes).toHaveLength(2);
      expect(workflows[0].nodes[0].id).toBe('plan');
      expect(workflows[0].nodes[1].id).toBe('implement');
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

    it('should accept any model string with a known provider (SDK validates at run time)', async () => {
      // Whatever the user wrote in `model:` passes through to the SDK; the
      // SDK is the source of truth for what model strings exist. Errors
      // surface at run time, not load time.
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const yaml = `name: any-model
description: Any model string with a known provider
provider: claude
model: claude-opus-4-7[1m]
nodes:
  - id: test
    command: test
`;
      await writeFile(join(workflowDir, 'any-model.yaml'), yaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(result.errors).toHaveLength(0);
      expect(workflows).toHaveLength(1);
      expect(workflows[0].provider).toBe('claude');
      expect(workflows[0].model).toBe('claude-opus-4-7[1m]');
    });

    it('should parse codex options fields (and ignore the removed additionalDirectories field)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      // additionalDirectories was a dead workflow-level field (parsed but never
      // consumed by the DAG executor) — it has been removed. A YAML that still
      // declares it must load fine, with the field simply ignored.
      const yaml = `name: codex-options
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
`;
      await writeFile(join(workflowDir, 'options.yaml'), yaml);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows).toHaveLength(1);
      expect(workflows[0].modelReasoningEffort).toBe('medium');
      expect(workflows[0].webSearchMode).toBe('live');
      // The removed field is not carried onto the workflow object.
      expect((workflows[0] as Record<string, unknown>).additionalDirectories).toBeUndefined();
    });

    it('should round-trip workflow-level effort/thinking/fallbackModel/betas/sandbox', async () => {
      // Regression: these 5 workflow-level fields are declared on
      // workflowBaseSchema and consumed by the DAG executor's workflowLevelOptions
      // (the object literal at the top of executeDagWorkflow), but the loader's
      // manual workflow constructor used to silently drop them. YAML → loader →
      // executor would lose the workflow-level defaults, so a node without its own
      // value never inherited them. See `dag-executor.test.ts`
      // "forwards workflow-level effort to node when no per-node override" — that
      // test passes because it bypasses the loader.
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: defaults
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
`;
      await writeFile(join(workflowDir, 'defaults.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const wf = result.workflows[0].workflow as {
        effort?: unknown;
        thinking?: unknown;
        fallbackModel?: unknown;
        betas?: unknown;
        sandbox?: unknown;
      };
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

    it('should accept the thinking string shorthand at the workflow level', async () => {
      // thinkingConfigSchema preprocesses 'enabled' → { type: 'enabled' }. The
      // round-trip test covers the object form; this covers the shorthand path.
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: thinking-shorthand
description: thinking as a bare string
thinking: enabled
nodes:
  - id: only
    prompt: p
`;
      await writeFile(join(workflowDir, 'ts.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const wf = result.workflows[0].workflow as { thinking?: unknown };
      expect(wf.thinking).toEqual({ type: 'enabled' });
    });

    it('should trim surrounding whitespace from workflow-level fallbackModel', async () => {
      // The inline trim (rather than safeParse) exists specifically so a stray
      // surrounding space is normalised rather than rejected.
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: fm-trim
description: fallbackModel with whitespace
fallbackModel: '  claude-haiku-4-5  '
nodes:
  - id: only
    prompt: p
`;
      await writeFile(join(workflowDir, 'fm.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const wf = result.workflows[0].workflow as { fallbackModel?: unknown };
      expect(wf.fallbackModel).toBe('claude-haiku-4-5');
    });

    it('should trim and filter empty strings out of workflow-level betas', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: beta-trim
description: betas with whitespace
betas:
  - '  alpha  '
  - ''
  - 'beta'
nodes:
  - id: only
    prompt: p
`;
      await writeFile(join(workflowDir, 't.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const wf = result.workflows[0].workflow as { betas?: unknown };
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

    it('should handle workflow with all optional fields', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      const fullWorkflow = `name: full-workflow
description: A workflow with all fields
provider: codex
model: gpt-4
nodes:
  - id: step-one
    command: step-one
  - id: step-two
    command: step-two
    depends_on: [step-one]
`;
      await writeFile(join(workflowDir, 'full.yaml'), fullWorkflow);

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const workflows = result.workflows.map(ws => ws.workflow);

      expect(workflows).toHaveLength(1);
      expect(workflows[0].provider).toBe('codex');
      expect(workflows[0].model).toBe('gpt-4');
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
      expect(workflows[0].nodes[0].id).toBe('persist');
      expect(workflows[0].nodes[0].always_run).toBe(true);
      expect(workflows[0].nodes[1].always_run).toBeUndefined();
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

    it('does NOT descend past 1 level of subfolders (rejects workflows/a/b/foo.yaml)', async () => {
      const nestedDir = join(homeDir, 'workflows', 'a', 'b');
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
      expect(wf.nodes).toBeDefined();

      expect(wf.nodes).toHaveLength(2);
      expect(isBashNode(wf.nodes[0])).toBe(true);
      if (isBashNode(wf.nodes[0])) {
        expect(wf.nodes[0].bash).toBe('echo hello');
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
      expect(wf.nodes).toBeDefined();
      if (isBashNode(wf.nodes[0])) {
        expect(wf.nodes[0].timeout).toBe(30000);
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
      expect(wf.nodes).toBeDefined();
      expect(wf.nodes[0].idle_timeout).toBe(1800000);
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
      expect(wf.nodes).toBeDefined();
      expect(wf.nodes[0].idle_timeout).toBe(600000);
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
      expect(wf.nodes).toBeDefined();
      if (isBashNode(wf.nodes[0])) {
        expect(wf.nodes[0].idle_timeout).toBe(900000);
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
      expect(wf.nodes).toBeDefined();
      // AI fields should NOT appear on the parsed bash node
      const node = wf.nodes[0];
      expect(isBashNode(node)).toBe(true);
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

      (mockLogger.warn as Mock<() => undefined>).mockClear();
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);

      const node = result.workflows[0].workflow.nodes[0];
      expect(isLoopNode(node)).toBe(true);

      // model and provider should NOT trigger a warning
      const warnCalls = (mockLogger.warn as Mock<() => undefined>).mock.calls;
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
    output_format:
      type: object
      properties:
        status:
          type: string
`
      );

      (mockLogger.warn as Mock<() => undefined>).mockClear();
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);

      // Should warn about output_format but NOT about model
      const warnCalls = (mockLogger.warn as Mock<() => undefined>).mock.calls;
      const aiFieldWarnings = warnCalls.filter(
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

      (mockLogger.warn as Mock<() => undefined>).mockClear();
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);

      const node = result.workflows[0].workflow.nodes[0];
      expect(isLoopNode(node)).toBe(true);
      expect((node as typeof node & { pi?: unknown }).pi).toEqual({
        interactive: false,
        extensionFlags: { plan: false },
      });

      const warnCalls = (mockLogger.warn as Mock<() => undefined>).mock.calls;
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
    when: "$classify.output == 'BUG'"
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
    when: "$step1.output == 'go'"
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

    it('should ignore $nodeId.output inside fenced code blocks in prompt: bodies', async () => {
      // Prompt bodies often embed fenced documentation examples for the LLM
      // (e.g. workflow-builder shows how to author a script node). The literal
      // $other-node.output in such a fence is documentation, not a real ref.
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
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
    });

    it('should ignore $nodeId.output inside inline backtick code in prompt: bodies', async () => {
      // Inline `code` mentions like \`$nodeId.output\` are also documentation.
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
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
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

    it('should ignore $nodeId.output inside fenced code in loop.prompt', async () => {
      // Loop prompts get the same documentation-stripping treatment as node prompts.
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
      expect(wf.nodes[0].retry).toEqual({ max_attempts: 2 });
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
      if (isBashNode(wf.nodes[0])) {
        expect(wf.nodes[0].retry).toEqual({
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
      expect(wf.nodes[0].retry).toEqual({
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
      expect(wf.nodes[0].retry).toEqual({ max_attempts: 1 });
      expect(wf.nodes[0].retry?.delay_ms).toBeUndefined();
      expect(wf.nodes[0].retry?.on_error).toBeUndefined();
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
      expect(wf.nodes).toBeDefined();

      expect(wf.nodes).toHaveLength(1);
      expect(isLoopNode(wf.nodes[0])).toBe(true);
      if (isLoopNode(wf.nodes[0])) {
        expect(wf.nodes[0].loop.prompt).toContain('Do one task');
        expect(wf.nodes[0].loop.until).toBe('COMPLETE');
        expect(wf.nodes[0].loop.max_iterations).toBe(10);
        expect(wf.nodes[0].loop.fresh_context).toBe(true);
        expect(wf.nodes[0].loop.until_bash).toBe('test -f done.txt');
        expect(wf.nodes[0].idle_timeout).toBe(300000);
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
      expect(wf.nodes).toBeDefined();
      expect(isLoopNode(wf.nodes[0])).toBe(true);
      if (isLoopNode(wf.nodes[0])) {
        expect(wf.nodes[0].loop.fresh_context).toBe(false);
        expect(wf.nodes[0].loop.until_bash).toBeUndefined();
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

    it('should reject loop node missing loop.until', async () => {
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
      expect(result.errors[0].error).toContain('loop.until');
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
      expect(wf.nodes).toBeDefined();
      expect(wf.nodes).toHaveLength(2);
      expect(isLoopNode(wf.nodes[1])).toBe(true);
      if (isLoopNode(wf.nodes[1])) {
        expect(wf.nodes[1].depends_on).toEqual(['setup']);
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
      if (isLoopNode(result.workflows[0].workflow.nodes[0])) {
        expect(result.workflows[0].workflow.nodes[0].loop.interactive).toBe(true);
        expect(result.workflows[0].workflow.nodes[0].loop.gate_message).toBe('Review and respond.');
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

    it('should warn when interactive loop node is in a non-interactive workflow', async () => {
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
      // Workflow loads successfully — this is a warning, not an error
      expect(result.errors).toHaveLength(0);
      expect(result.workflows).toHaveLength(1);
      // Logger should have been called with the warning event
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ filename: expect.stringContaining('warn-test') }),
        'interactive_loop_in_non_interactive_workflow'
      );
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

      const node = result.workflows[0].workflow.nodes[0];
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

      const node = result.workflows[0].workflow.nodes[0];
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

    it('should warn when an interactive loop_group is in a non-interactive workflow', async () => {
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
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ filename: expect.stringContaining('loop-group-gate-warn') }),
        'interactive_loop_in_non_interactive_workflow'
      );
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

    it("rejects 'with:' on a workflow node (deferred to slice 2)", async () => {
      const result = await loadOne(
        'with-reject',
        `
name: with-reject
description: with on a workflow node
nodes:
  - id: sub
    workflow: child-wf
    with:
      foo: bar
`
      );
      const err = result.errors.find(e => e.filename === 'with-reject.yaml');
      expect(err).toBeDefined();
      expect(err?.error).toContain("'with:'");
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

    it('accepts a valid fan_out node and defaults max_parallel=5, join=all_success', async () => {
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
      expect(fanOut?.join).toBe('all_success');
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

    it("accepts 'fan_out.join: first_success' (racing, PR-D)", async () => {
      const result = await loadOne(
        'fan-race',
        `
name: fan-race
description: first_success racing is supported
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
      expect(err).toBeUndefined();
      const wf = result.workflows.find(w => w.workflow.name === 'fan-race');
      const work = wf?.workflow.nodes?.find(n => n.id === 'work');
      expect((work?.fan_out as { join?: string } | undefined)?.join).toBe('first_success');
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

    it('should reject an include node inside a loop_group body', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'include-in-loop-group.yaml'),
        `
name: include-in-loop-group
description: Include nested in a loop_group body (rejected in v1)
nodes:
  - id: grp
    loop_group:
      until: DONE
      max_iterations: 3
      nodes:
        - id: bad
          include: block
`
      );

      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      const err = result.errors.find(e => e.filename === 'include-in-loop-group.yaml');
      expect(err).toBeDefined();
      expect(err?.error).toContain('loop_group');
      expect(err?.error).toContain("'include' is not supported");
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

    it('should warn when an included block drops meaningful workflow-level fields', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'gated-block.yaml'),
        `
name: gated-block
description: A block that declares workflow-level fields (dropped on inline)
provider: claude
requires: [github]
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
      expect(payload.droppedFields).toContain('provider');
      expect(payload.droppedFields).toContain('requires');
      // The always-present-but-undefined keys parseWorkflow emits are filtered out, so a
      // generic key derivation must NOT report them as dropped.
      expect(payload.droppedFields).not.toContain('model');
      expect(payload.droppedFields).not.toContain('interactive');
      // requires:[github] gets its explicit callout; no safety fields here.
      expect(payload.requiresNote).toContain('github');
      expect(payload.safetyNote).toBeUndefined();
    });

    it('should warn — with a safety callout — when a block drops mutates_checkout and sandbox', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });

      await writeFile(
        join(workflowDir, 'safety-block.yaml'),
        `
name: safety-block
description: A block declaring isolation/concurrency-safety fields
mutates_checkout: false
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
      const payload = call![0] as { droppedFields: string[]; safetyNote?: string };
      expect(payload.droppedFields).toContain('mutates_checkout');
      expect(payload.droppedFields).toContain('sandbox');
      // Explicit safety callout naming BOTH.
      expect(payload.safetyNote).toContain('mutates_checkout');
      expect(payload.safetyNote).toContain('sandbox');
    });

    it('should fail expansion when a block command file references a renamed sibling', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      const commandsDir = join(testDir, '.archon', 'commands');
      await mkdir(workflowDir, { recursive: true });
      await mkdir(commandsDir, { recursive: true });

      // Command file references a SIBLING node id that namespacing will rename.
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
      expect(result.workflows.some(w => w.workflow.name === 'cmd-parent')).toBe(false);
      const err = result.errors.find(e => e.filename === 'cmd-parent.yaml');
      expect(err?.error).toContain("command file 'blk-runner.md'");
      expect(err?.error).toContain("sibling node '$sib'");
    });

    it('should scan block command files in a configured custom command folder (config parity)', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      const customCmds = join(testDir, 'my-cmds');
      await mkdir(workflowDir, { recursive: true });
      await mkdir(customCmds, { recursive: true });

      // The command file lives ONLY in the configured custom folder, referencing a sibling.
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

      // Through discoverWorkflowsWithConfig with the custom command folder configured, the
      // scan resolves the command (config parity) and catches the sibling ref.
      const result = await discoverWorkflowsWithConfig(testDir, () =>
        Promise.resolve({
          defaults: { loadDefaultWorkflows: false },
          commands: { folder: 'my-cmds' },
        })
      );
      expect(result.workflows.some(w => w.workflow.name === 'cc-parent')).toBe(false);
      const err = result.errors.find(e => e.filename === 'cc-parent.yaml');
      expect(err?.error).toContain("sibling node '$sib'");
    });

    it('should warn (not fail) when a block command file cannot be resolved for scanning', async () => {
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
      // Unresolvable command → WARN, never a hard expansion error.
      const parentErrors = result.errors.filter(e => e.filename === 'ghost-parent.yaml');
      expect(parentErrors).toHaveLength(0);
      expect(result.workflows.some(w => w.workflow.name === 'ghost-parent')).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ include: 'g', command: 'ghost-cmd-does-not-exist-xyz' }),
        'include.command_file_unresolved_for_ref_scan'
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
      expect(wf.nodes).toHaveLength(2);
      expect(isCancelNode(wf.nodes[1])).toBe(true);
      if (isCancelNode(wf.nodes[1])) {
        expect(wf.nodes[1].cancel).toBe('Precondition failed');
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

    it('parses persist_sessions: true at workflow root', async () => {
      const workflowDir = join(testDir, '.archon', 'workflows');
      await mkdir(workflowDir, { recursive: true });
      const yaml = `name: t\ndescription: t\nprovider: claude\npersist_sessions: true\nnodes:\n  - id: planner\n    prompt: p\n`;
      await writeFile(join(workflowDir, 't.yaml'), yaml);
      const result = await discoverWorkflows(testDir, { loadDefaults: false });
      expect(result.errors).toEqual([]);
      expect(
        (result.workflows[0].workflow as { persist_sessions?: boolean }).persist_sessions
      ).toBe(true);
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
});

import { afterEach, beforeEach, expect, mock } from 'bun:test';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { clearRegistry, providerRegistry } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { removeTempTree } from '@archon/paths/test-utils';
import { discoverWorkflows as discoverWorkflowsWithProviders } from '../workflow-discovery';
import { resetLegacyHomeWarningForTests } from '../workflow-discovery/scopes';
import { parseWorkflow as parseWorkflowWithProviders, type ParseResult } from '../loader';
import { isAgentNode, isExecNode, isIncludeDirective, isWorkflowNode } from '../schemas';
import type { BindingDirective, DagNode, IncludeDirective } from '../schemas';
import type { WorkflowDefinition } from '../schemas/workflow';
import type { JsonValue } from '../output-ref';

/**
 * Shared scaffolding for the loader suites. Importing this module replaces the
 * `@archon/paths` logger with `mockLogger` and registers the built-in providers, so an
 * importing test file must start with `// @archon-test-isolated`. The loader creates its
 * logger on first use, so the mock only has to be installed before the first parse.
 */

type MockLog = (data: unknown, message?: string, ...args: unknown[]) => undefined;
export const mockLogger = {
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

// Captured before the module mock below replaces it.
const realArchonPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...realArchonPaths,
  createLogger: mock(() => mockLogger),
}));

// Provider ids are checked at parse time.
clearRegistry();
registerBuiltinProviders();

export function discoverWorkflows(
  cwd: string | null,
  options: Omit<Parameters<typeof discoverWorkflowsWithProviders>[1], 'providers'> = {}
) {
  return discoverWorkflowsWithProviders(cwd, { ...options, providers: providerRegistry });
}

export function parseWorkflow(
  content: string,
  filename: string,
  configuredEnvNames?: ReadonlySet<string>
): ParseResult {
  return parseWorkflowWithProviders(content, filename, providerRegistry, configuredEnvNames);
}

/**
 * Parse one workflow YAML directly.
 *
 * For assertions about what `parseWorkflow` PRODUCES. Discovery also runs include
 * expansion, which since #1764 collapses a workflow's node-affecting config onto its
 * own nodes and removes that workflow-level layer — so a `provider:`/`model:`/`effort:`
 * assertion made on a discovered workflow tests the expander, not the parser. Fields
 * that must survive expansion are asserted on discovery in loader.test.ts.
 */
export function parseWorkflowYaml(
  yaml: string,
  filename = 'test.yaml'
): { workflow: WorkflowDefinition; warnings: string[] } {
  const result = parseWorkflow(yaml, filename);
  expect(result.error).toBeNull();
  if (result.workflow === null) throw new Error('expected a parsed workflow');
  return { workflow: result.workflow, warnings: result.warnings };
}

/** Parse one workflow YAML that must be rejected; returns the rejection message. */
export function parseError(yaml: string, filename = 'test.yaml'): string {
  const result = parseWorkflow(yaml, filename);
  if (result.workflow !== null) throw new Error('expected the workflow to be rejected');
  return result.error.error;
}

/** Assert the workflow is rejected with a message containing (or matching) every fragment. */
export function expectRejected(yaml: string, fragments: readonly (string | RegExp)[]): void {
  const error = parseError(yaml);
  for (const fragment of fragments) {
    if (typeof fragment === 'string') expect(error).toContain(fragment);
    else expect(error).toMatch(fragment);
  }
}

/**
 * Write one workflow YAML into `<root>/.archon/workflows/`, creating the folder.
 *
 * Tests that need a tree this cannot express (an empty workflows folder, a nested
 * pack, a broken symlink, a non-YAML sibling) still write it by hand; do not grow
 * this an option at a time.
 */
export async function writeWorkflowFile(
  root: string,
  filename: string,
  yaml: string
): Promise<void> {
  const dir = join(root, '.archon', 'workflows');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), yaml);
}

/**
 * Write each `filename → yaml` into the root's workflow folder, then discover them
 * without the bundled defaults. For assertions about discovery or include expansion;
 * a single workflow's parse result belongs to `parseWorkflowYaml` or `parseError`.
 */
export async function discoverFiles(root: string, files: Record<string, string>) {
  for (const [filename, yaml] of Object.entries(files)) {
    await writeWorkflowFile(root, filename, yaml);
  }
  return discoverWorkflows(root, { loadDefaults: false });
}

/**
 * A fresh temp directory per test, with `ARCHON_HOME` pointed inside it and
 * `ARCHON_DOCKER` cleared, restored afterwards. Call inside a `describe` (or at file
 * level); returns a getter for the current test's directory.
 */
export function useTempWorkflowRoot(): () => string {
  let dir = '';
  const originalArchonHome = process.env.ARCHON_HOME;
  const originalArchonDocker = process.env.ARCHON_DOCKER;

  beforeEach(async () => {
    dir = join(tmpdir(), `workflow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    process.env.ARCHON_HOME = join(dir, 'home');
    delete process.env.ARCHON_DOCKER;
    resetLegacyHomeWarningForTests();
  });

  afterEach(async () => {
    await removeTempTree(dir);
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
    if (originalArchonDocker === undefined) delete process.env.ARCHON_DOCKER;
    else process.env.ARCHON_DOCKER = originalArchonDocker;
  });

  return () => dir;
}

/** The inline prompt text of an agent node, or undefined for any other kind. */
export function inlinePrompt(node: DagNode | IncludeDirective | undefined): string | undefined {
  return node && !isIncludeDirective(node) && isAgentNode(node) && node.source.kind === 'inline'
    ? node.source.prompt
    : undefined;
}

/** The `with:` bindings of an agent (command-sourced), exec or workflow node. */
export function nodeWith(
  node: DagNode | IncludeDirective | undefined
): Record<string, JsonValue | BindingDirective> | undefined {
  if (!node || isIncludeDirective(node)) return undefined;
  if (isExecNode(node)) return node.with;
  if (isAgentNode(node) && node.source.kind === 'command') return node.source.with;
  if (isWorkflowNode(node)) return node.with;
  return undefined;
}

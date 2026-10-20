/**
 * Lints the bundled SDLC pack against engine and provider rules. It lives in `scripts/`
 * because it reads the pack's bundled records and the engine's parser together; engine
 * tests never read the pack.
 */
import { describe, expect, it } from 'bun:test';
import { providerRegistry } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import {
  BUNDLED_WORKFLOW_OWNERS,
  BUNDLED_WORKFLOWS,
} from '../packages/workflows/src/defaults/bundled-defaults';
import { collectStrictSchemaViolations } from '../packages/workflows/src/dag/capability-preflight';
import { parseWorkflow } from '../packages/workflows/src/loader';
import type { WorkflowModelRef } from '../packages/workflows/src/schemas';

registerBuiltinProviders();

function bundledStrictSchemaViolations(content: string, name: string): string[] {
  const parsed = parseWorkflow(content, `${name}.yaml`, providerRegistry);
  if (parsed.workflow === null) throw new Error(parsed.error.error);
  return collectStrictSchemaViolations(
    providerRegistry,
    parsed.workflow.nodes,
    parsed.workflow.provider ?? 'codex'
  ).map(issue =>
    issue.kind === 'missing-properties'
      ? `${name}:${issue.nodeId} ${issue.schemaPath} missing properties`
      : `${name}:${issue.nodeId} ${issue.schemaPath} missing required keys ${issue.missing.join(', ')}`
  );
}

describe('bundled workflows', () => {
  // OpenAI Structured Outputs (the Codex provider's path) accepts only an object at a
  // schema's root, so a root union or scalar ends the node on every call there. A
  // decision with variants nests its union under a property instead.
  it('every bundled output_format has a plain object at its root', () => {
    const offenders: string[] = [];
    const visit = (workflow: string, nodes: readonly unknown[]): void => {
      for (const node of nodes as Record<string, unknown>[]) {
        const format = node.output_format as Record<string, unknown> | undefined;
        if (
          format !== undefined &&
          (format.type !== 'object' || 'anyOf' in format || 'oneOf' in format || 'allOf' in format)
        ) {
          offenders.push(`${workflow}:${String(node.id)}`);
        }
        const group = node.loop_group as { nodes?: unknown[] } | undefined;
        if (group?.nodes) visit(workflow, group.nodes);
      }
    };
    for (const [name, source] of Object.entries(BUNDLED_WORKFLOWS)) {
      const raw = Bun.YAML.parse(source) as { nodes?: unknown[] };
      visit(name, raw.nodes ?? []);
    }
    expect(offenders).toEqual([]);
  });

  it('should have valid YAML structure', () => {
    for (const content of Object.values(BUNDLED_WORKFLOWS)) {
      expect(content).toContain('name:');
      expect(content).toContain('description:');
      expect(content.includes('nodes:')).toBe(true);
    }
  });

  it.each([
    [
      'Codex group under Claude',
      'claude',
      'codex',
      ['fixture:inner output_format missing required keys note'],
    ],
    ['Claude group under Codex', 'codex', 'claude', []],
    [
      'Codex install default',
      undefined,
      undefined,
      ['fixture:inner output_format missing required keys note'],
    ],
  ])('%s', (_name, workflowProvider, groupProvider, expected) => {
    const source = `
name: fixture
description: Strict schema provider inheritance
${workflowProvider === undefined ? '' : `provider: ${workflowProvider}`}
nodes:
  - id: group
    ${groupProvider === undefined ? '' : `provider: ${groupProvider}`}
    loop_group:
      max_iterations: 1
      until_bash: "true"
      nodes:
        - id: inner
          prompt: Produce a result
          output_format:
            type: object
            properties:
              note: { type: string }
            required: []
`;
    expect(bundledStrictSchemaViolations(source, 'fixture')).toEqual(expected);
  });

  // Replaces the deleted scripts/output-format-strict.test.ts, which guarded this
  // same bundled set with a prose exemption rule for pinned providers. The engine now
  // owns the rule (launch preflight + `archon validate workflows`), and this test is
  // the CI backstop proving the shipped set stays clean. Scan under a Codex default
  // profile: an unpinned node routes to the install's default assistant, so an install
  // pinned to Codex is the reachable strict case. A node explicitly pinned to a
  // non-enforcing provider (Claude) is the documented opt-out and is skipped.
  it('every bundled workflow is compatible with Codex strict-mode schemas', () => {
    const violations: string[] = [];

    for (const [name, content] of Object.entries(BUNDLED_WORKFLOWS)) {
      violations.push(...bundledStrictSchemaViolations(content, name));
    }

    expect(violations).toEqual([]);
  });
});

// Every AI node in the SDLC pack must resolve a tier. A node that resolves none
// falls through to the install's default assistant — so a run pinned to one
// provider silently executes that node on another and spends its quota. Which
// tier a node names is an ordinary authoring choice and changes freely; that it
// resolves one at all is the invariant this protects.
//
// Node types are derived from parseWorkflow rather than restated: a hand-written
// copy of the node union would drift the moment a node kind is added.
type PackNode = NonNullable<ReturnType<typeof parseWorkflow>['workflow']>['nodes'][number];
type LoopGroupBodyNode = Extract<PackNode, { kind: 'loop_group' }>['loop_group']['nodes'][number];

describe('sdlc pack tier coverage', () => {
  it('resolves a tier for every AI node', () => {
    const uncovered: string[] = [];

    for (const [name, owner] of Object.entries(BUNDLED_WORKFLOW_OWNERS)) {
      if (owner?.pack !== 'sdlc') continue;
      const source = BUNDLED_WORKFLOWS[name];
      if (source === undefined) continue;

      const parsed = parseWorkflow(source, name, providerRegistry);
      expect(parsed.error).toBeNull();
      const workflow = parsed.workflow;
      if (workflow === null) continue;

      // Walk with the scope a node actually resolves against, mirroring the resolver:
      //  - a node's own `model:` always wins;
      //  - an inherited model reaches a node only when the node resolves to the scope's
      //    own provider (include-expander's `workflowModelTravelsTo`), so a node naming
      //    a different provider inherits nothing;
      //  - a `loop_group` becomes the scope for its body, carrying whichever model it
      //    resolved, because the executor forwards its provider, model, tier and preset
      //    into the per-iteration context.
      interface Scope {
        provider: string | undefined;
        model: WorkflowModelRef | undefined;
      }

      const visit = (
        nodes: readonly (PackNode | LoopGroupBodyNode)[],
        trail: string,
        scope: Scope
      ): void => {
        for (const node of nodes) {
          const id = `${trail}${node.id}`;
          const ownProvider = 'provider' in node ? node.provider : undefined;
          const ownModel = 'model' in node ? node.model : undefined;
          const provider = ownProvider ?? scope.provider;
          const model = ownModel ?? (provider === scope.provider ? scope.model : undefined);

          // `agent` and `loop` both invoke a provider. `loop_group` runs none itself.
          if ((node.kind === 'agent' || node.kind === 'loop') && model === undefined) {
            uncovered.push(`${name}:${id}`);
          }
          if (node.kind === 'loop_group') {
            visit(node.loop_group.nodes, `${id}/`, { provider, model });
          }
        }
      };
      visit(workflow.nodes, '', { provider: workflow.provider, model: workflow.model });
    }

    expect(uncovered).toEqual([]);
  });
});

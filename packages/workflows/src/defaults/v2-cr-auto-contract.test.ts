/**
 * RED-PHASE ACCEPTANCE SCAFFOLD — Story A2.1 "Wire DS TA CR Sequence".
 *
 * Structural / contract assertions against the v2 workflow YAML on disk. These
 * tests are written BEFORE the A2.1 delta is implemented. They MUST fail now
 * (the CR node is still `code-review` invoking `bmad-code-review`, the gate enum
 * is still `[PASS, FAIL]`, and the Contract Envelope fields are absent) and pass
 * once the dev renames the CR node to `code-review-auto`, retargets it at
 * `bmad-code-review-auto`, extends the gate enum, adds the envelope fields, and
 * regenerates the bundled defaults.
 *
 * This file deliberately does NOT use mock.module(). It only parses YAML from
 * disk, so it belongs in the same no-mock bun-test batch as
 * v2-workflow-baseline.test.ts. Do not co-locate it with a mock.module() file.
 *
 * Covers (executable red): AC1 (node id, command target, output_type, gate enum,
 * envelope fields, JSON-only routing), reviewer concerns (comment policy,
 * baseline additivity), first-party consumer surface (loader validation ≙
 * `cli validate workflows`).
 * Covers (skipped scaffold): SKIP-1 real `bmad-code-review-auto` command exists.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { isRegisteredProvider, registerBuiltinProviders } from '@archon/providers';
import { parseWorkflow } from '../loader';
import type { WorkflowDefinition, DagNode } from '../schemas';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.archon/workflows/defaults');

const V1_STEM = 'bmad-dev-story-with-tea-fix-loop';
const V2_STEM = 'bmad-dev-story-with-tea-fix-loop-v2';
const V1_FILE = join(WORKFLOWS_DIR, `${V1_STEM}.yml`);
const V2_FILE = join(WORKFLOWS_DIR, `${V2_STEM}.yml`);

const readLF = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, 'utf-8').replace(/\r\n/g, '\n') : null;

const parseFromDisk = (path: string, stem: string): WorkflowDefinition => {
  const content = readLF(path);
  expect(content, `expected workflow file to exist on disk: ${path}`).not.toBeNull();
  const result = parseWorkflow(content as string, `${stem}.yml`);
  expect(result.error, `parseWorkflow reported: ${result.error?.error ?? 'none'}`).toBeNull();
  return result.workflow as WorkflowDefinition;
};

const nodeById = (wf: WorkflowDefinition, id: string): DagNode | undefined =>
  wf.nodes.find(n => n.id === id);

interface OutputFormat {
  type?: string;
  required?: string[];
  properties?: Record<string, { type?: string; enum?: string[] }>;
}

describe('A2.1 — CR auto surface + contract envelope (v2 YAML structural red)', () => {
  // parseWorkflow validates `provider:` against the registry; v2 uses codex+claude.
  // Register idempotently WITHOUT clearRegistry() — this file shares a process
  // with the no-mock defaults batch; clearing would corrupt sibling tests.
  beforeAll(() => {
    if (!isRegisteredProvider('codex')) {
      try {
        registerBuiltinProviders();
      } catch {
        // Another test in the batch already registered builtins — fine.
      }
    }
  });

  // ── AC1: CR invokes the BMAD-METHOD auto surface ─────────────────────────
  describe('AC1 — CR node targets bmad-code-review-auto and emits a JSON contract', () => {
    it('AC1.1 [P0] the CR node is renamed `code-review-auto` (old `code-review` id is gone)', () => {
      // RED: v2 currently has `id: code-review`. Task 1.1 renames it so the
      // typed contract + sidecar align with `code-review-auto.gate.json`.
      const v2 = parseFromDisk(V2_FILE, V2_STEM);
      expect(nodeById(v2, 'code-review-auto'), 'expected a code-review-auto node').toBeDefined();
      expect(
        nodeById(v2, 'code-review'),
        'old code-review node id must be removed'
      ).toBeUndefined();
    });

    it('AC1.2 [P0] the CR node invokes the `bmad-code-review-auto` command (not the interactive review)', () => {
      // RED: currently `command: bmad-code-review`. Task 1.2 retargets it at the
      // non-interactive auto surface that emits the machine-readable gate.
      const v2 = parseFromDisk(V2_FILE, V2_STEM);
      const cr = nodeById(v2, 'code-review-auto');
      expect(cr, 'code-review-auto node must exist').toBeDefined();
      expect('command' in cr!, 'CR node must remain a command node').toBe(true);
      expect((cr as { command: string }).command).toBe('bmad-code-review-auto');
    });

    it('AC1.3 [P1] the CR node declares `output_type: code-review-auto` (typed sidecar for downstream discovery)', () => {
      // RED: currently `output_type: code-review-findings`. Task 1.3 renames it so
      // A3's gate-planner can locate the CR evidence by type.
      const v2 = parseFromDisk(V2_FILE, V2_STEM);
      const cr = nodeById(v2, 'code-review-auto');
      expect((cr as unknown as { output_type?: string })?.output_type).toBe('code-review-auto');
    });

    it('AC1.4 [P0] the gate enum is the routing vocabulary [PASS, FAIL, CONCERNS, ERROR] (SKIPPED omitted)', () => {
      // RED: currently enum is ["PASS", "FAIL"]. Task 2.1 extends it to the
      // routing subset of the Contract Envelope gate vocabulary. CR never emits
      // SKIPPED, so it is intentionally excluded.
      const v2 = parseFromDisk(V2_FILE, V2_STEM);
      const cr = nodeById(v2, 'code-review-auto');
      expect(
        cr,
        'code-review-auto node must exist before its gate enum can be extended'
      ).toBeDefined();
      const of = cr!.output_format as OutputFormat;
      const gateEnum = of.properties?.gate?.enum ?? [];
      expect([...gateEnum].sort()).toEqual(['CONCERNS', 'ERROR', 'FAIL', 'PASS']);
      expect(gateEnum, 'CR does not emit SKIPPED — it must not be in the enum').not.toContain(
        'SKIPPED'
      );
    });

    it('AC1.5 [P0] the Contract Envelope fields are present; contract_version is required; existing required fields retained', () => {
      // RED: v2 output_format has none of contract_version/workflow/node. Task 2.2
      // adds them (contract_version required) WITHOUT removing existing fields.
      const v2 = parseFromDisk(V2_FILE, V2_STEM);
      const cr = nodeById(v2, 'code-review-auto');
      expect(
        cr,
        'code-review-auto node must exist before envelope fields can be asserted'
      ).toBeDefined();
      const of = cr!.output_format as OutputFormat;

      for (const field of ['contract_version', 'workflow', 'node']) {
        expect(of.properties, `envelope field ${field} must be declared`).toHaveProperty(field);
      }
      expect(of.required, 'contract_version must be required').toContain('contract_version');

      // Existing required fields must survive the envelope extension (no removals).
      for (const field of ['gate', 'round', 'findings_count', 'story_ref', 'code_review_report']) {
        expect(of.required, `existing required field ${field} must be retained`).toContain(field);
      }
    });

    it('AC1.6 [P0] downstream routing reads ONLY JSON contract fields — the identity guard never parses the markdown report', () => {
      // A-AD-2 invariant: markdown is evidence, not a routing input. verify-story-identity
      // must read $code-review-auto.output.{gate,story_ref} and must NOT reference the
      // markdown report field (`code_review_report`) or a `.md` file for routing.
      // RED: guard currently references `$code-review.output.*` (old id).
      const v2 = parseFromDisk(V2_FILE, V2_STEM);
      const guard = nodeById(v2, 'verify-story-identity');
      expect(guard, 'verify-story-identity must exist').toBeDefined();
      const bash = (guard as { bash: string }).bash;

      expect(bash, 'guard must read the CR JSON gate field by the new node id').toContain(
        '$code-review-auto.output.gate'
      );
      expect(bash, 'guard must read the CR JSON story_ref field by the new node id').toContain(
        '$code-review-auto.output.story_ref'
      );
      expect(bash, 'guard must not reference the old code-review node id').not.toContain(
        '$code-review.output'
      );
      expect(bash, 'guard must not route on the markdown report field').not.toContain(
        'code_review_report'
      );
    });

    it('AC1 — the CR gate route depends on the renamed node id', () => {
      // Task 1.5: verify-story-identity.depends_on must reference code-review-auto,
      // not the removed code-review id. RED until the rename lands.
      const v2 = parseFromDisk(V2_FILE, V2_STEM);
      const guard = nodeById(v2, 'verify-story-identity');
      const deps = (guard as { depends_on: string[] }).depends_on;
      expect(deps).toContain('code-review-auto');
      expect(deps).not.toContain('code-review');
    });

    it.skip('SKIP-1 [P0] a real `bmad-code-review-auto` command file exists on disk (cross-project dep M1.1)', () => {
      // SKIPPED: BLOCKER-1 — BMAD-METHOD has not yet shipped `bmad-code-review-auto`.
      // A repo-wide search found only the interactive `bmad-code-review`. The story
      // wires the node + contract + routing against a fixture-mocked command stub
      // (dev path b). ACTIVATE this test once the upstream command lands at
      // .archon/commands/defaults/bmad-code-review-auto.md (or a
      // .agents/skills/bmad-code-review-auto/ skill), then unskip and assert the
      // command file resolves and declares the gate contract. Until then, invoking
      // the real BMAD review surface is unverifiable in-repo.
      const cmd = join(REPO_ROOT, '.archon/commands/defaults/bmad-code-review-auto.md');
      expect(existsSync(cmd), 'bmad-code-review-auto command must exist once M1.1 ships').toBe(
        true
      );
    });
  });

  // ── Reviewer concerns ────────────────────────────────────────────────────
  describe('Reviewer concerns — comment policy, baseline additivity, CLI validation', () => {
    it('CONCERN-1 [P1] v2 YAML carries no plan-artifact references (code-comment policy)', () => {
      // Repo rule: no story ids / requirement codes / epic labels / cross-project
      // codes in shipped YAML. Task 3.3 comment must explain the invariant, not the
      // plan. This locks the rename + new inline comment against leakage.
      const content = readLF(V2_FILE);
      expect(content, `expected v2 file to exist: ${V2_FILE}`).not.toBeNull();
      const forbidden = [
        /\bA-FR-\d/i,
        /\bA-AD-\d/i,
        /\bA2\.\d/,
        /\bepic\s+a\d/i,
        /\bM1\.\d/,
        /\bF\d{1,2}\b/,
      ];
      for (const pattern of forbidden) {
        expect(content as string, `forbidden plan reference ${pattern}`).not.toMatch(pattern);
      }
    });

    it('CONCERN-2 [P0] the v1 baseline has NO code-review-auto node (additivity — v2 delta must not leak into baseline)', () => {
      // In-process proxy for the byte-for-byte baseline-immutability git-diff gate
      // (see WAIVER-2). Baseline keeps its own `code-review` route_loop and must
      // never grow the auto surface.
      const v1 = parseFromDisk(V1_FILE, V1_STEM);
      expect(nodeById(v1, 'code-review-auto'), 'baseline must not contain code-review-auto').toBe(
        undefined
      );
      expect(
        nodeById(v1, 'code-review'),
        'baseline retains its original code-review node'
      ).toBeDefined();
    });

    it('CONS-1 [P0] v2 passes loader schema + DAG + route_loop validation (≙ `cli validate workflows …-v2`)', () => {
      // First-party consumer surface: `bun run cli validate workflows
      // bmad-dev-story-with-tea-fix-loop-v2` wraps exactly this loader path
      // (schema, provider identity, dup-id/cycle/$node.output ref, route_loop
      // structural checks). Asserting parseWorkflow error===null in-process is the
      // deterministic equivalent. RED while the CR rename produces dangling
      // $code-review.output refs (verify-story-identity → OutputRefError at load).
      const content = readLF(V2_FILE);
      expect(content, `expected v2 file to exist: ${V2_FILE}`).not.toBeNull();
      const result = parseWorkflow(content as string, `${V2_STEM}.yml`);
      expect(
        result.error,
        `loader validation must pass: ${result.error?.error ?? 'none'}`
      ).toBeNull();
      expect((result.workflow as WorkflowDefinition).nodes.length).toBeGreaterThan(0);
    });
  });
});

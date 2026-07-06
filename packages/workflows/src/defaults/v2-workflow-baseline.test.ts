import { describe, it, expect, beforeAll } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { isRegisteredProvider, registerBuiltinProviders } from '@archon/providers';
import { BUNDLED_WORKFLOWS } from './bundled-defaults';
import { parseWorkflow } from '../loader';
import { resolveWorkflowName } from '../router';
import { discoverWorkflows } from '../workflow-discovery';
import type { WorkflowDefinition } from '../schemas';

// RED-PHASE ACCEPTANCE SCAFFOLD — Story a1.1 "Add Versioned V2 Workflow Baseline".
// These tests are written BEFORE the v2 workflow exists. They MUST fail now
// (the -v2 file/registry entry is absent) and pass once the dev copies the
// baseline to bmad-dev-story-with-tea-fix-loop-v2.yml, renames only `name` +
// distinguishing description, and regenerates the bundled defaults.
//
// Resolve on-disk defaults dir relative to this file: from
// packages/workflows/src/defaults go up four levels to repo root, then .archon/.
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.archon/workflows/defaults');

const V1_STEM = 'bmad-dev-story-with-tea-fix-loop';
const V2_STEM = 'bmad-dev-story-with-tea-fix-loop-v2';
const V1_FILE = join(WORKFLOWS_DIR, `${V1_STEM}.yml`);
const V2_FILE = join(WORKFLOWS_DIR, `${V2_STEM}.yml`);

const readLF = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, 'utf-8').replace(/\r\n/g, '\n') : null;

/** Parse a workflow definition from disk, asserting it loads cleanly. */
const parseFromDisk = (path: string, stem: string): WorkflowDefinition => {
  const content = readLF(path);
  expect(content, `expected workflow file to exist on disk: ${path}`).not.toBeNull();
  const result = parseWorkflow(content as string, `${stem}.yml`);
  expect(result.error, `parseWorkflow reported: ${result.error?.error ?? 'none'}`).toBeNull();
  return result.workflow as WorkflowDefinition;
};

describe('v2 workflow baseline (Story a1.1)', () => {
  // parseWorkflow validates `provider:` against the global provider registry.
  // The baseline uses `codex` + `claude`, so builtins must be registered.
  // Register idempotently WITHOUT clearRegistry() — this file shares a process
  // with other workflows tests (the `src/defaults/` glob batch); clearing would
  // corrupt their registry state.
  beforeAll(() => {
    if (!isRegisteredProvider('codex')) {
      try {
        registerBuiltinProviders();
      } catch {
        // Another test in the batch already registered builtins — fine.
      }
    }
  });

  // ── AC1: Additive v2 surface, baseline untouched ─────────────────────────
  describe('AC1 — additive v2 surface, baseline untouched', () => {
    it('S1.1 [P0] the v2 workflow file exists at the default workflows path', () => {
      // RED: the -v2.yml file does not exist yet. Implementation creates it as a
      // faithful copy of the baseline under .archon/workflows/defaults/.
      expect(existsSync(V2_FILE)).toBe(true);
    });

    it('S1.2 [P0] the v1 baseline still exists with its name unchanged (regression guard)', () => {
      // Byte-for-byte equality of the baseline is enforced by the `git diff`
      // gate (see waiver W1). This guard catches structural/name drift in-process.
      const v1 = parseFromDisk(V1_FILE, V1_STEM);
      expect(v1.name).toBe(V1_STEM);
    });

    it('S1.3 [P0] v2 carries a UNIQUE name and resolves without ambiguity', () => {
      // CRITICAL constraint: a duplicated `name:` does not collide in discovery
      // (keyed by filename) but makes resolveWorkflowName() throw "Ambiguous
      // workflow" at invocation. v2 must rename only the `name` field to -v2.
      const v1 = parseFromDisk(V1_FILE, V1_STEM);
      const v2 = parseFromDisk(V2_FILE, V2_STEM);

      expect(v2.name).toBe(V2_STEM);
      expect(v2.name).not.toBe(v1.name);

      const all: WorkflowDefinition[] = [v1, v2];
      // Each name resolves to its own workflow; neither invocation is ambiguous.
      expect(resolveWorkflowName(V1_STEM, all)).toBe(v1);
      expect(resolveWorkflowName(V2_STEM, all)).toBe(v2);
      expect(() => resolveWorkflowName(V2_STEM, all)).not.toThrow();
    });

    it('S1.4 [P1] v2 description distinguishes it as the v2 redesign variant', () => {
      // Keeps the NL router and `/workflow list` able to tell v1 from v2. The
      // baseline description contains no "v2" marker, so a verbatim copy fails
      // this until the description is updated.
      const v2 = parseFromDisk(V2_FILE, V2_STEM);
      expect(v2.description.toLowerCase()).toContain('v2');
    });

    it('S1.5 [P1] v2 YAML contains no plan-artifact references (code-comment policy)', () => {
      // Reviewer concern: no story ids / requirement codes / epic labels in the
      // shipped YAML. A faithful copy of the baseline already satisfies this;
      // this test locks it against accidental leakage during the rename.
      const content = readLF(V2_FILE);
      expect(content, `expected v2 file to exist: ${V2_FILE}`).not.toBeNull();
      const forbidden = [/\bA-FR-\d/i, /\bA-AD-\d/i, /\bA1\.\d/, /\bepic\s+a\d/i];
      for (const pattern of forbidden) {
        expect(content as string).not.toMatch(pattern);
      }
    });
  });

  // ── AC2: Discoverable via the same default path, source ↔ bundled consistent ─
  describe('AC2 — discoverable + source↔bundled consistent', () => {
    it('S2.1 [P0] BUNDLED_WORKFLOWS contains the v2 key (bundle not stale)', () => {
      // RED until `bun run generate:bundled` embeds the v2 YAML. The v1 entry
      // must remain present alongside it.
      expect(Object.keys(BUNDLED_WORKFLOWS)).toContain(V2_STEM);
      expect(Object.keys(BUNDLED_WORKFLOWS)).toContain(V1_STEM);
    });

    it('S2.2 [P0] bundled v2 content is byte-identical (LF) to the on-disk v2 file', () => {
      // The `check:bundled` gate asserts this across all defaults; this pins it
      // to v2 specifically for traceability.
      const disk = readLF(V2_FILE);
      expect(disk, `expected v2 file to exist: ${V2_FILE}`).not.toBeNull();
      expect(BUNDLED_WORKFLOWS[V2_STEM]).toBe(disk as string);
    });

    it('S2.3 [P0] discovery surfaces v2 via the default path, v1 still discoverable', async () => {
      // Exercises the real runtime discovery path (default workflows only).
      const result = await discoverWorkflows(null, { loadDefaults: true });
      const names = result.workflows.map(w => w.workflow.name);
      expect(names).toContain(V2_STEM);
      expect(names).toContain(V1_STEM);
    });
  });

  // ── AC3: Schema + DAG validation passes ──────────────────────────────────
  describe('AC3 — schema + DAG validation passes', () => {
    it('S3.1 [P0] v2 passes schema + DAG structural validation via parseWorkflow', () => {
      // parseWorkflow runs the same schema, provider-identity, DAG (dup ids,
      // unknown depends_on, cycles, $node.output refs) and route_loop structural
      // checks the loader enforces. A faithful copy must load with error: null.
      const content = readLF(V2_FILE);
      expect(content, `expected v2 file to exist: ${V2_FILE}`).not.toBeNull();
      const result = parseWorkflow(content as string, `${V2_STEM}.yml`);
      expect(result.error).toBeNull();
      expect((result.workflow as WorkflowDefinition).nodes.length).toBeGreaterThan(0);
    });

    it('S3.2 [P0] v2 node topology is a faithful copy of the baseline (only name/description differ)', () => {
      // The redesigned DAG (gate-planner, tea-*-skipped, quality-gate-summary,
      // decision-needed-check, code-review-auto) is explicitly out of scope for
      // this story. v2 must be structurally identical to v1 for now.
      const v1 = parseFromDisk(V1_FILE, V1_STEM);
      const v2 = parseFromDisk(V2_FILE, V2_STEM);

      // Nodes (ids, depends_on edges, route_loop, provider/model per node) verbatim.
      expect(JSON.stringify(v2.nodes)).toBe(JSON.stringify(v1.nodes));
      // Top-level provider/model/tags unchanged; only name (+ description) differ.
      expect(v2.provider).toBe(v1.provider);
      expect(v2.model).toBe(v1.model);
      expect(JSON.stringify(v2.tags)).toBe(JSON.stringify(v1.tags));
    });

    it('S3.3 [P1] v2 uses only literal models — no @custom alias refs (bundled portability)', () => {
      // Bundled/global workflows may not use @custom alias model refs. A faithful
      // copy of the literal-model baseline satisfies this; guard against drift.
      const content = readLF(V2_FILE);
      expect(content, `expected v2 file to exist: ${V2_FILE}`).not.toBeNull();
      expect(content as string).not.toMatch(/model:\s*['"]?@/);
    });
  });
});

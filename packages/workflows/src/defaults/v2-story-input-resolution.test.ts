import { describe, it, expect, beforeAll } from 'bun:test';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isRegisteredProvider, registerBuiltinProviders } from '@archon/providers';
import { parseWorkflow } from '../loader';
import type { WorkflowDefinition } from '../schemas';

// =============================================================================
// RED-PHASE ACCEPTANCE SCAFFOLD — Story a1.2 "Preserve Story Input Resolution".
//
// Written BEFORE the implementation. The two new nodes (`resolve-story-input`,
// `verify-story-identity`) and the `story_ref` contract field do NOT exist yet,
// so the executable tests below MUST fail now and go green once the dev:
//   1. adds the `resolve-story-input` bash node before `dev-story`,
//   2. adds `story_ref` (required) to `code-review` `output_format` + pins the
//      value verbatim to `$resolve-story-input.output.story_ref`,
//   3. adds the `verify-story-identity` guard node,
//   4. reruns `bun run generate:bundled`.
//
// LEVELS (project-real, per test-design-a1-2):
//   STR  — parseWorkflow() on on-disk v2 YAML  (boundary EXISTS → executable red)
//   BASH — Bun.spawnSync(['bash','-c', <node body>]) with temp sprint-status
//          fixtures (boundary EXISTS → executable red; body extracted from the
//          node so the SHIPPED logic is what runs — zero copy drift)
//   DAG  — dag-executor with mocked providers (harness does NOT exist in this
//          package → SKIPPED scaffolds at the bottom, with activation notes)
//
// This file deliberately uses NO `mock.module()` — it runs real bash via
// Bun.spawnSync — so it is safe to run inside the existing `src/defaults/` test
// batch without mock-pollution (addresses R-009 / REG-A6-5 by construction).
// =============================================================================

// packages/workflows/src/defaults → up four levels to repo root, then .archon/.
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.archon/workflows/defaults');
const V2_STEM = 'bmad-dev-story-with-tea-fix-loop-v2';
const V2_FILE = join(WORKFLOWS_DIR, `${V2_STEM}.yml`);

// Canonical story_ref = sprint-status KEY (OQ4 locked). Its epic.story id = a1.2.
const CANONICAL_KEY = 'a1-2-preserve-story-input-resolution';

// Substitution tokens the guard body is expected to carry verbatim; the engine
// replaces `$<node>.output.<field>` before execution (executor-shared subst).
const RESOLVED_TOKEN = '$resolve-story-input.output.story_ref';
const CONTRACT_TOKEN = '$code-review-auto.output.story_ref';
const GATE_TOKEN = '$code-review-auto.output.gate';
const CONTRACT_VERSION_TOKEN = '$code-review-auto.output.contract_version';
const CONTRACT_WORKFLOW_TOKEN = '$code-review-auto.output.workflow';
const CONTRACT_NODE_TOKEN = '$code-review-auto.output.node';

const readLF = (p: string): string | null =>
  existsSync(p) ? readFileSync(p, 'utf-8').replace(/\r\n/g, '\n') : null;

/** Narrow view over a DAG node — DagNode is a union; this avoids `any`. */
type AnyNode = {
  id: string;
  bash?: string;
  prompt?: string;
  command?: string;
  depends_on?: string[];
  trigger_rule?: string;
  output_format?: Record<string, unknown>;
  output_type?: string;
  prompt_suffix?: string;
  route_loop?: { from?: string; condition?: string; routes?: Record<string, string> };
};

function loadV2(): WorkflowDefinition {
  const content = readLF(V2_FILE);
  expect(content, `expected v2 workflow on disk: ${V2_FILE}`).not.toBeNull();
  const result = parseWorkflow(content as string, `${V2_STEM}.yml`);
  expect(result.error, `parseWorkflow reported: ${result.error?.error ?? 'none'}`).toBeNull();
  return result.workflow as WorkflowDefinition;
}

function nodes(wf: WorkflowDefinition): AnyNode[] {
  return wf.nodes as unknown as AnyNode[];
}

function getNode(wf: WorkflowDefinition, id: string): AnyNode | undefined {
  return nodes(wf).find(n => n.id === id);
}

// --- Real-bash execution seam (boundary exists TODAY) ------------------------

interface BashResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runBash(
  script: string,
  opts: { env?: Record<string, string>; cwd?: string } = {}
): BashResult {
  const proc = Bun.spawnSync(['bash', '-c', script], {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

// Real development_status block: 11 story + 6 epic + 6 retrospective keys, so
// the exclusion filter (epic-*/*-retrospective) and prefix-collision (a1 →
// a1-1 AND a1-2) cases are exercised against a realistic fixture.
const REAL_DEV_STATUS = `development_status:
  epic-a1: in-progress
  a1-1-add-versioned-v2-workflow-baseline: done
  a1-2-preserve-story-input-resolution: ready-for-dev
  epic-a1-retrospective: optional
  epic-a2: backlog
  a2-1-wire-ds-ta-cr-sequence: backlog
  epic-a2-retrospective: optional
  epic-a3: backlog
  a3-1-add-gate-planner-flags: backlog
  a3-2-wire-rv-and-nr-sibling-branches: backlog
  a3-3-join-tr-as-final-gate: backlog
  epic-a3-retrospective: optional
  epic-a4: backlog
  a4-1-aggregate-quality-gate-summary: backlog
  a4-2-route-quality-loop-and-error-paths: backlog
  epic-a4-retrospective: optional
  epic-a5: backlog
  a5-1-orchestrate-decision-needed-follow-up: backlog
  a5-2-generate-pr-handoff-with-evidence-links: backlog
  epic-a5-retrospective: optional
  epic-a6: backlog
  a6-1-validate-the-vertical-slice: backlog
  epic-a6-retrospective: optional
`;

/** Create a temp repo-ish cwd containing sprint-status.yaml + $ARTIFACTS_DIR. */
function makeSprintFixture(devStatusYaml: string = REAL_DEV_STATUS): {
  cwd: string;
  artifactsDir: string;
  cleanup: () => void;
} {
  const cwd = mkdtempSync(join(tmpdir(), 'a1-2-resolve-'));
  const artifactsDir = join(cwd, 'artifacts');
  mkdirSync(join(cwd, '_bmad-output', 'implementation-artifacts'), { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(
    join(cwd, '_bmad-output', 'implementation-artifacts', 'sprint-status.yaml'),
    `generated: "x"\nlast_updated: "x"\n${devStatusYaml}`
  );
  return { cwd, artifactsDir, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

/**
 * Extract and run the `resolve-story-input` node body against a fixture cwd.
 * Fails RED (node undefined) until the node exists. `$ARGUMENTS` is passed via
 * the ARGUMENTS env var (NOT template substitution — shellSafe defers it).
 */
function runResolveNode(argumentsValue: string | undefined, devStatusYaml?: string): BashResult {
  const wf = loadV2();
  const node = getNode(wf, 'resolve-story-input');
  expect(node, 'resolve-story-input node must exist in v2').toBeDefined();
  expect(node?.bash, 'resolve-story-input must be a bash node').toBeDefined();
  const fx = makeSprintFixture(devStatusYaml);
  try {
    const env: Record<string, string> = { ARTIFACTS_DIR: fx.artifactsDir };
    if (argumentsValue !== undefined) env.ARGUMENTS = argumentsValue;
    return runBash(node!.bash as string, { env, cwd: fx.cwd });
  } finally {
    fx.cleanup();
  }
}

/**
 * Extract the `verify-story-identity` guard body, substitute the engine tokens
 * with test values (as the engine would before execution), and run it.
 * Fails RED (guard undefined) until the guard exists.
 * gateValue simulates the $code-review-auto.output.gate substitution (default 'PASS').
 * envelope overrides allow testing invalid contract metadata (R1-F4).
 */
function runGuardNode(
  resolvedRef: string,
  contractRef: string,
  gateValue: string = 'PASS',
  envelope: {
    contractVersion?: string;
    workflow?: string;
    node?: string;
  } = {}
): BashResult {
  const wf = loadV2();
  const guard = getNode(wf, 'verify-story-identity');
  expect(guard, 'verify-story-identity guard node must exist in v2').toBeDefined();
  expect(guard?.bash, 'verify-story-identity must be a bash node').toBeDefined();
  const substituted = (guard!.bash as string)
    .split(RESOLVED_TOKEN)
    .join(resolvedRef)
    .split(CONTRACT_TOKEN)
    .join(contractRef)
    .split(GATE_TOKEN)
    .join(gateValue)
    .split(CONTRACT_VERSION_TOKEN)
    .join(envelope.contractVersion ?? '1.0')
    .split(CONTRACT_WORKFLOW_TOKEN)
    .join(envelope.workflow ?? 'bmad-dev-story-with-tea-fix-loop-v2')
    .split(CONTRACT_NODE_TOKEN)
    .join(envelope.node ?? 'code-review-auto');
  const fx = makeSprintFixture();
  try {
    return runBash(substituted, { env: { ARTIFACTS_DIR: fx.artifactsDir }, cwd: fx.cwd });
  } finally {
    fx.cleanup();
  }
}

describe('v2 story-input resolution (Story a1.2)', () => {
  // parseWorkflow validates `provider:` against the global registry (codex +
  // claude). Register idempotently WITHOUT clearRegistry() — this file shares a
  // process with the other src/defaults/ tests.
  beforeAll(() => {
    if (!isRegisteredProvider('codex')) {
      try {
        registerBuiltinProviders();
      } catch {
        // Another test in the batch already registered builtins — fine.
      }
    }
  });

  // ── AC1: Input contract preserved (raw $ARGUMENTS still threaded) ──────────
  describe('AC1 — input contract preserved', () => {
    it('STR-A1-1 [P0] dev-story still passes raw $ARGUMENTS (contract unchanged)', () => {
      // Regression guard (green today): the refactor must NOT stop dev-story from
      // receiving raw $ARGUMENTS. Breaks if the dev rewrites the prompt to a key.
      const wf = loadV2();
      const dev = getNode(wf, 'dev-story');
      expect(dev, 'dev-story node must exist').toBeDefined();
      expect(dev?.prompt ?? '').toContain('bmad-dev-story $ARGUMENTS');
    });

    it('STR-A1-2 [P1] every TEA node prompt still passes $ARGUMENTS', () => {
      // Regression guard (green today).
      const wf = loadV2();
      for (const id of ['tea-automate', 'tea-rv', 'tea-nr', 'tea-tr']) {
        const n = getNode(wf, id);
        expect(n, `${id} node must exist`).toBeDefined();
        expect(n?.prompt ?? '', `${id} must forward $ARGUMENTS`).toContain('$ARGUMENTS');
      }
    });
  });

  // ── AC2: Normalized story_ref produced + ordered before any AI node ────────
  describe('AC2 — normalized story_ref produced', () => {
    it('STR-A2-1 [P0] resolve-story-input exists, typed story-ref, dev-story depends on it', () => {
      // RED: node absent today; dev-story currently depends_on [prepare-bmad-state].
      const wf = loadV2();
      const resolve = getNode(wf, 'resolve-story-input');
      expect(resolve, 'resolve-story-input node must exist').toBeDefined();
      expect(resolve?.bash, 'resolve-story-input must be a bash node').toBeDefined();
      expect(resolve?.output_type).toBe('story-ref');

      const dev = getNode(wf, 'dev-story');
      expect(dev?.depends_on ?? [], 'dev-story must depend on resolve-story-input').toContain(
        'resolve-story-input'
      );
    });

    it('STR-A2-5 [P1] $resolve-story-input.output.story_ref ref keeps v2 loadable', () => {
      // RED until the node exists: the ref appears in a downstream body AND the
      // whole workflow still parses (loader validates $node.output refs point to
      // real nodes). Absence of the node makes STR-A2-1 fail first.
      const content = readLF(V2_FILE);
      expect(content, `expected v2 file: ${V2_FILE}`).not.toBeNull();
      expect(content as string, 'v2 must reference the resolved story_ref downstream').toContain(
        RESOLVED_TOKEN
      );
      const result = parseWorkflow(content as string, `${V2_STEM}.yml`);
      expect(result.error, `parseWorkflow reported: ${result.error?.error ?? 'none'}`).toBeNull();
    });

    it('BASH-A2-1 [P0] exact story key → exit 0, single JSON, .story_ref == canonical key', () => {
      // RED: resolve-story-input node absent → runResolveNode fails at toBeDefined.
      const r = runResolveNode(CANONICAL_KEY);
      expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);
      const parsed = JSON.parse(r.stdout.trim()) as { story_ref?: string };
      expect(parsed.story_ref).toBe(CANONICAL_KEY);
    });

    it('STR-A2-7 [P1] resolve node emits story_id + story_arguments alongside story_ref', () => {
      // Contract completeness for downstream consumers (proven by running it).
      const r = runResolveNode(CANONICAL_KEY);
      expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);
      const parsed = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
      expect(parsed.story_ref).toBe(CANONICAL_KEY);
      expect(parsed.story_id).toBe('a1.2');
      expect(parsed.story_arguments).toBe(CANONICAL_KEY);
    });

    it('BASH-A2-6 [P0] stdout is exactly ONE JSON object — no extra echo/key=value lines', () => {
      // Boundary (C-4): dag-executor trims only one trailing \n; any extra line
      // breaks JSON.parse for $node.output.field. Whole stdout must parse and be
      // a single top-level object.
      const r = runResolveNode(CANONICAL_KEY);
      expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);
      const trimmed = r.stdout.replace(/\n$/, '');
      expect(trimmed).not.toMatch(/\n/); // single line, no leading echoes
      const parsed: unknown = JSON.parse(trimmed);
      expect(typeof parsed).toBe('object');
      expect(Array.isArray(parsed)).toBe(false);
    });

    it('BASH-A2-2 [P1] epic.story id "a1.2" resolves to the a1-2-… key', () => {
      const r = runResolveNode('a1.2');
      expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);
      const parsed = JSON.parse(r.stdout.trim()) as { story_ref?: string };
      expect(parsed.story_ref).toBe(CANONICAL_KEY);
    });

    it('BASH-A2-3 [P1] title / kebab-title substring resolves to the canonical key', () => {
      const r = runResolveNode('preserve-story-input-resolution');
      expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);
      const parsed = JSON.parse(r.stdout.trim()) as { story_ref?: string };
      expect(parsed.story_ref).toBe(CANONICAL_KEY);
    });

    it('BASH-A2-4 [P1] story-file basename "a1-2-*.md" resolves to the canonical key', () => {
      const r = runResolveNode('a1-2-preserve-story-input-resolution.md');
      expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);
      const parsed = JSON.parse(r.stdout.trim()) as { story_ref?: string };
      expect(parsed.story_ref).toBe(CANONICAL_KEY);
    });

    it('BASH-A2-4b [P1] story-file full path resolves to canonical key (R1-F3)', () => {
      const r = runResolveNode(
        '_bmad-output/implementation-artifacts/a1-2-preserve-story-input-resolution.md'
      );
      expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);
      const parsed = JSON.parse(r.stdout.trim()) as { story_ref?: string };
      expect(parsed.story_ref).toBe(CANONICAL_KEY);
    });

    it('BASH-A2-4c [P1] title substring beginning with hyphen resolves to canonical key (R2-F3)', () => {
      // grep -qF without '--' treats "-substring" as a flag; adding -- fixes it.
      const r = runResolveNode('-preserve-story-input-resolution');
      expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);
      const parsed = JSON.parse(r.stdout.trim()) as { story_ref?: string };
      expect(parsed.story_ref).toBe(CANONICAL_KEY);
    });

    it('BASH-A2-4d [P1] short leading-hyphen substring "-n" resolves to unique matching key (R6-F4)', () => {
      // echo "-n" is silently treated as an option by bash, emitting no data, so the
      // alphanumeric guard and key-search both fail. printf '%s\n' "-n" always emits
      // the literal string and handles any leading-hyphen input correctly.
      const singleStory = `development_status:
  a1-2-new-feature: ready-for-dev
`;
      const r = runResolveNode('-n', singleStory);
      expect(r.exitCode, `stderr: ${r.stderr}`).toBe(0);
      const parsed = JSON.parse(r.stdout.trim()) as { story_ref?: string };
      expect(parsed.story_ref).toBe('a1-2-new-feature');
    });

    it('BASH-A3-8 [P2] identical valid input twice → deterministic same story_ref (idempotent)', () => {
      const a = runResolveNode(CANONICAL_KEY);
      const b = runResolveNode(CANONICAL_KEY);
      expect(a.exitCode).toBe(0);
      expect(b.exitCode).toBe(0);
      expect(a.stdout.trim()).toBe(b.stdout.trim());
    });
  });

  // ── AC3: Invalid / missing / ambiguous input → ERROR (non-zero) ────────────
  describe('AC3 — invalid/missing/ambiguous input errors', () => {
    it('BASH-A3-1 [P0] MISSING $ARGUMENTS (unset) → non-zero + clear message', () => {
      const r = runResolveNode(undefined);
      expect(r.exitCode).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`.toLowerCase()).toContain('missing');
    });

    it('BASH-A3-1b [P0] EMPTY $ARGUMENTS ("") → non-zero', () => {
      const r = runResolveNode('');
      expect(r.exitCode).not.toBe(0);
    });

    it('BASH-A3-2 [P0] INVALID ref (0 matches) → non-zero', () => {
      const r = runResolveNode('this-story-does-not-exist');
      expect(r.exitCode).not.toBe(0);
    });

    it('BASH-A3-3 [P0] AMBIGUOUS ref (>1 match) → non-zero', () => {
      // Two stories sharing a title token → deliberately ambiguous.
      const status = `development_status:
  a9-1-shared-token-alpha: backlog
  a9-2-shared-token-beta: backlog
`;
      const r = runResolveNode('shared-token', status);
      expect(r.exitCode).not.toBe(0);
    });

    it('BASH-A3-4 [P0] prefix collision "a1" (matches a1-1 AND a1-2) → ambiguous → non-zero', () => {
      // R-010: naive prefix/substring match must NOT silently pick one story.
      const r = runResolveNode('a1');
      expect(r.exitCode).not.toBe(0);
    });

    it('BASH-A3-5 [P1] input matching only epic-*/*-retrospective → 0 story matches → non-zero', () => {
      // R-011: exclusion filter must drop epic + retrospective keys from candidates.
      const r = runResolveNode('epic-a1');
      expect(r.exitCode).not.toBe(0);
    });

    it('BASH-A3-6 [P1] $ARGUMENTS with shell metachars (spaces, *, ;) → no glob/word-split misfire', () => {
      // R-010 / NR-1: must quote "$ARGUMENTS"; a metachar payload is a deterministic
      // ERROR (no match), never a crash or accidental multi-match.
      const r = runResolveNode('a1-2 ; echo pwned * ');
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).not.toContain('pwned');
    });

    it('BASH-A3-9 [P1] ARGUMENTS with embedded newline → non-zero + clear message (R2-F2)', () => {
      // resolver hand-builds JSON; an unescaped newline in story_arguments would
      // produce invalid JSON even after backslash/quote escaping.
      // Fix: reject inputs containing control characters before matching.
      const r = runResolveNode('a1-2-preserve\nstory-input-resolution');
      expect(r.exitCode).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`.toLowerCase()).toMatch(/control/);
    });

    it('BASH-A3-10 [P1] punctuation-only input (single hyphen) → non-zero, no match (R6-F3)', () => {
      // "-" normalizes to "-" which matches hyphen separators in the only story key.
      // The resolver must require at least one alphanumeric char before substring-matching.
      const r = runResolveNode('-');
      expect(r.exitCode).not.toBe(0);
    });

    it('BASH-A3-11 [P1] whitespace-only input normalized to hyphens → non-zero (R6-F3)', () => {
      // " " normalizes to "-" (tr ' ' '-') and must not match the only story key.
      const r = runResolveNode(' ');
      expect(r.exitCode).not.toBe(0);
    });

    it('BASH-A3-7 [P2] malformed sprint-status (no development_status:) → non-zero, no partial match', () => {
      const r = runResolveNode(CANONICAL_KEY, 'garbage: true\nnot_a_status_block: []\n');
      expect(r.exitCode).not.toBe(0);
    });

    it('STR-A3-6 [P0] no AI node uses trigger_rule all_done/one_success (fail-fast stays emergent)', () => {
      // C-1 / R-002: "no downstream AI node runs on failure" holds ONLY because
      // every AI node uses the default all_success trigger. A non-default rule
      // would run despite the failed gate. Green today; locks the invariant.
      const wf = loadV2();
      for (const id of [
        'dev-story',
        'tea-automate',
        'tea-rv',
        'tea-nr',
        'tea-tr',
        'create-pull-request',
      ]) {
        const n = getNode(wf, id);
        if (!n) continue;
        expect(['all_success', undefined], `${id} must keep default all_success trigger`).toContain(
          n.trigger_rule
        );
      }
    });
  });

  // ── AC4: Route-facing contract carries story_ref; mismatch → ERROR ─────────
  describe('AC4 — route-facing contract identity + mismatch guard', () => {
    it('STR-A4-1 [P0] code-review-auto output_format includes required story_ref (string)', () => {
      const wf = loadV2();
      const cr = getNode(wf, 'code-review-auto');
      expect(cr, 'code-review-auto node must exist').toBeDefined();
      const of = cr?.output_format ?? {};
      const props = (of.properties ?? {}) as Record<string, { type?: string }>;
      const required = (of.required ?? []) as string[];
      expect(props.story_ref, 'code-review-auto schema must declare story_ref').toBeDefined();
      expect(props.story_ref?.type).toBe('string');
      expect(required, 'story_ref must be required').toContain('story_ref');
    });

    it('STR-A4-5 [P0] code-review-auto pins story_ref via prompt_suffix (the substituted prompt channel)', () => {
      const cr = getNode(loadV2(), 'code-review-auto');
      expect(cr, 'code-review-auto node must exist').toBeDefined();
      expect(
        cr?.prompt_suffix ?? '',
        'code-review-auto node must carry the story_ref pin token in prompt_suffix (substituted channel)'
      ).toContain(RESOLVED_TOKEN);
    });

    it('STR-A4-2 [P0] verify-story-identity guard exists, depends on resolve + code-review; gate depends on verify-story-identity', () => {
      // R4-F2 fix: code-review-gate now routes from verify-story-identity (bash guard)
      // using a bare-output condition so the loader does not require output_format on
      // the from node. When verify-story-identity exits 1 on mismatch, code-review-gate
      // is SKIPPED (all_success trigger), preventing dev-story from being activated.
      const wf = loadV2();
      const guard = getNode(wf, 'verify-story-identity');
      expect(guard, 'verify-story-identity guard node must exist').toBeDefined();
      const deps = guard?.depends_on ?? [];
      expect(deps).toContain('resolve-story-input');
      expect(deps).toContain('code-review-auto');

      const gate = getNode(wf, 'code-review-gate');
      expect(
        gate?.depends_on ?? [],
        'code-review-gate must depend on verify-story-identity (R4-F2 fix)'
      ).toEqual(['verify-story-identity']);
    });

    it('STR-A4-3 [P0] route_loop on code-review-gate routes from verify-story-identity with bare-output condition (R4-F2)', () => {
      // Bare-output condition avoids the loader's output_format.properties check
      // (only triggered when a .field accessor is present). This allows a bash node
      // to be the from source while still providing deterministic routing.
      const gate = getNode(loadV2(), 'code-review-gate');
      expect(gate?.route_loop?.from).toBe('verify-story-identity');
      expect(gate?.route_loop?.condition).toBe("$verify-story-identity.output == 'PASS'");
      expect(gate?.route_loop?.routes?.positive).toBe('tea-rv');
      expect(gate?.route_loop?.routes?.negative).toBe('dev-story');
      expect(gate?.route_loop?.routes?.exhausted).toBe('review-loop-error');
    });

    it('STR-A4-4 [P0] positive route (tea-rv) transitively depends on the guard', () => {
      // C-1 / R-002: a mismatch must SKIP the positive continuation, never feed the
      // dev-story negative route. tea-rv (or a node it depends on) must depend on
      // verify-story-identity. RED until the guard is wired into the positive path.
      const wf = loadV2();
      const byId = new Map(nodes(wf).map(n => [n.id, n]));
      const dependsTransitively = (start: string, target: string): boolean => {
        const seen = new Set<string>();
        const stack = [...(byId.get(start)?.depends_on ?? [])];
        while (stack.length) {
          const cur = stack.pop() as string;
          if (cur === target) return true;
          if (seen.has(cur)) continue;
          seen.add(cur);
          stack.push(...(byId.get(cur)?.depends_on ?? []));
        }
        return false;
      };
      expect(
        dependsTransitively('tea-rv', 'verify-story-identity'),
        'tea-rv must transitively depend on verify-story-identity'
      ).toBe(true);
    });

    it('BASH-A4-1 [P0] guard: contract story_ref ≠ resolved → non-zero (ERROR)', () => {
      const r = runGuardNode(CANONICAL_KEY, 'a2-1-wire-ds-ta-cr-sequence');
      expect(r.exitCode).not.toBe(0);
    });

    it('BASH-A4-2 [P0] guard: contract story_ref empty/missing → non-zero', () => {
      const r = runGuardNode(CANONICAL_KEY, '');
      expect(r.exitCode).not.toBe(0);
    });

    it('BASH-A4-3 [P1] guard: equal story_ref on both sides → exit 0, stdout passes gate value through', () => {
      // Guard is a pure pass-through: it validates identity and echoes the gate
      // value from code-review. story_ref traceability lives in code-review's
      // output_format (the route source), not in the guard's stdout (R3-F2 fix).
      const rPass = runGuardNode(CANONICAL_KEY, CANONICAL_KEY, 'PASS');
      expect(rPass.exitCode, `stderr: ${rPass.stderr}`).toBe(0);
      expect(rPass.stdout.trim()).toBe('PASS');

      const rFail = runGuardNode(CANONICAL_KEY, CANONICAL_KEY, 'FAIL');
      expect(rFail.exitCode, `stderr: ${rFail.stderr}`).toBe(0);
      expect(rFail.stdout.trim()).toBe('FAIL');
    });

    it('BASH-A4-4 [P0] guard: wrong contract_version → non-zero (envelope validation)', () => {
      const r = runGuardNode(CANONICAL_KEY, CANONICAL_KEY, 'PASS', {
        contractVersion: '1',
      });
      expect(r.exitCode, `stderr: ${r.stderr}`).not.toBe(0);
    });

    it('BASH-A4-5 [P0] guard: wrong workflow → non-zero (envelope validation)', () => {
      const r = runGuardNode(CANONICAL_KEY, CANONICAL_KEY, 'PASS', {
        workflow: 'some-other-workflow',
      });
      expect(r.exitCode, `stderr: ${r.stderr}`).not.toBe(0);
    });

    it('BASH-A4-6 [P0] guard: wrong node → non-zero (envelope validation)', () => {
      const r = runGuardNode(CANONICAL_KEY, CANONICAL_KEY, 'PASS', {
        node: 'code-review',
      });
      expect(r.exitCode, `stderr: ${r.stderr}`).not.toBe(0);
    });

    it('STR-A4-9 [P0] R4-F2 fix: code-review-gate routes from verify-story-identity; mismatch blocks ALL routes', () => {
      // R4-F2 fix: the route_loop now gates from verify-story-identity (Archon-owned
      // bash guard) using a bare-output condition. A mismatch causes verify-story-identity
      // to exit 1 → code-review-gate is SKIPPED (all_success) → dev-story is never
      // activated on either positive OR negative route.
      // R4-F1 fix: verify-story-identity IS the deterministic Archon-owned enforcement
      // path — it reads the engine-resolved story_ref via substitution and confirms
      // identity before any routing decision fires.
      const wf = loadV2();

      // code-review-auto declares story_ref for reference; guard enforces the value
      const cr = getNode(wf, 'code-review-auto');
      expect(cr, 'code-review-auto node must exist').toBeDefined();
      const crProps = ((cr?.output_format ?? {}).properties ?? {}) as Record<string, unknown>;
      expect(
        crProps.story_ref,
        'code-review-auto output_format must declare story_ref'
      ).toBeDefined();

      // Gate routes from verify-story-identity with bare-output condition
      const gate = getNode(wf, 'code-review-gate');
      expect(gate?.route_loop?.from).toBe('verify-story-identity');
      expect(gate?.route_loop?.condition).toBe("$verify-story-identity.output == 'PASS'");

      // Guard is directly upstream of code-review-gate
      expect(
        gate?.depends_on ?? [],
        'code-review-gate must depend on verify-story-identity (R4-F2 fix)'
      ).toContain('verify-story-identity');

      // tea-rv depends on code-review-gate (which transitively depends on the guard)
      const teaRv = getNode(wf, 'tea-rv');
      expect(teaRv?.depends_on ?? [], 'tea-rv must depend on code-review-gate').toContain(
        'code-review-gate'
      );
    });

    it('STR-A4-8 [P2] review-loop-error (exhausted route) still exits 1 — unaffected by new nodes', () => {
      const wf = loadV2();
      const err = getNode(wf, 'review-loop-error');
      expect(err?.bash ?? '', 'review-loop-error must still hard-fail the run').toContain('exit 1');
    });
  });

  // ── AC5: Validation fixture proves the four ERROR cases + happy path ───────
  describe('AC5 — four ERROR cases + happy path in one fixture', () => {
    it('BASH-A5-1 [P0] missing + invalid + ambiguous + mismatch → ERROR; valid single → resolve', () => {
      // Meta-deliverable: this single test asserts the full ERROR quartet plus the
      // happy path, satisfying AC #5's "one automated fixture" clause.
      expect(runResolveNode(undefined).exitCode, 'missing → ERROR').not.toBe(0);
      expect(runResolveNode('this-story-does-not-exist').exitCode, 'invalid → ERROR').not.toBe(0);
      expect(runResolveNode('a1').exitCode, 'ambiguous → ERROR').not.toBe(0);
      expect(
        runGuardNode(CANONICAL_KEY, 'a2-1-wire-ds-ta-cr-sequence').exitCode,
        'mismatch → ERROR'
      ).not.toBe(0);

      const happy = runResolveNode(CANONICAL_KEY);
      expect(happy.exitCode, `happy path must resolve; stderr: ${happy.stderr}`).toBe(0);
      expect((JSON.parse(happy.stdout.trim()) as { story_ref?: string }).story_ref).toBe(
        CANONICAL_KEY
      );
    });
  });

  // ── AC6: v2 naming policy (no plan-artifact refs) — regression guard ───────
  describe('AC6 — shipped YAML naming policy', () => {
    it('REG-A6-4 [P1] updated v2 YAML contains no plan-artifact references', () => {
      // Mirrors baseline S1.5 on the (soon) edited v2 — the new node names/comments
      // must carry NO story ids / FR-AD codes / epic labels. a1-2-… (hyphen) is
      // safe; a1.2 (dot) is not.
      const content = readLF(V2_FILE);
      expect(content, `expected v2 file: ${V2_FILE}`).not.toBeNull();
      for (const pattern of [/\bA-FR-\d/i, /\bA-AD-\d/i, /\bA1\.\d/, /\bepic\s+a\d/i]) {
        expect(content as string, `plan-artifact ref leaked: ${pattern}`).not.toMatch(pattern);
      }
    });

    it('REG-A6-3 [P0] v2 relaxes the byte-copy baseline soundly (adds nodes, keeps original set + $ARGUMENTS)', () => {
      // Replaces the A1.1 S3.2 "v2.nodes === v1.nodes" identity check. Encodes the
      // RELAXED-but-sound guarantee directly (the dev must also relax S3.2 in
      // v2-workflow-baseline.test.ts — see checklist). RED until the new nodes exist.
      const wf = loadV2();
      const ids = new Set(nodes(wf).map(n => n.id));
      // (b) v2 ADDS the two Archon-owned nodes
      expect(ids.has('resolve-story-input'), 'v2 must add resolve-story-input').toBe(true);
      expect(ids.has('verify-story-identity'), 'v2 must add verify-story-identity').toBe(true);
      // (c) v2 RETAINS the original v1 node set
      for (const original of [
        'prepare-bmad-state',
        'dev-story',
        'tea-automate',
        'code-review-auto',
        'code-review-gate',
        'tea-rv',
        'tea-nr',
        'tea-tr',
        'review-loop-error',
        'create-pull-request',
      ]) {
        expect(ids.has(original), `v2 must retain original node ${original}`).toBe(true);
      }
      // (d) dev-story still passes $ARGUMENTS
      expect(getNode(wf, 'dev-story')?.prompt ?? '').toContain('$ARGUMENTS');
    });
  });
});

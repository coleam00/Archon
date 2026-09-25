import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { removeTempTree } from '@archon/paths/test-utils';
import {
  fakeGhPreload,
  type GhFake,
} from '../../../../.archon/scripts/__tests__/deliver-checks-harness';
import {
  isBinaryBuild,
  BUNDLED_COMMANDS,
  BUNDLED_SCRIPT_PACKS,
  BUNDLED_WORKFLOWS,
  BUNDLED_WORKFLOW_OWNERS,
} from './bundled-defaults';
import {
  formatPackagedResourceReference,
  parsePackagedResourceReference,
} from '../packaged-workflow';
import { parseWorkflow } from '../loader';
import {
  isExecNode,
  isIncludeDirective,
  isLoopGroupNode,
  isOutputFormatEnforced,
  isWaitNode,
} from '../schemas';
import {
  findRequiredPropertyGaps,
  getProviderCapabilities,
  isRegisteredProvider,
  registerBuiltinProviders,
} from '@archon/providers';

registerBuiltinProviders();

// Resolve the on-disk defaults directories relative to this test file so the
// tests work regardless of cwd. From packages/workflows/src/defaults go up
// four levels to the repo root, then into .archon/.
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const COMMANDS_DIR = join(REPO_ROOT, '.archon/commands/defaults');
const WORKFLOWS_DIR = join(REPO_ROOT, '.archon/workflows/defaults');
// `legacy/` holds the deprecated-window defaults (#2781): same flat file
// convention, one grouping subfolder within the discovery depth cap.
const LEGACY_WORKFLOWS_DIR = join(WORKFLOWS_DIR, 'legacy');

describe('bundled-defaults', () => {
  describe('isBinaryBuild', () => {
    it('should return false in dev/test mode', () => {
      // `isBinaryBuild()` reads the build-time constant `BUNDLED_IS_BINARY` from
      // `@archon/paths`. In dev/test mode it is `false`. It is only rewritten to
      // `true` by `scripts/build-binaries.sh` before `bun build --compile`.
      // Coverage of the `true` branch is via local binary smoke testing (see #979).
      expect(isBinaryBuild()).toBe(false);
    });
  });

  describe('bundle completeness', () => {
    // These assertions are the canary for bundle drift: if someone adds a
    // default file without regenerating bundled-defaults.generated.ts, the
    // bundle would be missing in compiled binaries (see #979 context). The
    // generator is `scripts/generate-bundled-defaults.ts`, and
    // `bun run check:bundled` verifies the generated file is up to date.

    it('BUNDLED_COMMANDS contains every .md file in .archon/commands/defaults/', () => {
      const onDisk = readdirSync(COMMANDS_DIR)
        .filter(f => f.endsWith('.md'))
        .map(f => f.slice(0, -'.md'.length))
        .sort();
      expect(
        Object.keys(BUNDLED_COMMANDS)
          .filter(name => parsePackagedResourceReference(name) === null)
          .sort()
      ).toEqual(onDisk);
    });

    it('BUNDLED_WORKFLOWS contains every .yaml/.yml file in .archon/workflows/defaults/', () => {
      const readFlat = (dir: string): string[] => {
        if (!existsSync(dir)) return [];
        return readdirSync(dir)
          .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
          .map(f => f.replace(/\.ya?ml$/, ''));
      };
      const onDisk = [...readFlat(WORKFLOWS_DIR), ...readFlat(LEGACY_WORKFLOWS_DIR)].sort();
      expect(
        Object.keys(BUNDLED_WORKFLOWS)
          .filter(name => BUNDLED_WORKFLOW_OWNERS[name] === undefined)
          .sort()
      ).toEqual(onDisk);
    });

    it('bundled content matches on-disk file content (defense against generator corruption)', () => {
      // Bundled content is LF-normalized by the generator so it stays identical
      // regardless of the checkout's line-ending policy. Match that here.
      const readLF = (path: string): string => readFileSync(path, 'utf-8').replace(/\r\n/g, '\n');

      // Packaged (pack-owned) entries live under .archon/workflows/<pack>/<workflow>/,
      // not the flat defaults directories — their content parity is proven by
      // 'packaged bundle metadata is internally consistent' below.
      for (const [name, content] of Object.entries(BUNDLED_COMMANDS)) {
        if (parsePackagedResourceReference(name) !== null) continue;
        const diskContent = readLF(join(COMMANDS_DIR, `${name}.md`));
        expect(content).toBe(diskContent);
      }
      for (const [name, content] of Object.entries(BUNDLED_WORKFLOWS)) {
        if (BUNDLED_WORKFLOW_OWNERS[name] !== undefined) continue;
        // Workflows may be .yaml or .yml — prefer .yaml, fall back. The name may
        // live in the flat defaults dir or the legacy/ deprecation window.
        let diskContent: string | undefined;
        for (const dir of [WORKFLOWS_DIR, LEGACY_WORKFLOWS_DIR]) {
          try {
            diskContent = readLF(join(dir, `${name}.yaml`));
            break;
          } catch {}
          try {
            diskContent = readLF(join(dir, `${name}.yml`));
            break;
          } catch {}
        }
        // The completeness test above pins the file existing; here we only
        // compare content parity.
        expect(diskContent).toBeDefined();
        expect(content).toBe(diskContent as string);
      }
    });

    it('packaged bundle metadata is internally consistent', () => {
      for (const [workflow, owner] of Object.entries(BUNDLED_WORKFLOW_OWNERS)) {
        if (!owner?.pack || !owner.workflow) throw new Error(`Missing owner for ${workflow}`);
        const resourceOwner = {
          source: 'bundled' as const,
          pack: owner.pack,
          workflow: owner.workflow,
        };
        expect(BUNDLED_WORKFLOWS[workflow]).toBeDefined();
        expect(owner.pack.length).toBeGreaterThan(0);
        expect(owner.workflow.length).toBeGreaterThan(0);
        const workflowDir = join(REPO_ROOT, '.archon', 'workflows', owner.pack, owner.workflow);
        const yaml = readdirSync(workflowDir).find(entry => /\.ya?ml$/.test(entry));
        expect(yaml).toBeDefined();
        expect(BUNDLED_WORKFLOWS[workflow]).toBe(
          readFileSync(join(workflowDir, yaml!), 'utf-8').replace(/\r\n/g, '\n')
        );

        const commandDir = join(workflowDir, 'commands');
        if (existsSync(commandDir)) {
          for (const entry of readdirSync(commandDir).filter(entry => entry.endsWith('.md'))) {
            const localName = entry.slice(0, -'.md'.length);
            const key = formatPackagedResourceReference(resourceOwner, localName);
            expect(BUNDLED_COMMANDS[key]).toBe(
              readFileSync(join(commandDir, entry), 'utf-8').replace(/\r\n/g, '\n')
            );
          }
        }
      }
      for (const [pack, bundle] of Object.entries(BUNDLED_SCRIPT_PACKS)) {
        for (const [path, content] of Object.entries(bundle.files)) {
          expect(content).toBe(
            readFileSync(join(REPO_ROOT, '.archon/workflows', pack, path), 'utf-8').replace(
              /\r\n/g,
              '\n'
            )
          );
        }
        for (const [name, script] of Object.entries(bundle.scripts)) {
          const packaged = parsePackagedResourceReference(name);
          if (packaged === null) throw new Error(`Missing packaged script owner: ${name}`);
          expect(packaged.owner.pack).toBe(pack);
          expect(script.path.startsWith(`${packaged.owner.workflow}/scripts/`)).toBe(true);
          expect(bundle.files[script.path]?.length).toBeGreaterThan(0);
          expect(['uv', 'bun']).toContain(script.runtime);
        }
      }
    });
  });

  describe('BUNDLED_COMMANDS', () => {
    it('every command has meaningful content (>50 chars)', () => {
      for (const content of Object.values(BUNDLED_COMMANDS)) {
        expect(content.length).toBeGreaterThan(50);
      }
    });

    it('archon-pr-review-scope should read .pr-number before other discovery', () => {
      const content = BUNDLED_COMMANDS['archon-pr-review-scope'];
      expect(content).toContain('$ARTIFACTS_DIR/.pr-number');
      expect(content).toContain('PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number');
    });

    it('classify-review-scope declares only its structured output fields', () => {
      const content =
        BUNDLED_COMMANDS['__archon_pack__bundled:sdlc:deliver::classify-review-scope'];
      expect(content).toContain('- `errors`, `docs` — booleans');
      expect(content).toContain('- `reasons` — `{errors, docs}`');
      expect(content).not.toContain('`tests`, `errors`, `comments`, `types`, `docs`');
    });

    it('archon-create-pr should write .pr-number to artifacts', () => {
      const content = BUNDLED_COMMANDS['archon-create-pr'];
      expect(content).toContain('echo "$PR_NUMBER" > "$ARTIFACTS_DIR/.pr-number"');
    });

    it('the SDLC implementation and every review lens own separate discovery records', () => {
      const expected = new Map([
        ['__archon_pack__bundled:sdlc:implement::implement', 'discoveries/implement.json'],
        ['__archon_pack__bundled:sdlc:review::review-code', 'discoveries/review-code.json'],
        ['__archon_pack__bundled:sdlc:review::review-seams', 'discoveries/review-seams.json'],
        ['__archon_pack__bundled:sdlc:review::review-simplify', 'discoveries/review-simplify.json'],
        ['__archon_pack__bundled:sdlc:review::review-tests', 'discoveries/review-tests.json'],
        ['__archon_pack__bundled:sdlc:review::review-errors', 'discoveries/review-errors.json'],
        ['__archon_pack__bundled:sdlc:review::review-docs', 'discoveries/review-docs.json'],
      ]);

      for (const [key, path] of expected) {
        expect(BUNDLED_COMMANDS[key]).toContain(path);
        expect(BUNDLED_COMMANDS[key]).toContain('scope_conflict');
        expect(BUNDLED_COMMANDS[key]).toContain('Write no file');
      }

      const synthesize = BUNDLED_COMMANDS['__archon_pack__bundled:sdlc:review::review-synthesize'];
      expect(synthesize).toContain('$ARTIFACTS_DIR/discoveries.json');
      expect(synthesize).toContain('$ARTIFACTS_DIR/discoveries.md');
      expect(synthesize).toContain('an `adjacent` record never affects readiness');
      expect(synthesize).toContain(
        'If you are an agent reading this: open discoveries.md and surface each discovery to your human.'
      );
    });

    // A reusable pack must not hardcode one project's context paths (AGENTS.md,
    // "Project guidance should be available, not sprayed everywhere"). Every evaluative
    // prompt reads the pack-owned scope artifact plus a conventional, conditional
    // `architecture.md`; project guidance arrives through the provider's own context
    // mechanism, which is why no prompt instructs reading AGENTS.md either. The rules the
    // prompts used to delegate to a project file are stated in the prompts themselves.
    it('no review prompt hardcodes a project context path', () => {
      const lenses = [
        'review-code',
        'review-seams',
        'review-simplify',
        'review-tests',
        'review-errors',
        'review-docs',
      ];
      for (const name of [...lenses, 'review-synthesize']) {
        const content = BUNDLED_COMMANDS[`__archon_pack__bundled:sdlc:review::${name}`];
        expect(content).toBeDefined();
        expect(content).not.toContain('.archon/engineering.md');
        expect(content).not.toContain('Read `AGENTS.md`');
        expect(content).toContain("the project's `architecture.md` if it has one");
        expect(content).toContain('$ARTIFACTS_DIR/review/scope.md');
        // The risk taxonomy the removed file used to own, now stated in every prompt
        // that depends on it rather than cited.
        expect(content).toContain(
          'irreversible or destructive paths, lifecycle ownership, persisted contracts and ' +
            'schemas, credentials and auth boundaries, integration boundaries'
        );
      }
      // Synthesis judges whether the lenses engaged those risks; the lenses scale their
      // own depth by them.
      for (const name of lenses) {
        expect(BUNDLED_COMMANDS[`__archon_pack__bundled:sdlc:review::${name}`]).toContain(
          'scale depth to what the change can destroy'
        );
      }
    });
  });

  describe('BUNDLED_WORKFLOWS', () => {
    it('every workflow has meaningful content (>50 chars)', () => {
      for (const content of Object.values(BUNDLED_WORKFLOWS)) {
        expect(content.length).toBeGreaterThan(50);
      }
    });

    it('archon-workflow-builder should have validate-before-save node ordering and key constraints', () => {
      const content = BUNDLED_WORKFLOWS['archon-workflow-builder'];
      expect(content).toContain('id: validate-yaml');
      expect(content).toContain('depends_on: [validate-yaml]');
      expect(content).toContain('denied_tools: [Edit, Bash]');
      expect(content).toContain('output_format:');
      expect(content).toContain('workflow_name');
    });

    it('archon-adversarial-dev init-workspace should avoid non-portable sed -i', () => {
      const content = BUNDLED_WORKFLOWS['archon-adversarial-dev'];
      expect(content).toContain('STATE_TMP="$ARTIFACTS/state.json.tmp"');
      expect(content).toContain(
        'sed "s/SPRINT_COUNT_PLACEHOLDER/$SPRINT_COUNT/" "$ARTIFACTS/state.json" > "$STATE_TMP"'
      );
      expect(content).not.toContain('sed -i "s/SPRINT_COUNT_PLACEHOLDER/$SPRINT_COUNT/"');
    });

    it('archon-ship carries its target through triage.md without downstream target prose', () => {
      const content = BUNDLED_WORKFLOWS['archon-ship'];
      const parsed = parseWorkflow(content, 'archon-ship.yaml');
      if (parsed.workflow === null) throw new Error(parsed.error.error);

      expect(parsed.workflow.inputs?.target?.default).toBe('');

      const triage = parsed.workflow.nodes.find(node => node.id === 'triage');
      expect(triage?.kind).toBe('include');
      if (triage?.kind !== 'include') throw new Error('triage is not an include');
      expect(triage.with).toEqual({ target: '$INPUTS.target', publish: '$INPUTS.publish' });

      const triageCommand = BUNDLED_COMMANDS['__archon_pack__bundled:sdlc:triage::triage'];
      expect(triageCommand).toContain('Write `$ARTIFACTS_DIR/triage.md`');
      expect(triageCommand).toContain('**Source and outcome** — what was requested');

      const downstreamBindings = [
        { id: 'inv', input: 'target' },
        { id: 'planned', input: 'work' },
        { id: 'deliver', input: 'work' },
      ] as const;
      for (const { id, input } of downstreamBindings) {
        const node = parsed.workflow.nodes.find(node => node.id === id);
        expect(node?.kind).toBe('include');
        if (node?.kind !== 'include') throw new Error(`${id} is not an include`);
        const binding = node.with?.[input];
        expect(binding).toBeString();
        expect(binding).toContain('$ARTIFACTS_DIR/triage.md');
        expect(binding).not.toContain('$INPUTS.target');
        expect(binding).not.toContain('Original work item:');
      }

      expect(content).not.toContain('Original work item:');
    });

    it('archon-deliver preserves the conditional-lens bindings', () => {
      const parsed = parseWorkflow(BUNDLED_WORKFLOWS['archon-deliver'], 'archon-deliver.yaml');
      if (parsed.workflow === null) throw new Error(parsed.error.error);

      const resolveScope = parsed.workflow.nodes.find(node => node.id === 'resolve-scope');
      expect(resolveScope).toBeDefined();
      expect(resolveScope?.kind).toBe('exec');
      if (resolveScope?.kind !== 'exec') throw new Error('resolve-scope is not executable');
      expect(resolveScope.runtime).toBe('bun');
      expect(resolveScope.script).toBe('resolve-review-scope');
      expect(resolveScope.with).toEqual({
        c_errors: '$classify.output.errors',
      });

      const review = parsed.workflow.nodes.find(node => node.id === 'review');
      expect(review?.kind).toBe('include');
      if (review?.kind !== 'include') throw new Error('review is not an include');
      expect(review.with).toMatchObject({
        scope: '$pr.output',
        work_order: '$INPUTS.work',
        errors: '$resolve-scope.output.errors',
        docs: '$classify.output.docs',
      });
      // One typed value carries the target — not the same number bound twice
      // beside a head branch nothing downstream reads (#2968).
      expect(review.with).not.toHaveProperty('pr_number');
      expect(review.with).not.toHaveProperty('pr_head');
    });

    it('archon-deliver delegates the optional CI read timeout to the engine', () => {
      const parsed = parseWorkflow(BUNDLED_WORKFLOWS['archon-deliver'], 'archon-deliver.yaml');
      if (parsed.workflow === null) throw new Error(parsed.error.error);

      const corrections = parsed.workflow.nodes.find(node => node.id === 'corrections');
      expect(corrections?.kind).toBe('loop_group');
      if (corrections?.kind !== 'loop_group') throw new Error('corrections is not a loop group');

      const ciNote = corrections.loop_group.nodes.find(node => node.id === 'ci-note');
      expect(ciNote?.kind).toBe('exec');
      if (ciNote?.kind !== 'exec') throw new Error('ci-note is not executable');
      expect(ciNote).toMatchObject({
        runtime: 'bun',
        timeout: 45_000,
        on_timeout: 'skip',
        with: { pr: { from: '$pr.output' } },
      });
      expect(ciNote.script).not.toContain('mktemp');
      expect(ciNote.script).not.toContain('GH_PID');
      expect(ciNote.script).not.toContain('WATCHDOG');

      const ciEvidence = corrections.loop_group.nodes.find(node => node.id === 'ci-evidence');
      expect(ciEvidence?.kind).toBe('exec');
      if (ciEvidence?.kind !== 'exec') throw new Error('ci-evidence is not executable');
      expect(ciEvidence).toMatchObject({
        runtime: 'bun',
        depends_on: ['ci-note'],
        trigger_rule: 'all_done',
        with: {
          note: {
            from: '$ci-note.output',
            if_skipped:
              'No CI evidence is available for this round (the check read timed out). Proceed on the review findings alone.',
          },
        },
      });

      const fix = corrections.loop_group.nodes.find(node => node.id === 'fix');
      expect(fix?.depends_on).toEqual(['ci-evidence']);
    });

    it('flip-ready names only what it needs, and never loses a gate to a longer chain', () => {
      // The flip used to name ten ancestors because a failure propagated exactly one
      // hop: a join that named only the tail of a chain never saw the chain's gates
      // fail. Failure-cascade skips carry `upstream_failed` across every hop now, so
      // the list is the four the flip actually needs. gate-validated, gate-ready and
      // validate are reachable through ci-verdict; ci-verdict stays because the rule
      // needs one successful dependency, and a clean-review delivery has no other.
      // That the cascade really blocks is proved by execution, not by this list —
      // deliver's validate-red* and late-red-unconverged fixtures expect the gate
      // itself as the failed node and never reach the flip.
      const parsed = parseWorkflow(BUNDLED_WORKFLOWS['archon-deliver'], 'archon-deliver.yaml');
      if (parsed.workflow === null) throw new Error(parsed.error.error);
      const flipReady = parsed.workflow.nodes.find(node => node.id === 'flip-ready');
      expect(flipReady?.depends_on).toEqual([
        'ci-verdict',
        'ci-attention-route',
        'ci-attention',
        'publish-pr-body',
      ]);
      expect(flipReady?.trigger_rule).toBe('none_failed_min_one_success');
    });

    it('archon-review exposes the three-way action contract behind a successful preflight', () => {
      const parsed = parseWorkflow(BUNDLED_WORKFLOWS['archon-review'], 'archon-review.yaml');
      if (parsed.workflow === null) throw new Error(parsed.error.error);

      expect(parsed.workflow.inputs?.work_order?.default).toBe('');
      // The run-owned PR reaches review as ONE typed value, `scope`. The
      // `target` preflight and its paired pr_number/pr_head inputs re-asserted
      // an invariant the engine already establishes — the run owns its worktree
      // and the PR was created in it — so they were cut (#2968).
      expect(parsed.workflow.nodes.find(node => node.id === 'target')).toBeUndefined();
      expect(parsed.workflow.inputs?.pr_number).toBeUndefined();
      expect(parsed.workflow.inputs?.pr_head).toBeUndefined();
      const scope = parsed.workflow.nodes.find(node => node.id === 'scope');
      expect(scope?.depends_on).toEqual(['mode']);
      expect(scope?.kind).toBe('agent');
      if (scope?.kind !== 'agent') throw new Error('scope is not an agent');
      expect(scope.output_format).toEqual({
        type: 'object',
        properties: { docs: { type: 'boolean' }, pr: { type: 'object' } },
        required: ['docs', 'pr'],
      });
      expect(parsed.workflow.inputs?.docs?.default).toBe('auto');
      const docs = parsed.workflow.nodes.find(node => node.id === 'docs');
      expect(docs?.when).toContain("$INPUTS.docs == 'auto' && $scope.output.docs == true");

      const specialists = ['code', 'seams', 'simplify', 'tests', 'errors', 'docs'];
      const reviewComplete = parsed.workflow.nodes.find(node => node.id === 'review-complete');
      expect(reviewComplete?.kind).toBe('exec');
      expect(reviewComplete?.depends_on).toEqual(specialists);
      expect(reviewComplete?.trigger_rule).toBe('all_done');

      const synthesize = parsed.workflow.nodes.find(node => node.id === 'synthesize');
      expect(synthesize?.kind).toBe('agent');
      if (synthesize?.kind !== 'agent') throw new Error('synthesize is not an agent');
      expect(synthesize.depends_on).toEqual(['scope', 'review-complete']);
      expect(synthesize.trigger_rule).toBeUndefined();
      expect(synthesize.output_format).toMatchObject({
        properties: {
          action: { type: 'string', enum: ['none', 'correct', 'replan'] },
        },
        required: expect.arrayContaining(['action']),
      });

      expect(parsed.workflow.model).toBe('medium');
      expect(parsed.workflow.inputs?.tests).toBeUndefined();
      expect(parsed.workflow.inputs?.comments).toBeUndefined();
      expect(parsed.workflow.inputs?.types).toBeUndefined();

      const commands = BUNDLED_COMMANDS;
      expect(commands['__archon_pack__bundled:sdlc:review::review-code']).toContain(
        'Comments clarify functionality and how code is used'
      );
      expect(commands['__archon_pack__bundled:sdlc:review::review-seams']).toContain(
        'reachable invalid state with a concrete consequence'
      );
      // The lens this restores was cut as inert, not as unwanted (#2898/#2899): its charter
      // demoted every finding to a Suggestion. Pin the two halves of the posture that
      // replaced it — the values frame it reasons from, and the blocking severity.
      expect(commands['__archon_pack__bundled:sdlc:review::review-simplify']).toContain(
        'Writing code is cheap; maintaining it and recovering option value are not'
      );
      expect(commands['__archon_pack__bundled:sdlc:review::review-simplify']).toContain(
        'a verdict may rest on simplification alone'
      );
      expect(commands['__archon_pack__bundled:sdlc:review::review-synthesize']).toContain(
        'report-round-N.md'
      );
      expect(commands['__archon_pack__bundled:sdlc:review::review-synthesize']).toContain(
        '`sources`'
      );

      for (const lens of specialists) {
        expect(commands[`__archon_pack__bundled:sdlc:review::review-${lens}`]).toContain(
          `sources: [${lens}]`
        );
      }
    });

    // Attribution is only measurable if it lands somewhere a script can read (#2898):
    // `scripts/lens-yield.ts` tallies these records, so the instruction that produces
    // them and the fields it names are the contract that script depends on.
    it('review synthesis writes findings attribution as a machine-readable sidecar', () => {
      const synthesize = BUNDLED_COMMANDS['__archon_pack__bundled:sdlc:review::review-synthesize'];
      expect(synthesize).toContain('$ARTIFACTS_DIR/review/findings.json');
      expect(synthesize).toContain('{id, severity, sources, claim, status, round}');
      // Carried-forward findings keep the lens that found them, or a multi-round review
      // reattributes every surviving finding to its last round.
      expect(synthesize).toContain('keeping the `sources` it was first attributed to');
    });

    // The lenses judge defects in what changed; only synthesis runs on every round, so it
    // owns holding the change to the contract's acceptance, invariants, and steering. Scope
    // must carry those items for it to judge, and an unmet one must block like any
    // Important finding and stay attributable in findings.json.
    it('review holds the change to the accepted contract on every round', () => {
      // Triage is where the delivery chain first restates the contract; a count or summary
      // of acceptance there is where the items were lost.
      expect(BUNDLED_COMMANDS['__archon_pack__bundled:sdlc:triage::triage']).toContain(
        "quote the source's invariants, acceptance items, and any solution steering"
      );
      const scope = BUNDLED_COMMANDS['__archon_pack__bundled:sdlc:review::review-scope'];
      expect(scope).toContain('list every **acceptance** item');
      const synthesize = BUNDLED_COMMANDS['__archon_pack__bundled:sdlc:review::review-synthesize'];
      expect(synthesize).toContain('## Judge contract coverage');
      expect(synthesize).toContain('`sources: [contract]`');
      expect(synthesize).toContain('An unmet contract item is an Important or Critical finding');
    });

    // The same "does this diff earn a docs review" call is made in two packs — at
    // delivery time by the classifier, and at review time when `docs` is `auto`. They
    // drifted once: only the delivery copy carried the trivial-diff carve-out, so the
    // same doc-adjacent typo fix earned the lens through one entry point and not the
    // other. Whitespace-normalized so the guard survives either file being rewrapped.
    it('applies the trivial-diff carve-out in both docs classifiers', () => {
      const squash = (text: string): string => text.replace(/\s+/g, ' ');
      const carveOut = 'a version bump, a one-line fix, a rename, a test-only tweak';
      expect(
        squash(BUNDLED_COMMANDS['__archon_pack__bundled:sdlc:deliver::classify-review-scope'])
      ).toContain(carveOut);
      expect(
        squash(BUNDLED_COMMANDS['__archon_pack__bundled:sdlc:review::review-scope'])
      ).toContain(carveOut);
    });

    // Calibration lesson 4 (#2898): the run that motivated this rewrite produced a false
    // Critical from a `bun test` invoked the one way AGENTS.md forbids.
    it('requires falsifying commands to follow the repository invocation rules', () => {
      const discipline = 'the package scripts and invocation rules its steering files name';
      expect(BUNDLED_COMMANDS['__archon_pack__bundled:sdlc:review::review-code']).toContain(
        discipline
      );
      expect(BUNDLED_COMMANDS['__archon_pack__bundled:sdlc:review::review-synthesize']).toContain(
        discipline
      );
    });

    it('should have valid YAML structure', () => {
      for (const content of Object.values(BUNDLED_WORKFLOWS)) {
        expect(content).toContain('name:');
        expect(content).toContain('description:');
        expect(content.includes('nodes:')).toBe(true);
      }
    });

    it('archon-validate marks the validate node as always_run (#3092)', () => {
      const parsed = parseWorkflow(BUNDLED_WORKFLOWS['archon-validate'], 'archon-validate.yaml');
      if (parsed.workflow === null) throw new Error(parsed.error.error);

      const validateNode = parsed.workflow.nodes.find(node => node.id === 'validate');
      if (validateNode === undefined || !('always_run' in validateNode)) {
        throw new Error('archon-validate has no executable validate node carrying always_run');
      }
      expect(validateNode.always_run).toBe(true);
    });

    // Replaces the deleted scripts/output-format-strict.test.ts, which guarded this
    // same bundled set with a prose exemption rule for pinned providers. The engine now
    // owns the rule (launch preflight + `archon validate workflows`), and this test is
    // the CI backstop proving the shipped set stays clean. Scan under a Codex default
    // profile: an unpinned node routes to the install's default assistant, so an install
    // pinned to Codex is the reachable strict case. A node explicitly pinned to a
    // non-enforcing provider (Claude) is the documented opt-out and is skipped.
    it('every bundled workflow satisfies Codex strict-mode required coverage', () => {
      const violations: string[] = [];

      type WalkNode = NonNullable<ReturnType<typeof parseWorkflow>['workflow']>['nodes'][number];

      const walk = (
        nodes: readonly WalkNode[],
        workflowProvider: string | undefined,
        name: string
      ): void => {
        for (const node of nodes) {
          if (isIncludeDirective(node)) continue;
          if (isLoopGroupNode(node)) {
            // Body nodes resolve against the workflow-level provider, not the group's
            // own `provider` field (mirrors visitProviderInvokingNodes).
            walk(node.loop_group.nodes, workflowProvider, name);
            continue;
          }
          // exec/bash/script certify local stdout; gate/halt/loop_group schemas are
          // inert (isOutputFormatEnforced); wait nodes carry an engine-injected
          // output_format that never reaches a provider. Only agent and loop kinds
          // both enforce output_format and send the schema to a provider.
          if (isExecNode(node) || isWaitNode(node) || !isOutputFormatEnforced(node)) continue;
          if (node.output_format === undefined) continue;

          const provider = 'provider' in node ? node.provider : workflowProvider;
          if (provider !== undefined && isRegisteredProvider(provider)) {
            if (!getProviderCapabilities(provider).requiresAllPropertiesRequired) continue;
          }
          // provider === undefined routes to the install default, scanned as Codex.
          for (const gap of findRequiredPropertyGaps(node.output_format, 'output_format')) {
            violations.push(
              `${name}:${node.id} ${gap.schemaPath} missing ${gap.missing.join(', ')}`
            );
          }
        }
      };

      for (const [name, content] of Object.entries(BUNDLED_WORKFLOWS)) {
        const parsed = parseWorkflow(content, `${name}.yaml`);
        if (parsed.workflow === null) throw new Error(parsed.error.error);
        walk(parsed.workflow.nodes, parsed.workflow.provider, name);
      }

      expect(violations).toEqual([]);
    });
  });

  describe('fork-safe PR creation (#2226)', () => {
    // In a clone of a fork, gh commands without an explicit --repo resolve the
    // base repo to the fork's UPSTREAM parent, publishing the user's diff
    // against the upstream repo (accidental upstream PRs #1543/#1416). Every
    // `gh pr create` invocation in the bundled defaults must pin `--repo` —
    // and so must the create-flow-adjacent `gh pr list/edit/ready` calls that
    // discover or mutate the just-created PR (an empty/unset --repo value does
    // NOT fail: gh silently falls back to its default resolution, verified).
    // `gh pr view` is intentionally NOT guarded here: review-path commands
    // (archon-pr-review-scope etc.) view explicit PR numbers supplied as
    // workflow input — pinning those is a separate concern.

    // Join backslash-continued shell lines so multi-line `gh pr create \`
    // blocks are checked as a single command.
    const mergeContinuations = (content: string): string[] => {
      const merged: string[] = [];
      let current = '';
      for (const line of content.split('\n')) {
        if (line.trimEnd().endsWith('\\')) {
          current += line.trimEnd().slice(0, -1) + ' ';
        } else {
          merged.push(current + line);
          current = '';
        }
      }
      if (current) merged.push(current);
      return merged;
    };

    const GUARDED = /gh pr (create|list|edit|ready)\b/;

    const assertPinned = (bundle: Record<string, string>): void => {
      for (const [name, content] of Object.entries(bundle)) {
        for (const line of mergeContinuations(content)) {
          if (!GUARDED.test(line)) continue;
          // Prose references to a failed command (hook texts) are not invocations.
          if (line.includes('gh pr create failed')) continue;
          expect(`${name}: ${line.trim()}`).toContain('--repo');
        }
      }
    };

    it('every gh pr create/list/edit/ready in bundled commands pins --repo', () => {
      assertPinned(BUNDLED_COMMANDS);
    });

    it('every gh pr create/list/edit/ready in bundled workflows pins --repo', () => {
      assertPinned(BUNDLED_WORKFLOWS);
    });
  });

  describe('run-owned public actions (#2909)', () => {
    it('records a PR identity and uses it for review, the body resync and the ready flip', () => {
      const pr = BUNDLED_WORKFLOWS['archon-pr'];
      const deliver = BUNDLED_WORKFLOWS['archon-deliver'];
      const sync = BUNDLED_COMMANDS['__archon_pack__bundled:sdlc:deliver::sync-pr-body'];

      expect(pr).toContain('output_type: pull-request');
      expect(deliver).not.toContain('output_type: public-action');
      expect(deliver).toContain('scope: "$pr.output"');
      const parsedDelivery = parseWorkflow(deliver, 'archon-deliver.yaml');
      if (parsedDelivery.workflow === null) throw new Error(parsedDelivery.error.error);
      const flip = parsedDelivery.workflow.nodes.find(node => node.id === 'flip-ready');
      expect(flip).toMatchObject({
        kind: 'exec',
        runtime: 'bun',
        script: 'flip-ready',
        with: { pr: { from: '$pr.output' } },
      });
      expect(deliver).not.toContain('git remote get-url origin');
      // A command node reads its node-local `with:` map through `$INPUTS.<name>`,
      // never the INPUTS_<UPPER_SNAKE> env form — that one is built only for
      // bash/script nodes, and naming it here left the agent reading the literal
      // token with no PR number in it (#2909 R1).
      expect(sync).toContain('$INPUTS.pr');
      expect(sync).toContain('$INPUTS.current_body');
      expect(sync).not.toContain('INPUTS_PR');

      // The public write belongs to a deterministic node, not to a prompt: the
      // identity it writes to is the recorded record, and the same node performs
      // the write whichever forge source the run selected.
      const prParsed = parseWorkflow(pr, 'archon-pr.yaml');
      if (prParsed.workflow === null) throw new Error(prParsed.error.error);
      const prNode = prParsed.workflow.nodes.find(node => node.id === 'pr');
      expect(prNode?.kind).toBe('agent');
      const publish = prParsed.workflow.nodes.find(node => node.id === 'publish');
      expect(publish).toMatchObject({ kind: 'exec', runtime: 'bun', script: 'publish-pr' });
      if (publish?.kind !== 'exec') throw new Error('publish is not an exec node');
      expect(publish.output_type).toBe('pull-request');
      expect(publish.output_format).toMatchObject({
        properties: {
          repo: {
            type: 'object',
            properties: { host: { type: 'string' }, path: { type: 'string' } },
            required: ['host', 'path'],
          },
          number: { type: 'integer' },
        },
        required: expect.arrayContaining(['repo', 'number', 'url', 'head', 'base', 'is_draft']),
      });
      expect(prParsed.workflow.returns).toBe('publish');

      const deliverParsed = parseWorkflow(deliver, 'archon-deliver.yaml');
      if (deliverParsed.workflow === null) throw new Error(deliverParsed.error.error);
      const syncNode = deliverParsed.workflow.nodes.find(node => node.id === 'sync-pr-body');
      expect(syncNode?.kind).toBe('agent');
      if (syncNode?.kind !== 'agent') throw new Error('sync-pr-body is not an agent node');
      // A command node carries its bindings on `source`, not the node root.
      expect(syncNode.source).toMatchObject({
        kind: 'command',
        with: { pr: '$pr.output', current_body: '$read-pr-body.output.body' },
      });
      expect(
        deliverParsed.workflow.nodes.find(node => node.id === 'publish-pr-body')
      ).toMatchObject({
        kind: 'exec',
        runtime: 'bun',
        script: 'publish-pr-body',
        with: { pr: '$pr.output', intent: '$sync-pr-body.output.intent' },
      });
      // Composition once dropped that binding while materializing the command body
      // and then reported both names as missing caller inputs, so archon-deliver
      // declared them with empty defaults purely to load inside ship/upkeep
      // (#2968 item 4). Composition keeps the binding now (#2964), so the decoys are
      // gone — and the empty default that used to be spliced in where the real value
      // belongs cannot come back with them.
      expect(deliverParsed.workflow.inputs?.pr_number).toBeUndefined();
      expect(deliverParsed.workflow.inputs?.pr_head).toBeUndefined();
    });

    it('publishes the review report from a deterministic node, not the reviewer', () => {
      const parsed = parseWorkflow(BUNDLED_WORKFLOWS['archon-review'], 'archon-review.yaml');
      if (parsed.workflow === null) throw new Error(parsed.error.error);
      expect(parsed.workflow.returns).toBe('publish');
      const publish = parsed.workflow.nodes.find(node => node.id === 'publish');
      expect(publish).toMatchObject({
        kind: 'exec',
        runtime: 'bun',
        script: 'publish-review',
        with: { pr: '$scope.output.pr' },
      });
      // The verdict the composing loop terminates on passes through unchanged.
      const synthesize = parsed.workflow.nodes.find(node => node.id === 'synthesize');
      if (synthesize?.kind !== 'agent' || publish?.kind !== 'exec') {
        throw new Error('review nodes have unexpected kinds');
      }
      expect(publish.output_format).toEqual(synthesize.output_format);
      const synthesizeCommand =
        BUNDLED_COMMANDS['__archon_pack__bundled:sdlc:review::review-synthesize'];
      expect(synthesizeCommand).not.toContain('gh pr comment');
      expect(synthesizeCommand).not.toContain('gh api');
    });

    it('uses check events as wake-ups while retaining bounded probes and deadlines', () => {
      const parsed = parseWorkflow(BUNDLED_WORKFLOWS['archon-deliver'], 'archon-deliver.yaml');
      if (parsed.workflow === null) throw new Error(parsed.error.error);

      for (const [groupId, probeId, pauseId] of [
        ['await-checks', 'ci-probe', 'ci-pause'],
        ['await-fix-checks', 'fix-ci-probe', 'fix-ci-pause'],
      ] as const) {
        const group = parsed.workflow.nodes.find(node => node.id === groupId);
        if (group?.kind !== 'loop_group') throw new Error(`${groupId} is not a loop group`);
        expect(group.loop_group.max_iterations).toBe(13);
        // Completion reads the probe's own certified field. It shelled out to `gh`
        // while a resumed wait was believed unable to see the iteration's outputs;
        // that was a quoting error in this predicate, not an engine limit, so the
        // reference is bare and the probe owns the answer.
        expect(group.loop_group.until_bash).toBe(`test $${probeId}.output.state != "pending"`);

        const probeIndex = group.loop_group.nodes.findIndex(node => node.id === probeId);
        const pauseIndex = group.loop_group.nodes.findIndex(node => node.id === pauseId);
        expect(probeIndex).toBeGreaterThanOrEqual(0);
        expect(pauseIndex).toBeGreaterThan(probeIndex);
        const pause = group.loop_group.nodes[pauseIndex];
        if (pause?.kind !== 'wait') throw new Error(`${pauseId} is not a wait node`);
        expect(pause.wait).toEqual({ event: 'checks.complete', deadline_ms: 300000 });
        expect(pause.wait).not.toHaveProperty('duration_ms');
        expect(pause.depends_on).toEqual([probeId]);
        expect(pause.when).toBe(`$${probeId}.output.state == 'pending'`);
      }
    });
  });

  // A binary install executes the shipped copies of the deliver check scripts, so
  // these run the bundled pack rather than the source tree. The full matrix for
  // both sources lives in .archon/scripts/__tests__; this pins the default and
  // the loud opt-in failure on what actually ships.
  describe('deliver check source (bundled pack)', () => {
    const runShipped = async (
      script: 'check-ci' | 'flip-ready',
      options: { source?: string; checks?: GhFake['checks'] }
    ): Promise<{ code: number; stdout: string; stderr: string; gh: string[] }> => {
      const root = mkdtempSync(join(tmpdir(), 'archon-bundled-checks-'));
      try {
        for (const [path, content] of Object.entries(BUNDLED_SCRIPT_PACKS.sdlc!.files)) {
          mkdirSync(dirname(join(root, 'sdlc', path)), { recursive: true });
          writeFileSync(join(root, 'sdlc', path), content);
        }
        const ghLog = join(root, 'gh.log');
        const preload = join(root, 'fake-gh.ts');
        writeFileSync(preload, fakeGhPreload({ checks: options.checks ?? 'fail' }, ghLog));
        const run = spawnSync(
          process.execPath,
          ['--preload', preload, join(root, 'sdlc', 'deliver', 'scripts', `${script}.ts`)],
          {
            cwd: root,
            encoding: 'utf8',
            env: {
              ...process.env,
              INPUTS_PR: JSON.stringify({
                repo: { host: 'github.com', path: 'owner/repo' },
                number: 42,
              }),
              ARCHON_SDLC_FORGE: options.source ?? '',
              ARCHON_CLI_COMMAND: '',
            },
          }
        );
        return {
          code: run.status ?? -1,
          stdout: run.stdout,
          stderr: run.stderr,
          gh: existsSync(ghLog) ? readFileSync(ghLog, 'utf8').split('\n').filter(Boolean) : [],
        };
      } finally {
        await removeTempTree(root);
      }
    };

    it('reads checks through gh by default', async () => {
      const probe = await runShipped('check-ci', {
        checks: [{ name: 'build', state: 'FAILURE', bucket: 'fail' }],
      });
      expect(probe.code).toBe(0);
      expect(JSON.parse(probe.stdout)).toEqual({
        state: 'red',
        detail: 'non-green checks: build (failure)',
      });
      expect(probe.gh[0]).toBe('pr checks 42 --repo github.com/owner/repo --json name,state');

      const flip = await runShipped('flip-ready', {
        checks: [{ name: 'build', state: 'SUCCESS', bucket: 'pass' }],
      });
      expect(flip.code).toBe(0);
      expect(flip.gh).toContain('pr ready 42 --repo github.com/owner/repo');
    });

    it('refuses the ready flip when the default gh read fails', async () => {
      const flip = await runShipped('flip-ready', { checks: 'fail' });
      expect(flip.code).not.toBe(0);
      expect(flip.stderr).toContain('flip-ready: could not read check state');
      expect(flip.gh.some(call => call.startsWith('pr ready'))).toBe(false);
    });

    it('fails loudly when the forge source is selected but unavailable', async () => {
      for (const script of ['check-ci', 'flip-ready'] as const) {
        const run = await runShipped(script, {
          source: 'forge',
          checks: [{ name: 'build', state: 'SUCCESS', bucket: 'pass' }],
        });
        expect(run.code).not.toBe(0);
        expect(run.stderr).toContain('ARCHON_SDLC_FORGE=forge: ARCHON_CLI_COMMAND is not set');
        expect(run.gh).toEqual([]);
      }
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

        const parsed = parseWorkflow(source, name);
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
          model: string | undefined;
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
});

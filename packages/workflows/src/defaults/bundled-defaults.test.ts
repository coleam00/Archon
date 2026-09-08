import { describe, it, expect } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  isBinaryBuild,
  BUNDLED_COMMANDS,
  BUNDLED_SCRIPTS,
  BUNDLED_WORKFLOWS,
  BUNDLED_WORKFLOW_OWNERS,
} from './bundled-defaults';
import {
  formatPackagedResourceReference,
  parsePackagedResourceReference,
} from '../packaged-workflow';
import { parseWorkflow } from '../loader';

// Resolve the on-disk defaults directories relative to this test file so the
// tests work regardless of cwd. From packages/workflows/src/defaults go up
// four levels to the repo root, then into .archon/.
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');
const COMMANDS_DIR = join(REPO_ROOT, '.archon/commands/defaults');
const WORKFLOWS_DIR = join(REPO_ROOT, '.archon/workflows/defaults');
// `legacy/` holds the deprecated-window defaults (#2781): same flat file
// convention, one grouping subfolder within the discovery depth cap.
const LEGACY_WORKFLOWS_DIR = join(WORKFLOWS_DIR, 'legacy');

function findPackagedScriptPath(scriptDir: string, name: string, extension: string): string {
  const filename = `${name}${extension}`;
  const direct = join(scriptDir, filename);
  if (existsSync(direct)) return direct;
  const matches = readdirSync(scriptDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(scriptDir, entry.name, filename))
    .filter(path => existsSync(path));
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one packaged script named ${filename} under ${scriptDir}, found ${matches.length}`
    );
  }
  return matches[0];
}

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
      for (const [name, script] of Object.entries(BUNDLED_SCRIPTS)) {
        expect(name.startsWith('__archon_pack__bundled:')).toBe(true);
        expect(['.ts', '.js', '.py']).toContain(script.extension);
        expect(['bun', 'uv']).toContain(script.runtime);
        expect(script.content.length).toBeGreaterThan(0);
        const packaged = parsePackagedResourceReference(name);
        expect(packaged).not.toBeNull();
        const scriptDir = join(
          REPO_ROOT,
          '.archon',
          'workflows',
          packaged!.owner.pack,
          packaged!.owner.workflow,
          'scripts'
        );
        const diskPath = findPackagedScriptPath(scriptDir, packaged!.name, script.extension);
        expect(script.content).toBe(readFileSync(diskPath, 'utf-8').replace(/\r\n/g, '\n'));
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
      expect(triage.with).toEqual({ target: '$INPUTS.target' });

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
      expect(resolveScope.runtime).toBe('uv');
      expect(resolveScope.script).toBe('resolve-review-scope');
      expect(resolveScope.with).toEqual({
        c_errors: '$classify.output.errors',
      });

      const review = parsed.workflow.nodes.find(node => node.id === 'review');
      expect(review?.kind).toBe('include');
      if (review?.kind !== 'include') throw new Error('review is not an include');
      expect(review.with).toMatchObject({
        scope: '$pr.output.url',
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
      expect(ciNote).toMatchObject({ runtime: 'uv', timeout: 45_000, on_timeout: 'skip' });
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

    it('archon-deliver validates review action before correction and carries the work order into recheck', () => {
      const parsed = parseWorkflow(BUNDLED_WORKFLOWS['archon-deliver'], 'archon-deliver.yaml');
      if (parsed.workflow === null) throw new Error(parsed.error.error);

      const reviewAction = parsed.workflow.nodes.find(node => node.id === 'review-action');
      expect(reviewAction?.kind).toBe('exec');
      if (reviewAction?.kind !== 'exec') throw new Error('review-action is not executable');
      expect(reviewAction.script).toBe('validate-review-action');
      expect(reviewAction.with).toEqual({
        ready: '$review.output.ready',
        action: '$review.output.action',
      });

      const corrections = parsed.workflow.nodes.find(node => node.id === 'corrections');
      expect(corrections?.kind).toBe('loop_group');
      if (corrections?.kind !== 'loop_group') throw new Error('corrections is not a loop group');
      expect(corrections.when).toBe("$review-action.output.action == 'correct'");
      expect(corrections.loop_group.until_bash).toContain(
        '$recheck-action.output.action != "correct"'
      );

      const recheck = corrections.loop_group.nodes.find(node => node.id === 'recheck');
      expect(recheck?.kind).toBe('include');
      if (recheck?.kind !== 'include') throw new Error('recheck is not an include');
      expect(recheck.with).toMatchObject({
        scope: '$pr.output.url',
        work_order: '$INPUTS.work',
      });
      expect(recheck.with).not.toHaveProperty('pr_number');
      expect(recheck.with).not.toHaveProperty('pr_head');

      const gateReady = parsed.workflow.nodes.find(node => node.id === 'gate-ready');
      expect(gateReady?.kind).toBe('exec');
      if (gateReady?.kind !== 'exec') throw new Error('gate-ready is not executable');
      expect(gateReady.with).toEqual({
        review_ready: { from: '$review-action.output.ready', if_skipped: false },
        review_action: { from: '$review-action.output.action', if_skipped: null },
        correction_ready: { from: '$corrections.output.ready', if_skipped: false },
        correction_action: { from: '$corrections.output.action', if_skipped: null },
      });
    });

    it('flip-ready directly depends on every failable gate ancestor', () => {
      const parsed = parseWorkflow(BUNDLED_WORKFLOWS['archon-deliver'], 'archon-deliver.yaml');
      if (parsed.workflow === null) throw new Error(parsed.error.error);
      const flipReady = parsed.workflow.nodes.find(node => node.id === 'flip-ready');
      expect(flipReady?.depends_on).toContain('gate-validated');
      expect(flipReady?.depends_on).toContain('gate-ready');
      expect(flipReady?.depends_on).toContain('validate');
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
        properties: { docs: { type: 'boolean' } },
        required: ['docs'],
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

  describe('forge-owned public actions', () => {
    it('loads command judgments and deterministic public writes without a pack PR schema', () => {
      const publicNodes = [
        ['archon-pr', 'pr'],
        ['archon-deliver', 'sync-pr-body'],
        ['archon-deliver', 'flip-ready'],
        ['archon-review', 'publish'],
      ];
      for (const [name, id] of publicNodes) {
        const parsed = parseWorkflow(BUNDLED_WORKFLOWS[name], name);
        if (!parsed.workflow) throw new Error(parsed.error.error);
        const node = parsed.workflow.nodes.find(node => node.id === id);
        expect(node?.kind).toBe('exec');
        if (node?.kind !== 'exec') throw new Error('missing public exec node');
        if (id === 'pr') expect(node.output_format).toEqual({ type: 'object' });
        else if (id !== 'publish') expect(node.output_format).toBeUndefined();
      }
      expect(BUNDLED_WORKFLOWS['archon-pr']).toContain('command: pr');
      expect(BUNDLED_WORKFLOWS['archon-deliver']).toContain('command: sync-pr-body');
      expect(BUNDLED_WORKFLOWS['archon-review']).toContain('returns: publish');
      expect(BUNDLED_WORKFLOWS['archon-deliver']).toContain('$pr.output.ref');
      // This assertion governs publication in the PR, delivery and review packs.
      const publicPacks = publicNodes.map(([name]) => `:sdlc:${name.replace('archon-', '')}::`);
      for (const [name, entry] of Object.entries(BUNDLED_SCRIPTS)) {
        if (publicPacks.some(pack => name.includes(pack)))
          expect(entry.content).not.toMatch(/\bgh\b/);
      }
      for (const [name, entry] of Object.entries(BUNDLED_COMMANDS)) {
        if (publicPacks.some(pack => name.includes(pack))) expect(entry).not.toMatch(/\bgh\b/);
      }
    });
    it('preserves native bounded CI waits and checks wakeups', () => {
      const parsed = parseWorkflow(BUNDLED_WORKFLOWS['archon-deliver'], 'archon-deliver');
      if (!parsed.workflow) throw new Error(parsed.error.error);
      for (const id of ['await-checks', 'await-fix-checks']) {
        const node = parsed.workflow.nodes.find(node => node.id === id);
        if (node?.kind !== 'loop_group') throw new Error('missing CI loop');
        expect(node.loop_group.max_iterations).toBe(13);
        expect(node.loop_group.until_bash).toContain('"forge","checks"');
        const pause = node.loop_group.nodes.find(node => node.kind === 'wait');
        if (pause?.kind !== 'wait') throw new Error('missing native wait');
        expect(pause.wait).toEqual({ event: 'checks.complete', deadline_ms: 300000 });
      }
    });
  });
});

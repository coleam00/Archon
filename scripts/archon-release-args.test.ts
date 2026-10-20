import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { cliArgOptions } from '../packages/cli/src/args';
import { evaluateCondition } from '../packages/workflows/src/condition-evaluator';
import { certifyExecOutput } from '../packages/workflows/src/dag/nodes/exec/exec-output';
import {
  declaredOutputPathsFromSchema,
  type JsonValue,
  OUTPUT_REF_SOURCE,
} from '../packages/workflows/src/output-ref';
import { execNodeSchema, type ExecNode, type NodeOutput } from '../packages/workflows/src/schemas';

/**
 * The release workflow's own contract, checked against the workflow's own bodies.
 *
 * The workflow's release tail is gated on the argument node's output, so a body that
 * stops reading the message turns a `--dry-run` request into a real release, and a
 * release node that loses its dry-run guard runs inside a preview. Nothing else in the
 * repository reports either: the corpus lint reads the YAML but never runs a body.
 */
const REPO = join(import.meta.dir, '..');
const WORKFLOW = join(REPO, '.archon', 'workflows', 'experimental', 'archon-release.yaml');

/** The node that reports the run's outcome. It runs in both modes. */
const SUMMARY_ID = 'final-summary';

/** One node of the workflow, as the YAML declares it. */
interface WorkflowNode {
  id: string;
  script?: string;
  runtime?: string;
  when?: string;
  depends_on?: string[];
  wait?: { form?: string };
  cancel?: string;
  trigger_rule?: string;
  output_format?: Record<string, unknown>;
}

/** The workflow, as the YAML declares it. */
interface WorkflowSource {
  description: string;
  nodes: WorkflowNode[];
}

function workflowSource(): WorkflowSource {
  const parsed: unknown = Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('archon-release.yaml did not parse into an object');
  }
  const { description, nodes } = parsed as { description?: unknown; nodes?: unknown };
  if (typeof description !== 'string') throw new Error('archon-release.yaml has no description');
  if (!Array.isArray(nodes)) throw new Error('archon-release.yaml has no nodes list');
  return {
    description,
    nodes: nodes.map(node => {
      if (typeof node !== 'object' || node === null) {
        throw new Error('archon-release.yaml has a node that is not an object');
      }
      return node as WorkflowNode;
    }),
  };
}

const SOURCE = workflowSource();

const NODES = SOURCE.nodes;

function nodeById(id: string): WorkflowNode {
  const node = NODES.find(candidate => candidate.id === id);
  if (node === undefined) throw new Error(`archon-release.yaml has no ${id} node`);
  return node;
}

/** The `script:` body of the workflow's `parse-args` node. */
function parseArgsBody(): string {
  const body = nodeById('parse-args').script;
  if (typeof body !== 'string')
    throw new Error('archon-release.yaml has no parse-args script node');
  return body;
}

const BODY = parseArgsBody();

/**
 * The bound the workflow's own script nodes declare (`timeout: 5000`). The engine
 * fails a node that overruns it; the helper fails the test the same way, so a body
 * that never settles cannot hang the shard.
 */
const SCRIPT_TIMEOUT_MS = 5000;

/**
 * Runs a `script:` body the way the engine runs it: a Bun subprocess with the body on
 * `-e`. The run message arrives in the environment, because a `script:` body never
 * substitutes it into the source. Returns the stdout the body printed, as the engine
 * records it: the trailing newline trimmed.
 */
function runScript(body: string, env: Record<string, string | undefined>): string {
  const result = Bun.spawnSync([process.execPath, '--no-env-file', '-e', body], {
    cwd: REPO,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: SCRIPT_TIMEOUT_MS,
  });
  if (result.exitCode === null) {
    throw new Error(`the script body did not finish within ${SCRIPT_TIMEOUT_MS}ms`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `the script body exited ${String(result.exitCode)}: ${result.stderr.toString()}`
    );
  }
  return result.stdout.toString().replace(/\n$/, '');
}

/**
 * The producer's stdout. `undefined` leaves the message variable unset.
 */
function runParseArgs(message: string | undefined): string {
  const env: Record<string, string | undefined> = { ...process.env };
  if (message === undefined) delete env.ARGUMENTS;
  else env.ARGUMENTS = message;
  return runScript(BODY, env);
}

/** The producer's printed JSON. */
function parseArgsJson(message: string | undefined): JsonValue {
  return JSON.parse(runParseArgs(message)) as JsonValue;
}

/** The producer node as the engine runs it: its body and the contract it declares. */
function parseArgsNode(): ExecNode {
  const node = nodeById('parse-args');
  return execNodeSchema.parse({
    kind: 'exec',
    id: node.id,
    script: BODY,
    runtime: node.runtime,
    output_format: node.output_format,
  });
}

/**
 * The run messages the workflow accepts, and the output each one must produce.
 *
 * These are message texts, not command lines: the CLI parses any argument that starts
 * with `--` as one of its own options, so `"--dry-run minor"` reaches the workflow
 * only through the API route, which delivers the message byte for byte as its
 * `$ARGUMENTS`.
 */
const MESSAGES: readonly (readonly [string, JsonValue])[] = [
  // The producer reads the flag in any position; only the CLI delivers a message
  // that does not start with `--`.
  ['minor --dry-run', { bump: 'minor', dryRun: 'true' }],
  ['dry-run minor', { bump: 'minor', dryRun: 'true' }],
  ['--dry-run minor', { bump: 'minor', dryRun: 'true' }],
  ['major', { bump: 'major', dryRun: 'false' }],
  ['patch', { bump: 'patch', dryRun: 'false' }],
  ['', { bump: 'patch', dryRun: 'false' }],
  // The messages the description's examples carry.
  ['minor', { bump: 'minor', dryRun: 'false' }],
  ['patch --dry-run', { bump: 'patch', dryRun: 'true' }],
  ['dry-run', { bump: 'patch', dryRun: 'true' }],
];

describe('archon-release argument parsing', () => {
  test.each(MESSAGES)('reads %p from the run message', (message: string, expected: JsonValue) => {
    expect(parseArgsJson(message)).toEqual(expected);
  });

  test('defaults to a patch release when the run message is unset', () => {
    expect(parseArgsJson(undefined)).toEqual({ bump: 'patch', dryRun: 'false' });
  });
});

/**
 * A documented example: the command an operator copies, and the comment that says
 * what it does.
 */
interface DocumentedExample {
  /** The run message the command carries, as the shell hands it to the CLI. */
  message: string;
  /** The comment that states what the command does. */
  comment: string;
}

/**
 * The shape of a documented example: the command, a quoted run message, and a comment
 * that says what the command does. A line in any other shape is a shape the test
 * cannot judge, so it fails loudly instead of being skipped.
 */
const DOCUMENTED_EXAMPLE = /^archon workflow run archon-release "([^"]*)"\s+#\s*(.+)$/;

/**
 * The example commands in the workflow's description.
 *
 * The message is read out of the quoted argument, not out of a re-implemented shell:
 * the shell has already removed the quotes by the time the CLI parses them, and the
 * message is the value that crosses the seam.
 */
function documentedExamples(): DocumentedExample[] {
  const examples: DocumentedExample[] = [];
  for (const line of SOURCE.description.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('archon workflow run ')) continue;
    const match = DOCUMENTED_EXAMPLE.exec(text);
    if (match === null) {
      throw new Error(
        `the documented example is not a quoted message with a comment that says what it does: ${text}`
      );
    }
    examples.push({ message: match[1], comment: match[2] });
  }
  return examples;
}

/**
 * What a documented example claims to do, read from the comment that names it.
 *
 * The comment is the description's own claim about the command beside it: a preview
 * comment names the dry run, a release comment does not.
 */
function claimsPreview(comment: string): boolean {
  return comment.includes('dry-run');
}

/** The producer's dry-run flag for a run message. */
function dryRunFor(message: string): string {
  const output = parseArgsJson(message);
  if (typeof output !== 'object' || output === null || Array.isArray(output)) {
    throw new Error(`the producer printed no object for the message ${JSON.stringify(message)}`);
  }
  const { dryRun } = output;
  if (typeof dryRun !== 'string') {
    throw new Error(
      `the producer printed no dryRun flag for the message ${JSON.stringify(message)}`
    );
  }
  return dryRun;
}

/** The CLI's parse of a documented example, the way the CLI parses argv. */
function parseExample(argv: string[]): { positionals: string[] } {
  try {
    return parseArgs({ args: argv, options: cliArgOptions, allowPositionals: true, strict: true });
  } catch (error) {
    throw new Error(
      `the CLI rejects the documented example "${argv.join(' ')}": ${(error as Error).message}`
    );
  }
}

/**
 * The workflow's own examples must reach the workflow, and do what the description
 * says they do.
 *
 * The CLI parses any argument that starts with `--` as one of its own options, so a
 * documented example whose message starts with `--` never reaches the workflow: the
 * CLI answers with its own in-memory simulation instead of the release preview. And a
 * message the producer no longer reads as a dry run turns the documented preview into
 * a real release, which nothing else in the repository reports.
 */
describe('the documented commands', () => {
  test('every documented example reaches the workflow', () => {
    const examples = documentedExamples();
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      const argv = ['workflow', 'run', 'archon-release', example.message];
      const parsed = parseExample(argv);
      // An argument the CLI consumes as an option is an argument the workflow never sees.
      expect(parsed.positionals).toEqual(argv);
    }
  });

  test('every documented example is a message the producer contract covers', () => {
    const covered = MESSAGES.map(([message]) => message);
    const uncovered = documentedExamples()
      .map(example => example.message)
      .filter(message => !covered.includes(message));
    expect(uncovered).toEqual([]);
  });

  test('every documented example does what its comment says', () => {
    const mismatched = documentedExamples()
      .map(example => ({
        message: example.message,
        comment: example.comment,
        dryRun: dryRunFor(example.message),
        expected: claimsPreview(example.comment) ? 'true' : 'false',
      }))
      .filter(row => row.dryRun !== row.expected);
    expect(mismatched).toEqual([]);
  });
});

/**
 * The producer's declared contract, and the output that must satisfy it.
 *
 * The release tail reads `$parse-args.output.dryRun` by name, so the node declares
 * what it prints. The declaration only earns its keep while the engine enforces it:
 * the loader rejects a mistyped reference against the declared paths, and the exec
 * node certifies its own stdout against the declared schema. Nothing else in the
 * repository runs the producer, so without these two checks a deleted declaration —
 * or one narrowed until the producer's real output no longer satisfies it — leaves
 * the suite green and moves the failure to run time, after the live checkout has
 * been fast-forwarded and the binary compiled.
 */
describe('the parse-args output contract', () => {
  test('the producer declares the fields the release tail reads', () => {
    const declared = declaredOutputPathsFromSchema(nodeById('parse-args').output_format);
    expect([...(declared ?? [])].map(path => path.join('.')).sort()).toEqual(['bump', 'dryRun']);
  });

  test.each(MESSAGES)(
    'the output for %p satisfies the declared contract',
    (message: string, expected: JsonValue) => {
      const certified = certifyExecOutput(parseArgsNode(), runParseArgs(message), []);
      expect(certified.structuredOutput).toEqual(expected);
    }
  );

  test('the output satisfies the declared contract when the run message is unset', () => {
    const certified = certifyExecOutput(parseArgsNode(), runParseArgs(undefined), []);
    expect(certified.structuredOutput).toEqual({ bump: 'patch', dryRun: 'false' });
  });
});

/** The node's output as the engine records it: its printed JSON and its declared paths. */
function parseArgsOutput(message: string): NodeOutput {
  const json = parseArgsJson(message);
  return {
    state: 'completed',
    output: JSON.stringify(json),
    structuredOutput: json,
    declaredOutputPaths: declaredOutputPathsFromSchema(nodeById('parse-args').output_format),
  };
}

/** The nodes that wait for `id` directly. */
function directDependents(id: string): WorkflowNode[] {
  return NODES.filter(node => (node.depends_on ?? []).includes(id));
}

/**
 * Every node the graph reaches from `id` by waiting for it, directly or through
 * another node.
 */
function transitiveDependents(id: string): Set<string> {
  const reached = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    for (const dependent of directDependents(next)) {
      if (reached.has(dependent.id)) continue;
      reached.add(dependent.id);
      queue.push(dependent.id);
    }
  }
  return reached;
}

/**
 * The approval a dry run stops at: the approval no other approval waits for. The
 * release has two gates — the changelog review and the PR merge — and the dry run
 * ends at the first.
 */
function reviewGate(): WorkflowNode {
  const approvals = NODES.filter(node => node.wait?.form === 'approval');
  const first = approvals.filter(
    gate =>
      !approvals.some(other => other.id !== gate.id && transitiveDependents(other.id).has(gate.id))
  );
  const gate = first.at(0);
  if (gate === undefined || first.length !== 1) {
    throw new Error(
      `archon-release.yaml must have exactly one first release approval, found ${first.length}`
    );
  }
  return gate;
}

/**
 * The release phase: the part of the graph that waits for the review gate.
 *
 * The set comes from the graph, not from the closing summary's wait list, so a release
 * node added to the workflow joins it by construction instead of running inside a
 * preview with the guard green. The nodes that must run in both modes stay out of it:
 * a cancel node stops the run, and the summary reports it.
 */
function releasePhase(): { gate: WorkflowNode; phase: WorkflowNode[] } {
  const gate = reviewGate();
  const downstream = transitiveDependents(gate.id);
  const phase = NODES.filter(
    node => downstream.has(node.id) && node.cancel === undefined && node.id !== SUMMARY_ID
  );
  return { gate, phase };
}

/**
 * The node outputs a release leaves behind: both approvals granted, homebrew present.
 * The dry run stops at the first approval, so the second one is the release's own.
 *
 * Both scenarios ask for the same release, so the preview reports the version the
 * release would publish.
 */
function scenario(dryRun: boolean): Map<string, NodeOutput> {
  const approved: NodeOutput = {
    state: 'completed',
    output: '{"decision":"approve"}',
    structuredOutput: { decision: 'approve' },
  };
  return new Map<string, NodeOutput>([
    ['parse-args', parseArgsOutput(dryRun ? 'minor --dry-run' : 'minor')],
    ['review-changelog', approved],
    ['wait-for-merge', approved],
    ['check-homebrew', { state: 'completed', output: 'true' }],
  ]);
}

/** The parsed flag as the engine records it: a dry run and a real run. */
const DRY_RUN_OUTPUT = scenario(true);
const RELEASE_OUTPUT = scenario(false);

/** The gate a dry run ends at: it runs in both modes. */
function assertApprovalGate(node: WorkflowNode): void {
  if (node.wait?.form !== 'approval') {
    throw new Error(`Node '${node.id}' runs in a dry run without being an approval gate`);
  }
}

/**
 * Every release-phase node is gated off by the dry-run flag, and its guard opens again
 * for a real release.
 *
 * The whole `when:` expression is evaluated, not just its dry-run atom: an expression
 * that ORs the flag with something else opens the node in a dry run, and an atom-only
 * check would miss that.
 */
function assertDryRunGuard(node: WorkflowNode): void {
  const when = node.when;
  if (typeof when !== 'string') {
    throw new Error(`Node '${node.id}' runs in a dry run: it declares no when: guard`);
  }
  const dry = evaluateCondition(when, DRY_RUN_OUTPUT);
  if (!dry.parsed) {
    throw new Error(`Node '${node.id}' has an unparseable when: ${when}`);
  }
  if (dry.result) {
    throw new Error(`Node '${node.id}' is not gated off by the dry-run flag: ${when}`);
  }
  const release = evaluateCondition(when, RELEASE_OUTPUT);
  if (!release.parsed || !release.result) {
    throw new Error(`Node '${node.id}' never runs, dry run or not: ${when}`);
  }
}

describe('archon-release dry-run gate', () => {
  test('every node in the release phase is gated off by the dry-run flag', () => {
    const { gate, phase } = releasePhase();
    expect(phase.length).toBeGreaterThan(0);
    assertApprovalGate(gate);
    for (const node of phase) assertDryRunGuard(node);
  });
});

/**
 * The stack the version producer reads: the version file the release ships and the
 * version it bumps. A fixture, because the real node reads the repository's own
 * package.json and the test must not follow the repository's version.
 */
const DETECT_STACK_OUTPUT = JSON.stringify({
  stack: 'node',
  versionFile: 'package.json',
  currentVersion: '0.12.1',
});

/**
 * A body's node-output references, replaced the way the engine replaces them: the
 * producer's own text goes in verbatim. The scanner is built from the engine's own
 * grammar, so it cannot drift from the rule the engine applies.
 */
function substituteOutputs(body: string, outputs: Record<string, string>): string {
  return body.replace(new RegExp(OUTPUT_REF_SOURCE, 'g'), (match: string, nodeId: string) => {
    const text = outputs[nodeId];
    if (text === undefined) {
      throw new Error(`the body reads ${match}, which no node produced`);
    }
    return text;
  });
}

/** The version producer's body with the engine's node-output substitutions applied. */
function bumpVersionBody(parseArgsText: string): string {
  const body = nodeById('bump-version').script;
  if (typeof body !== 'string') {
    throw new Error('archon-release.yaml has no bump-version script node');
  }
  return substituteOutputs(body, {
    'parse-args': parseArgsText,
    'detect-stack': DETECT_STACK_OUTPUT,
  });
}

/** The version producer as the engine runs it: its body and the contract it declares. */
function bumpVersionNode(): ExecNode {
  const node = nodeById('bump-version');
  return execNodeSchema.parse({
    kind: 'exec',
    id: node.id,
    script: node.script,
    runtime: node.runtime,
    output_format: node.output_format,
  });
}

/** The version producer's own stdout, run the way the engine runs it. */
function runBumpVersion(parseArgsText: string): string {
  return runScript(bumpVersionBody(parseArgsText), { ...process.env });
}

/**
 * The version producer's declared contract, and the output that must satisfy it.
 *
 * The release tail reads `$bump-version.output.newVersion` by name, so the node
 * declares what it prints. The declaration is the one wire the producer, the
 * consumers and this test share: the loader rejects a reference the declaration
 * does not authorize, and the engine certifies the producer's stdout against it.
 * Without that certification a renamed field leaves the suite green while the
 * summary prints "RELEASE COMPLETE — vundefined".
 */
describe('the bump-version output contract', () => {
  test('the producer declares the fields the release tail reads', () => {
    const declared = declaredOutputPathsFromSchema(nodeById('bump-version').output_format);
    expect([...(declared ?? [])].map(path => path.join('.')).sort()).toEqual([
      'bump',
      'newVersion',
      'oldVersion',
      'stack',
      'versionFile',
    ]);
  });

  test("the producer's output satisfies the contract it declares", () => {
    const certified = certifyExecOutput(
      bumpVersionNode(),
      runBumpVersion(runParseArgs('minor')),
      []
    );
    expect(certified.structuredOutput).toEqual({
      oldVersion: '0.12.1',
      newVersion: '0.13.0',
      bump: 'minor',
      stack: 'node',
      versionFile: 'package.json',
    });
  });
});

/**
 * The closing summary's body with the engine's node-output substitutions applied.
 */
function summaryBody(parseArgsText: string, bumpVersionText: string): string {
  const body = nodeById(SUMMARY_ID).script;
  if (typeof body !== 'string') {
    throw new Error('archon-release.yaml has no final-summary script node');
  }
  return substituteOutputs(body, {
    'parse-args': parseArgsText,
    'bump-version': bumpVersionText,
  });
}

/**
 * The summary the operator sees: a preview of a release, or the release itself. The
 * version producer runs with the same run message the release does, so the summary
 * reports the version that release would publish.
 */
function runSummary(dryRun: boolean): string {
  const parseArgsText = runParseArgs(dryRun ? 'minor --dry-run' : 'minor');
  const body = summaryBody(parseArgsText, runBumpVersion(parseArgsText));
  return runScript(body, { ...process.env });
}

/**
 * The closing summary is the only place the operator is told whether a release
 * happened, and nothing else in the repository runs its body: a plausible edit to the
 * mode comparison turns a dry run into a "release complete" report with the suite green.
 */
describe('the closing summary', () => {
  test('the summary runs whatever happened upstream', () => {
    // `all_done` is what lets the summary report a release phase that was skipped.
    expect(nodeById(SUMMARY_ID).trigger_rule).toBe('all_done');
  });

  test('a dry run reports the preview, not a release', () => {
    const summary = runSummary(true);
    expect(summary).toContain('DRY RUN COMPLETE');
    expect(summary).toContain('v0.13.0');
    expect(summary).not.toContain('RELEASE COMPLETE');
  });

  test('a real run reports the release', () => {
    const summary = runSummary(false);
    expect(summary).toContain('RELEASE COMPLETE');
    expect(summary).toContain('v0.13.0');
    expect(summary).not.toContain('DRY RUN COMPLETE');
  });
});

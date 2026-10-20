import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { trackTempRoots } from '@archon/paths/test-utils';
import { cliArgOptions } from '../packages/cli/src/args';
import { evaluateCondition } from '../packages/workflows/src/condition-evaluator';
import { certifyExecOutput } from '../packages/workflows/src/dag/nodes/exec/exec-output';
import { substituteNodeOutputRefs } from '../packages/workflows/src/dag/references';
import {
  declaredOutputPathsFromSchema,
  type JsonValue,
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
  timeout?: number;
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
 * The description's two parts: the prose that names the vocabulary, and the example
 * block that shows the commands.
 *
 * The block is delimited by its marker, so every line in it is a command the guard
 * judges — a line in any other shape fails instead of being skipped.
 */
function splitDescription(): { prose: string[]; examples: string[] } {
  const lines = SOURCE.description.split('\n').map(line => line.trim());
  const marker = lines.indexOf('Examples:');
  if (marker === -1) throw new Error('archon-release.yaml has no Examples: block');
  const examples: string[] = [];
  for (const line of lines.slice(marker + 1)) {
    if (line === '') break;
    examples.push(line);
  }
  if (examples.length === 0) throw new Error('the Examples: block of archon-release.yaml is empty');
  return { prose: lines.slice(0, marker), examples };
}

const DESCRIPTION = splitDescription();

/**
 * The bound a node declares. The engine fails a node that overruns it; the helper
 * fails the test the same way, so a body that never settles cannot hang the shard.
 */
function nodeTimeout(id: string): number {
  const timeout = nodeById(id).timeout;
  if (typeof timeout !== 'number') {
    throw new Error(`archon-release.yaml declares no timeout for the ${id} node`);
  }
  return timeout;
}

/**
 * Runs a `script:` body the way the engine runs it: a Bun subprocess with the body on
 * `-e`. The run message arrives in the environment, because a `script:` body never
 * substitutes it into the source. Returns the stdout the body printed, as the engine
 * records it: the trailing newline trimmed.
 */
function runScript(
  body: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
  cwd = REPO
): string {
  const result = Bun.spawnSync([process.execPath, '--no-env-file', '-e', body], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
  });
  if (result.exitCode === null) {
    throw new Error(`the script body did not finish within ${timeoutMs}ms`);
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
  return runScript(BODY, env, nodeTimeout('parse-args'));
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
 * The bump vocabulary, as the argument node declares it.
 *
 * The argument node owns the set, and the version producer copies the value it parsed,
 * so this declaration is the only statement of the vocabulary. A second list would be
 * a second thing to keep in agreement, and a release of the type that fell out of it
 * would die at the version node.
 */
function bumpTypes(): string[] {
  const properties = parseArgsNode().output_format?.properties;
  if (typeof properties !== 'object' || properties === null) {
    throw new Error('the parse-args node declares no output_format properties');
  }
  const declared = (properties as Record<string, unknown>).bump;
  const values = (declared as { enum?: unknown } | undefined)?.enum;
  if (!Array.isArray(values)) {
    throw new Error('the parse-args node declares no bump vocabulary');
  }
  const types = values.filter((value): value is string => typeof value === 'string');
  if (types.length !== values.length || types.length === 0) {
    throw new Error('the parse-args node declares no bump vocabulary');
  }
  return types;
}

/**
 * The run messages the workflow accepts, and the output each one must produce.
 *
 * These are message texts, not command lines. The CLI's own option table claims any
 * argument that starts with `--`, so such a message reaches the workflow only when
 * the CLI's separator hands it over as a positional; the API route delivers the
 * message byte for byte as its `$ARGUMENTS` whatever it starts with.
 */
const MESSAGES: readonly (readonly [string, JsonValue])[] = [
  // The producer reads the flag in any position. A message that starts with `--`
  // reaches the workflow through the CLI's separator or through the API route.
  ['minor --dry-run', { bump: 'minor', dryRun: 'true' }],
  ['dry-run minor', { bump: 'minor', dryRun: 'true' }],
  ['--dry-run minor', { bump: 'minor', dryRun: 'true' }],
  ['--dry-run', { bump: 'patch', dryRun: 'true' }],
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
  /** Whether the command separates the message from the CLI's own options. */
  separated: boolean;
  /** The comment that states what the command does. */
  comment: string;
}

/**
 * The shape of a documented example: the command, an optional separator, a quoted run
 * message, and a comment that says what the command does. A line in any other shape is
 * a shape the test cannot judge, so it fails loudly instead of being skipped.
 */
const DOCUMENTED_EXAMPLE = /^archon workflow run archon-release (-- )?"([^"]*)"\s+#\s*(.+)$/;

/**
 * The example commands in the workflow's description.
 *
 * Every line of the example block is read: the message comes out of the quoted
 * argument, not out of a re-implemented shell, because the shell has already removed
 * the quotes by the time the CLI parses them, and the message is the value that crosses
 * the seam.
 */
function documentedExamples(): DocumentedExample[] {
  return DESCRIPTION.examples.map(line => {
    const match = DOCUMENTED_EXAMPLE.exec(line);
    if (match === null) {
      throw new Error(
        `the documented example is not a quoted message with a comment that says what it does: ${line}`
      );
    }
    return { message: match[2], separated: match[1] !== undefined, comment: match[3] };
  });
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

/** The argv the CLI receives for a documented example. */
function exampleArgv(example: DocumentedExample): string[] {
  return [
    'workflow',
    'run',
    'archon-release',
    ...(example.separated ? ['--'] : []),
    example.message,
  ];
}

/** The CLI's parse of a documented example, the way the CLI parses argv. */
function parseExample(argv: string[]): { values: Record<string, unknown>; positionals: string[] } {
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
 * The CLI's option table claims any argument that starts with `--`, so a message that
 * starts with one reaches the workflow only when the CLI's separator hands it over;
 * otherwise the CLI answers with its own in-memory simulation. And a message the
 * producer no longer reads as a dry run turns the documented preview into a real
 * release, which nothing else in the repository reports.
 */
describe('the documented commands', () => {
  test('the example block holds every command the description shows', () => {
    const shown = SOURCE.description
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.includes('archon workflow run'));
    expect(shown).toEqual(DESCRIPTION.examples);
  });

  test('a message that starts with the flag belongs to the CLI, not to the workflow', () => {
    // The rule the description states: the shell strips the quotes, so the CLI's own
    // option table claims a message that starts with the flag, and the workflow only
    // sees it when the separator hands it over.
    const parsed = parseExample(['workflow', 'run', 'archon-release', '--dry-run']);
    expect(parsed.values['dry-run']).toBe(true);
    expect(parsed.positionals).not.toContain('--dry-run');
  });

  test('every documented example reaches the workflow', () => {
    const examples = documentedExamples();
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      const parsed = parseExample(exampleArgv(example));
      // The message must survive as a positional: an argument the CLI consumes as one
      // of its own options is an argument the workflow never sees.
      expect(parsed.positionals).toEqual(['workflow', 'run', 'archon-release', example.message]);
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
 * The spellings the description's prose names, and what the producer reads them as.
 *
 * The operator types what the description names, so a name the producer no longer
 * reads as a dry run is a real release behind a documented preview.
 */
function proseTokens(): string[] {
  const tokens: string[] = [];
  for (const line of DESCRIPTION.prose) {
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      tokens.push(match[1]);
    }
  }
  return tokens;
}

/**
 * A token the CLI owns: its options and the separator that ends them. The description
 * may name one, but the workflow never receives it as a message.
 */
function isCliToken(token: string): boolean {
  return /^-+$/.test(token);
}

/**
 * Every name in the description's prose is a spelling the workflow accepts: a bump type
 * the argument node allows, or a message the producer reads as a dry run. A name that
 * is neither is one the operator would type into a release.
 */
describe("the description's vocabulary", () => {
  test('every name the description uses previews', () => {
    const covered = new Set(MESSAGES.map(([message]) => message));
    const types = new Set(bumpTypes());
    const unusable = proseTokens()
      .filter(token => !isCliToken(token) && !types.has(token))
      .flatMap(token => {
        if (!covered.has(token)) {
          return [`"${token}" is not a message the workflow accepts`];
        }
        if (dryRunFor(token) !== 'true') {
          return [`"${token}" is not a message the producer reads as a dry run`];
        }
        return [];
      });
    expect(unusable).toEqual([]);
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

/**
 * A producer's output as the engine records it: the text it printed, its value, and
 * the paths its own declaration authorizes.
 */
function producerOutput(nodeId: string, stdout: string): NodeOutput {
  return {
    state: 'completed',
    output: stdout,
    structuredOutput: JSON.parse(stdout) as JsonValue,
    declaredOutputPaths: declaredOutputPathsFromSchema(nodeById(nodeId).output_format),
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
    [
      'parse-args',
      producerOutput('parse-args', runParseArgs(dryRun ? 'minor --dry-run' : 'minor')),
    ],
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

const trackTempRoot = trackTempRoots();

/**
 * The version the release bumps. The stack producer reads it from the version file it
 * finds in its working directory, so the fixture is a file of its own: the test must
 * not follow the repository's own package.json.
 */
const FIXTURE_VERSION = '0.12.1';

/** The version each bump type publishes from the fixture's version. */
const EXPECTED_VERSION: Record<string, string> = {
  patch: '0.12.2',
  minor: '0.13.0',
  major: '1.0.0',
};

/**
 * The stack producer's own output: its real body, run against a temp directory that
 * holds a known version file.
 *
 * The producer's wire has one owner — the body that prints it. The test never re-types
 * the shape, so a producer that renames a field fails the release at the version node
 * instead of leaving the suite green.
 */
function runDetectStack(): NodeOutput {
  const body = nodeById('detect-stack').script;
  if (typeof body !== 'string') {
    throw new Error('archon-release.yaml has no detect-stack script node');
  }
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-release-stack-')));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: FIXTURE_VERSION }));
  return producerOutput(
    'detect-stack',
    runScript(body, { ...process.env }, nodeTimeout('detect-stack'), root)
  );
}

/**
 * The version producer's body with the engine's node-output substitutions applied.
 *
 * The substitution is the engine's own: it resolves the whole-output form and the
 * fielded form differently, and a body that reads a field must run here exactly as it
 * runs in the workflow.
 */
function bumpVersionBody(outputs: Map<string, NodeOutput>): string {
  const body = nodeById('bump-version').script;
  if (typeof body !== 'string') {
    throw new Error('archon-release.yaml has no bump-version script node');
  }
  return substituteNodeOutputRefs(body, outputs, []);
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

/**
 * The version producer's own stdout, run the way the engine runs it: the real argument
 * producer and the real stack producer feed it, and the engine's own substitution puts
 * their output in the body.
 */
function runBumpVersion(parseArgsText: string): string {
  const outputs = new Map<string, NodeOutput>([
    ['parse-args', producerOutput('parse-args', parseArgsText)],
    ['detect-stack', runDetectStack()],
  ]);
  return runScript(bumpVersionBody(outputs), { ...process.env }, nodeTimeout('bump-version'));
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

  test('the producer owes the release tail every field it reads', () => {
    // A producer that stops printing a field the release reads must fail at its own
    // node, not at the consumer that reads it.
    const incomplete = JSON.stringify({
      oldVersion: FIXTURE_VERSION,
      newVersion: '0.13.0',
      bump: 'minor',
    });
    expect(() => certifyExecOutput(bumpVersionNode(), incomplete, [])).toThrow(/stack/);
  });

  test.each(bumpTypes())(
    'a %s release satisfies the contract the producer declares',
    (bump: string) => {
      const certified = certifyExecOutput(
        bumpVersionNode(),
        runBumpVersion(runParseArgs(bump)),
        []
      );
      expect(certified.structuredOutput).toEqual({
        oldVersion: FIXTURE_VERSION,
        newVersion: EXPECTED_VERSION[bump],
        bump,
        stack: 'node',
        versionFile: 'package.json',
      });
    }
  );
});

/**
 * The closing summary's body with the engine's node-output substitutions applied.
 */
function summaryBody(outputs: Map<string, NodeOutput>): string {
  const body = nodeById(SUMMARY_ID).script;
  if (typeof body !== 'string') {
    throw new Error('archon-release.yaml has no final-summary script node');
  }
  return substituteNodeOutputRefs(body, outputs, []);
}

/**
 * The summary the operator sees: a preview of a release, or the release itself. The
 * version producer runs with the same run message the release does, so the summary
 * reports the version that release would publish.
 */
function runSummary(dryRun: boolean): string {
  const parseArgsText = runParseArgs(dryRun ? 'minor --dry-run' : 'minor');
  const outputs = new Map<string, NodeOutput>([
    ['parse-args', producerOutput('parse-args', parseArgsText)],
    ['bump-version', producerOutput('bump-version', runBumpVersion(parseArgsText))],
  ]);
  return runScript(summaryBody(outputs), { ...process.env }, nodeTimeout(SUMMARY_ID));
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

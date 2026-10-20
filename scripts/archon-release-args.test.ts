import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateCondition } from '../packages/workflows/src/condition-evaluator';
import { certifyExecOutput } from '../packages/workflows/src/dag/nodes/exec/exec-output';
import { declaredOutputPathsFromSchema } from '../packages/workflows/src/output-ref';
import { execNodeSchema, type ExecNode, type NodeOutput } from '../packages/workflows/src/schemas';
import { parseWhenExpression, type WhenAtom } from '../packages/workflows/src/when-atom';

/**
 * The release workflow's argument parsing, run the way the engine runs a `script:` node:
 * a Bun subprocess with the body on `-e` and the run message in the environment.
 *
 * The workflow's release tail is gated on this node's output, so a body that stops
 * reading the message turns a `--dry-run` request into a real release, and nothing else
 * in the repository reports it: the corpus lint reads the YAML but never runs a body.
 */
const REPO = join(import.meta.dir, '..');
const WORKFLOW = join(REPO, '.archon', 'workflows', 'experimental', 'archon-release.yaml');

/** One node of the workflow, as the YAML declares it. */
interface WorkflowNode {
  id: string;
  script?: string;
  runtime?: string;
  when?: string;
  depends_on?: string[];
  wait?: { form?: string };
  output_format?: Record<string, unknown>;
}

function workflowNodes(): WorkflowNode[] {
  const workflow: unknown = Bun.YAML.parse(readFileSync(WORKFLOW, 'utf8'));
  if (typeof workflow !== 'object' || workflow === null) {
    throw new Error('archon-release.yaml did not parse into an object');
  }
  const nodes: unknown = (workflow as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) throw new Error('archon-release.yaml has no nodes list');
  return nodes.map(node => {
    if (typeof node !== 'object' || node === null) {
      throw new Error('archon-release.yaml has a node that is not an object');
    }
    return node as WorkflowNode;
  });
}

const NODES = workflowNodes();

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
 * Runs the node's body with the given run message, the way the engine runs it: the
 * message arrives in the environment, because a `script:` body never substitutes it
 * into the source. `undefined` leaves the variable unset. Returns the stdout the
 * engine would certify, with the trailing newline trimmed.
 */
function runParseArgs(message: string | undefined): string {
  const env: Record<string, string | undefined> = { ...process.env };
  if (message === undefined) delete env.ARGUMENTS;
  else env.ARGUMENTS = message;
  const result = Bun.spawnSync([process.execPath, '--no-env-file', '-e', BODY], {
    cwd: REPO,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`parse-args exited ${String(result.exitCode)}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().replace(/\n$/, '');
}

/** The producer's printed JSON. */
function parseArgsJson(message: string | undefined): Record<string, unknown> {
  return JSON.parse(runParseArgs(message)) as Record<string, unknown>;
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

/** The run messages the workflow documents, and the output each one must produce. */
const MESSAGES: readonly (readonly [string, Record<string, unknown>])[] = [
  ['minor --dry-run', { bump: 'minor', dryRun: 'true' }],
  // The workflow's description offers both spellings, in any position.
  ['dry-run minor', { bump: 'minor', dryRun: 'true' }],
  ['--dry-run minor', { bump: 'minor', dryRun: 'true' }],
  ['major', { bump: 'major', dryRun: 'false' }],
  ['patch', { bump: 'patch', dryRun: 'false' }],
  ['', { bump: 'patch', dryRun: 'false' }],
];

describe('archon-release argument parsing', () => {
  test.each(MESSAGES)(
    'reads %p from the run message',
    (message: string, expected: Record<string, unknown>) => {
      expect(parseArgsJson(message)).toEqual(expected);
    }
  );

  test('defaults to a patch release when the run message is unset', () => {
    expect(parseArgsJson(undefined)).toEqual({ bump: 'patch', dryRun: 'false' });
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
    (message: string, expected: Record<string, unknown>) => {
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
 * The release phase: the nodes the closing summary waits on, minus the one that starts
 * the chain. That entry is the review gate — a dry run ends at it — so it runs in both
 * modes and carries no dry-run guard; every node after it belongs to the release.
 */
function releasePhase(): { gate: WorkflowNode[]; phase: WorkflowNode[] } {
  const waited = (nodeById('final-summary').depends_on ?? []).map(nodeById);
  const waitedIds = new Set(waited.map(node => node.id));
  const startsChain = (node: WorkflowNode): boolean =>
    !(node.depends_on ?? []).some(dep => waitedIds.has(dep));
  return {
    gate: waited.filter(startsChain),
    phase: waited.filter(node => !startsChain(node)),
  };
}

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

/** The comparison that reads the parsed dry-run flag. */
type DryRunAtom = WhenAtom & { ref: { kind: 'node'; nodeId: string; field: string | undefined } };

function isDryRunAtom(atom: WhenAtom): atom is DryRunAtom {
  return (
    atom.ref.kind === 'node' && atom.ref.nodeId === 'parse-args' && atom.ref.field === 'dryRun'
  );
}

/** The atom's own text, rebuilt from its parsed form so the engine evaluates it. */
function atomText(atom: DryRunAtom): string {
  const path = atom.ref.field === undefined ? 'output' : `output.${atom.ref.field}`;
  return `$${atom.ref.nodeId}.${path} ${atom.operator} '${atom.expected}'`;
}

/** The parsed flag as the engine records it: a dry run and a real run. */
const DRY_RUN_OUTPUT = new Map<string, NodeOutput>([['parse-args', parseArgsOutput('dry-run')]]);
const RELEASE_OUTPUT = new Map<string, NodeOutput>([['parse-args', parseArgsOutput('minor')]]);

/** The gate a dry run ends at: it runs in both modes. */
function assertApprovalGate(node: WorkflowNode): void {
  if (node.wait?.form !== 'approval') {
    throw new Error(`Node '${node.id}' runs in a dry run without being an approval gate`);
  }
}

/** Every release-phase node carries a dry-run guard, and that guard switches with the flag. */
function assertDryRunGuard(node: WorkflowNode): void {
  const when = node.when;
  if (typeof when !== 'string') {
    throw new Error(`Node '${node.id}' runs in a dry run: it declares no when: guard`);
  }
  const clauses = parseWhenExpression(when);
  if (clauses === null) {
    throw new Error(`Node '${node.id}' has an unparseable when: ${when}`);
  }
  for (const clause of clauses) {
    const guards = clause.filter(isDryRunAtom);
    if (guards.length === 0) {
      throw new Error(`Node '${node.id}' has a when: clause with no dry-run guard: ${when}`);
    }
    for (const guard of guards) assertGuardSwitchesWithTheFlag(node, guard, when);
  }
}

/** The guard closes for a dry run and opens for a real one. */
function assertGuardSwitchesWithTheFlag(node: WorkflowNode, guard: DryRunAtom, when: string): void {
  const text = atomText(guard);
  const dry = evaluateCondition(text, DRY_RUN_OUTPUT);
  if (!dry.parsed || dry.result) {
    throw new Error(`Node '${node.id}' is not gated off by the dry-run flag: ${when}`);
  }
  const release = evaluateCondition(text, RELEASE_OUTPUT);
  if (!release.parsed || !release.result) {
    throw new Error(`Node '${node.id}' never runs, dry run or not: ${when}`);
  }
}

describe('archon-release dry-run gate', () => {
  test('every node in the release phase is gated off by the dry-run flag', () => {
    const { gate, phase } = releasePhase();
    expect(gate.length).toBeGreaterThan(0);
    expect(phase.length).toBeGreaterThan(0);
    for (const node of gate) assertApprovalGate(node);
    for (const node of phase) assertDryRunGuard(node);
  });
});

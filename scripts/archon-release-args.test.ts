import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateCondition } from '../packages/workflows/src/condition-evaluator';
import { declaredOutputPathsFromSchema } from '../packages/workflows/src/output-ref';
import type { NodeOutput } from '../packages/workflows/src/schemas';
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
 * into the source. `undefined` leaves the variable unset.
 */
function runParseArgs(message: string | undefined): Record<string, unknown> {
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
  return JSON.parse(result.stdout.toString().trim()) as Record<string, unknown>;
}

describe('archon-release argument parsing', () => {
  test.each([
    ['minor --dry-run', { bump: 'minor', dryRun: 'true' }],
    // The workflow's description offers both spellings, in any position.
    ['dry-run minor', { bump: 'minor', dryRun: 'true' }],
    ['--dry-run minor', { bump: 'minor', dryRun: 'true' }],
    ['major', { bump: 'major', dryRun: 'false' }],
    ['patch', { bump: 'patch', dryRun: 'false' }],
    ['', { bump: 'patch', dryRun: 'false' }],
  ])('reads %p from the run message', (message: string, expected: Record<string, unknown>) => {
    expect(runParseArgs(message)).toEqual(expected);
  });

  test('defaults to a patch release when the run message is unset', () => {
    expect(runParseArgs(undefined)).toEqual({ bump: 'patch', dryRun: 'false' });
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
function parseArgsOutput(json: Record<string, unknown>): NodeOutput {
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

describe('archon-release dry-run gate', () => {
  test('every node in the release phase is gated off by the dry-run flag', () => {
    const dryRunOutput = new Map<string, NodeOutput>([
      ['parse-args', parseArgsOutput(runParseArgs('dry-run'))],
    ]);
    const releaseOutput = new Map<string, NodeOutput>([
      ['parse-args', parseArgsOutput(runParseArgs('minor'))],
    ]);
    const { gate, phase } = releasePhase();
    expect(gate.length).toBeGreaterThan(0);
    expect(phase.length).toBeGreaterThan(0);
    for (const node of gate) {
      // The gate is where a dry run ends, so it is the one node of the release tail
      // that runs in both modes.
      if (node.wait?.form !== 'approval') {
        throw new Error(`Node '${node.id}' runs in a dry run without being an approval gate`);
      }
    }
    for (const node of phase) {
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
        for (const guard of guards) {
          const text = atomText(guard);
          const dry = evaluateCondition(text, dryRunOutput);
          if (!dry.parsed || dry.result) {
            throw new Error(`Node '${node.id}' is not gated off by the dry-run flag: ${when}`);
          }
          const release = evaluateCondition(text, releaseOutput);
          if (!release.parsed || !release.result) {
            throw new Error(`Node '${node.id}' never runs, dry run or not: ${when}`);
          }
        }
      }
    }
  });
});

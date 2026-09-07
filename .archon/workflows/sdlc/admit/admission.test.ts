import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { admissionValues, validateJudgment, writeAdmission } from './scripts/admission';
import { parseWorkflow } from '../../../../packages/workflows/src/loader';
import { discoverWorkflows } from '../../../../packages/workflows/src/workflow-discovery';
import { dryRunWorkflow } from '../../../../packages/workflows/src/dry-run';
import { parseFixtureFile } from '../../../../packages/workflows/src/fixture-runner';
import { validateStructuredOutput } from '@archon/providers/structured-output';
import { liveSourceRoots } from '../../../../packages/workflows/src/workflow-source';

const track = trackTempRoots();
const repo = resolve(import.meta.dir, '../../../..');
const grounding = { route: 'deliver', summary: 'handler:12 lacks the required input check.' };
const judgment: ReturnType<typeof validateJudgment> = {
  decision: {
    disposition: 'accepted',
    priority: 'high',
    route: 'deliver',
    summary: 'Admit the verified reliability fix now.',
    assumptions: ['Reuse existing error presentation.'],
    rules_cited: ['Operator policy: prioritize verified reliability defects.'],
  },
  evidence: ['handler:12 accepts empty input despite the documented invariant.'],
};

async function scratch(): Promise<string> {
  return track(await mkdtemp(join(tmpdir(), 'admit-test-')));
}

describe('admission output and artifacts', () => {
  test('writes complete matching evidence artifacts and returns only the public decision', async () => {
    const root = await scratch();
    const artifacts = join(root, 'artifacts');
    const checkout = join(root, 'checkout');
    await mkdir(artifacts);
    await mkdir(checkout);
    await writeFile(join(checkout, 'source.txt'), 'untouched');
    const result = await writeAdmission(artifacts, judgment, grounding);
    expect(result).toEqual(judgment.decision);
    const json = JSON.parse(await readFile(join(artifacts, 'admission.json'), 'utf8'));
    expect(json).toEqual({ ...result, evidence: judgment.evidence, grounding });
    const markdown = await readFile(join(artifacts, 'admission.md'), 'utf8');
    for (const value of [
      ...Object.values(result).flat(),
      ...judgment.evidence,
      ...Object.values(grounding),
      'triage.md',
    ])
      expect(markdown).toContain(value);
    expect(await readdir(artifacts)).toEqual(['admission.json', 'admission.md']);
    expect(await readdir(checkout)).toEqual(['source.txt']);
    expect(await readFile(join(checkout, 'source.txt'), 'utf8')).toBe('untouched');
  });

  test('rejects each missing field, blank evidence, malformed values and undeclared fields', async () => {
    const invalid: unknown[] = [
      null,
      [],
      {},
      { ...judgment, evidence: [] },
      { ...judgment, evidence: [' '] },
      { ...judgment, evidence: [1] },
      { ...judgment, evidence: 'evidence' },
      { ...judgment, extra: true },
    ];
    for (const field of Object.keys(judgment)) {
      invalid.push(Object.fromEntries(Object.entries(judgment).filter(([key]) => key !== field)));
    }
    for (const field of Object.keys(judgment.decision)) {
      invalid.push({
        ...judgment,
        decision: Object.fromEntries(
          Object.entries(judgment.decision).filter(([key]) => key !== field)
        ),
      });
    }
    for (const changes of [
      { disposition: 'approved' },
      { priority: 'urgent' },
      { route: 'build' },
      { summary: ' ' },
      { assumptions: [''] },
      { rules_cited: [] },
      { rules_cited: [' '] },
      { extra: true },
      { route: 'no_action' },
      { disposition: 'rejected' },
      { disposition: 'deferred' },
      { disposition: 'needs-human' },
    ])
      invalid.push({ ...judgment, decision: { ...judgment.decision, ...changes } });
    const artifacts = await scratch();
    for (const value of invalid) {
      await expect(writeAdmission(artifacts, value, grounding)).rejects.toThrow();
      expect(await readdir(artifacts)).toEqual([]);
    }
    for (const value of [
      null,
      {},
      { route: 'invalid', summary: 'grounded' },
      { ...grounding, summary: ' ' },
    ]) {
      await expect(writeAdmission(artifacts, judgment, value)).rejects.toThrow();
      expect(await readdir(artifacts)).toEqual([]);
    }
  });

  test('validates every supported enum and keeps the authored schemas conformant', async () => {
    const parsed = parseWorkflow(
      await readFile(join(import.meta.dir, 'archon-admit.yaml'), 'utf8'),
      'archon-admit.yaml'
    );
    if (!parsed.workflow) throw new Error(parsed.error.error);
    const judge = parsed.workflow.nodes.find(node => node.id === 'judge');
    const admission = parsed.workflow.nodes.find(node => node.id === 'admission');
    if (judge?.kind !== 'agent' || admission?.kind !== 'exec') {
      throw new Error('Admission must judge with an agent and enforce with a script');
    }
    expect(judge?.output_format).toBeDefined();
    expect(admission?.output_format).toBeDefined();
    const schema = admission?.output_format;
    if (!schema || !judge?.output_format) throw new Error('Missing output schema');
    expect(schema.required).toEqual(Object.keys(validateJudgment(judgment).decision));
    for (const [field, values] of Object.entries(admissionValues)) {
      expect(schema).toMatchObject({ properties: { [field]: { enum: [...values] } } });
    }
    for (const disposition of admissionValues.disposition) {
      for (const route of admissionValues.route) {
        for (const priority of admissionValues.priority) {
          const value = {
            ...judgment,
            decision: { ...judgment.decision, disposition, route, priority },
          };
          if ((disposition === 'accepted') === (route === 'no_action')) {
            expect(() => validateJudgment(value)).toThrow();
          } else {
            expect(validateStructuredOutput(value, judge.output_format).valid).toBe(true);
            expect(validateStructuredOutput(validateJudgment(value).decision, schema).valid).toBe(
              true
            );
          }
        }
      }
    }
    expect(parsed.workflow.mutates_checkout).toBe(false);
    expect(judge).toMatchObject({ context: 'fresh', mutates_checkout: false });
    expect(admission).toMatchObject({ mutates_checkout: false, runtime: 'bun' });
  });

  test('executes every declared fixture against the real discovered workflow without target checkout edits', async () => {
    const workspace = await scratch();
    await writeFile(join(workspace, 'source.txt'), 'untouched');
    const sourceRoots = {
      ...liveSourceRoots(repo),
      globalWorkflows: join(workspace, 'absent-workflows'),
      globalCommands: join(workspace, 'absent-commands'),
      globalScripts: join(workspace, 'absent-scripts'),
    };
    const discovered = await discoverWorkflows(repo, { loadDefaults: false, sourceRoots });
    const workflow = discovered.workflows.find(
      item => item.workflow.name === 'archon-admit'
    )?.workflow;
    expect(workflow, JSON.stringify(discovered.errors)).toBeDefined();
    if (!workflow) throw new Error('Admission failed discovery');
    const fixtureDir = join(import.meta.dir, 'fixtures');
    for (const name of await readdir(fixtureDir)) {
      const fixture = parseFixtureFile(await readFile(join(fixtureDir, name), 'utf8'), name);
      const result = await dryRunWorkflow({
        workflow,
        cwd: repo,
        execWorkspace: workspace,
        sourceRoots,
        userMessage: 'Assess the missing input check.',
        inputs: fixture.declaration.inputs,
        stubs: fixture.stubs,
        execCode: fixture.execCode,
      });
      expect(result.outcome, `${name}: ${JSON.stringify(result.trace)}`).toBe(
        fixture.declaration.expect
      );
      const failed = result.trace
        .filter(entry => entry.state === 'failed')
        .map(entry => entry.nodeId);
      const expectedFailure = fixture.declaration['fail-node'];
      expect(failed, name).toEqual(
        typeof expectedFailure === 'string' ? [expectedFailure] : (expectedFailure ?? [])
      );
      if (fixture.declaration.expect === 'completed') {
        const admission = result.trace.find(entry => entry.nodeId === 'admission');
        expect(admission?.state, name).toBe('completed');
        expect(JSON.parse(admission?.output ?? '')).toEqual(
          validateJudgment(fixture.stubs.judge).decision
        );
      }
      for (const [node, fragment] of Object.entries(
        fixture.declaration['resolved-text-contains'] ?? {}
      )) {
        expect(result.trace.find(entry => entry.nodeId === node)?.resolvedText, name).toContain(
          fragment
        );
      }
      expect(await readdir(workspace), name).toEqual(['source.txt']);
      expect(await readFile(join(workspace, 'source.txt'), 'utf8'), name).toBe('untouched');
    }
  }, 30_000);
});

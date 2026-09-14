import { expect, it } from 'bun:test';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import type { MessageChunk } from '@archon/providers/types';
import { captureToolResult } from '../../../providers/src/shared/tool-capture';
import { ToolCaptureSession } from '../tool-capture';
import { assessRuntime } from './sdlc/runtime-evidence';
import { validateStructuredOutput } from '@archon/providers/structured-output';
import { parseWorkflow } from '../loader';

const track = trackTempRoots();
async function fixture() {
  const root = track(await mkdtemp(join(tmpdir(), 'runtime-capture-')));
  const directory = join(root, 'attempt');
  const capture = await ToolCaptureSession.create(
    root,
    join(directory, 'captures'),
    'run',
    'verify',
    1
  );
  const scenario = join(root, 'scenario.json');
  await writeFile(scenario, JSON.stringify({ assertions: [{ id: 'zero', expected: 0 }] }));
  await writeFile(join(directory, 'target.txt'), 'candidate\r\n');
  const reportPath = join(directory, 'report.json');
  const report = {
    candidate: 'candidate',
    assertions: [
      {
        id: 'zero',
        outcome: 'passed',
        observed: false,
        expected: 0,
        reason: 'semantic assessment owns interpretation',
        evidence: [{ call_id: 'call' }],
      },
    ],
  };
  await writeFile(reportPath, JSON.stringify(report));
  const input = {
    directory,
    reportPath,
    runId: 'run',
    scenario,
    requiredIds: ['zero'],
    expectedCandidate: 'candidate',
    startOk: true,
    identityOk: true,
  };
  return { root, capture, input, report };
}
async function retain(
  capture: ToolCaptureSession,
  output: unknown,
  completeness: 'full' | 'truncated' = 'full'
) {
  async function* stream(): AsyncGenerator<MessageChunk> {
    yield { type: 'tool', toolCallId: 'call', toolName: 'probe' };
    yield {
      type: 'tool_result',
      toolCallId: 'call',
      toolName: 'probe',
      toolOutput: 'display',
      toolOutcome: 'error',
      exitCode: 1,
      capture: { ...captureToolResult(output), completeness },
    };
    yield { type: 'result' };
  }
  for await (const message of capture.retain(stream(), [])) void message;
}

it('rejects an arbitrary nonempty file instead of treating it as execution evidence', async () => {
  const { input, report } = await fixture();
  await writeFile(join(input.directory, 'diagnostic.txt'), 'nonempty unrelated output');
  await writeFile(
    input.reportPath,
    JSON.stringify({
      ...report,
      assertions: [
        { ...report.assertions[0], evidence: undefined, evidence_path: 'diagnostic.txt' },
      ],
    })
  );
  expect((await assessRuntime(input)).status).toBe('malformed');
});

it('preserves false/zero measurements and expected failed commands with direct hashed references', async () => {
  const { input, capture } = await fixture();
  await retain(capture, 'false 0');
  const result = await assessRuntime(input);
  expect(result.status).toBe('verified');
  expect(result.evidence.producer).toMatchObject({ runId: 'run', nodeId: 'verify', iteration: 1 });
  expect(result.evidence.report_path).toBe(input.reportPath);
  expect(result.evidence.report_sha256).toHaveLength(64);
  expect(result.evidence.capture_manifest_sha256).toHaveLength(64);
});

it('rejects incomplete captures and textual screenshot claims without attachments', async () => {
  const { input, capture, report } = await fixture();
  await retain(capture, 'saved image at screenshot.png');
  report.assertions[0]!.evidence = [{ call_id: 'missing' }];
  await writeFile(input.reportPath, JSON.stringify(report));
  expect((await assessRuntime(input)).status).toBe('malformed');
  await writeFile(
    input.reportPath,
    JSON.stringify({
      ...report,
      assertions: [{ ...report.assertions[0], evidence: [{ call_id: 'call', attachment: 0 }] }],
    })
  );
  expect((await assessRuntime(input)).status).toBe('malformed');
  const truncated = await fixture();
  await retain(truncated.capture, 'partial', 'truncated');
  expect((await assessRuntime(truncated.input)).status).toBe('malformed');
});

it('runs the generated checker outside the checkout without source dependencies', async () => {
  const { input, capture, root } = await fixture();
  await retain(capture, 'false 0');
  const pack = join(root, 'verify-runtime');
  await cp(join(import.meta.dir, '../../../../.archon/workflows/sdlc/verify-runtime'), pack, {
    recursive: true,
  });
  const script = join(pack, 'scripts/check-evidence.js');
  const child = Bun.spawn([process.execPath, script], {
    cwd: root,
    env: {
      ...process.env,
      INPUTS_DIRECTORY: input.directory,
      INPUTS_REPORT_PATH: input.reportPath,
      INPUTS_REQUIRED_IDS: JSON.stringify(input.requiredIds),
      INPUTS_EXPECTED_CANDIDATE: input.expectedCandidate,
      INPUTS_START_OK: 'true',
      INPUTS_IDENTITY_OK: 'true',
      WORKFLOW_ID: input.runId,
      INPUTS_SCENARIO: input.scenario,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, text, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(error).toBe('');
  expect(code).toBe(0);
  expect(JSON.parse(text)).toMatchObject({
    status: 'verified',
    evidence: { evaluator_path: script },
  });
});

it('carries capture references through the production finish/gate scripts and declared schemas', async () => {
  const { input, capture, root } = await fixture();
  await retain(capture, 'false 0');
  const assessment = await assessRuntime(input);
  const packageDir = join(import.meta.dir, '../../../../.archon/workflows/sdlc/verify-runtime');
  const parsed = parseWorkflow(
    await readFile(join(packageDir, 'archon-verify-runtime.yaml'), 'utf8'),
    'archon-verify-runtime.yaml'
  );
  if (parsed.workflow === null) throw new Error(parsed.error.error);
  const loop = parsed.workflow.nodes.find(node => node.id === 'verify-loop');
  if (loop?.kind !== 'loop_group') throw new Error('missing runtime loop');
  const nodes = [...loop.loop_group.nodes, ...parsed.workflow.nodes];
  async function run(name: string, env: Record<string, string>): Promise<unknown> {
    const child = Bun.spawn([process.execPath, join(packageDir, 'scripts', `${name}.ts`)], {
      cwd: root,
      env: { ...process.env, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, text, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(error).toBe('');
    expect(code).toBe(0);
    return JSON.parse(text) as unknown;
  }
  const finished = await run('finish-attempt', {
    INPUTS_ASSESSMENT: JSON.stringify(assessment),
    INPUTS_TEARDOWN_OK: 'true',
    INPUTS_ATTEMPT: '1',
    INPUTS_ATTEMPT_LIMIT: '2',
    INPUTS_CHECKOUT: root,
  });
  const terminal = await run('gate-verified', { INPUTS_RESULT: JSON.stringify(finished) });
  for (const [id, result] of [
    ['check-evidence', assessment],
    ['finish-attempt', finished],
    ['gate-verified', terminal],
  ] as const) {
    const node = nodes.find(node => node.id === id);
    if (node?.kind !== 'exec' || node.output_format === undefined)
      throw new Error(`missing output schema for ${id}`);
    expect(
      validateStructuredOutput(result, node.output_format, error => {
        throw new Error(error);
      }).valid
    ).toBe(true);
  }
  expect(terminal).toMatchObject({ verified: true, evidence: assessment.evidence });
  const teardownFailed = await run('finish-attempt', {
    INPUTS_ASSESSMENT: JSON.stringify(assessment),
    INPUTS_TEARDOWN_OK: 'false',
    INPUTS_CHECKOUT: root,
  });
  expect(
    await run('gate-verified', { INPUTS_RESULT: JSON.stringify(teardownFailed) })
  ).toMatchObject({ verified: false, verdict: 'inconclusive', evidence: assessment.evidence });
});

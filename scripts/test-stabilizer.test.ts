import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateStructuredOutput } from '@archon/providers';

const repoRoot = join(import.meta.dir, '..');
const packRoot = join(repoRoot, '.archon', 'workflows', 'test-stabilizer');
const fixRoot = join(packRoot, 'fix');
const shipPath = join(fixRoot, 'scripts', 'ship.py');
const verifyPath = join(fixRoot, 'scripts', 'verify.py');
const verdictPath = join(fixRoot, 'scripts', 'verdict.py');
const batchRoot = join(packRoot, 'batch');
const prepareOrdersPath = join(batchRoot, 'scripts', 'prepare-orders.py');
const collectPath = join(batchRoot, 'scripts', 'collect.py');
const python = process.platform === 'win32' ? 'python' : 'python3';

function runPython(
  args: string[],
  env: Record<string, string> = {}
): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync([python, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

describe('standalone test stabilizer pack', () => {
  test('does not include or reference the SDLC pack', () => {
    const sources = filesBelow(packRoot).map(path => readFileSync(path, 'utf8'));

    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source).not.toMatch(/^\s*include:/m);
      expect(source).not.toContain('workflows/sdlc');
      expect(source).not.toContain('sdlc/');
    }

    for (const name of ['stabilize', 'stabilize-assess', 'stabilize-batch', 'stabilize-fix']) {
      expect(existsSync(join(repoRoot, '.archon', 'workflows', 'sdlc', name))).toBe(false);
    }
  });

  test('preserves diagnoses and separates implementation, validation, and review', () => {
    const batch = readFileSync(join(batchRoot, 'archon-stabilize-batch.yaml'), 'utf8');
    const fix = readFileSync(join(fixRoot, 'archon-stabilize-fix.yaml'), 'utf8');
    const verify = readFileSync(join(fixRoot, 'scripts', 'verify.py'), 'utf8');

    expect(batch).toContain('script: prepare-orders');
    expect(batch).toContain('items: "$prepare-orders.output.orders"');
    expect(batch).toContain('diagnosis_ids:');
    expect(batch).not.toContain('test_repetitions');
    expect(fix).toContain('context: fresh');
    expect(fix).toContain('mutates_checkout: false');
    expect(fix).toContain('max_iterations: 3');
    expect(fix).toContain('timeout: 1800000');
    expect(fix).toContain('timeout: 2760000');
    expect(verify).toContain('stabilizer-targeted.log');
    expect(verify).toContain('stabilizer-project.log');
    expect(verify).not.toContain('MAX_OUTPUT_CHARS');
  });

  test('keeps policy diagnosis-specific and preserves a no-target trigger message', () => {
    const assessor = readFileSync(join(packRoot, 'assess', 'commands', 'assess-target.md'), 'utf8');
    const implement = readFileSync(join(fixRoot, 'commands', 'implement-concern.md'), 'utf8');
    const review = readFileSync(join(fixRoot, 'commands', 'review-test-fix.md'), 'utf8');
    const single = readFileSync(join(packRoot, 'single', 'archon-stabilize.yaml'), 'utf8');

    for (const prompt of [assessor, implement, review]) {
      expect(prompt).not.toContain('Never raise timeouts');
      expect(prompt).not.toContain('platform-gate tests');
      expect(prompt).not.toContain('another implicit deadline');
    }
    expect(implement).toContain('forbidden_residuals');
    expect(review).toContain('forbidden_residuals');
    expect(single).toContain('$INPUTS.target');
    expect(single).toContain('$ARGUMENTS');
  });
});

describe('test stabilizer boundaries', () => {
  const diagnosis = (id: string, path: string) => ({
    assessment: {
      diagnosis_id: id,
      confirmed: true,
      title: `Diagnosis ${id}`,
      file: path,
      test_id: `test ${id}`,
      kind: 'make-test-meaningful',
      mechanism: `mechanism ${id}`,
      invariant: `invariant ${id}`,
      evidence: `evidence ${id}`,
      owned_paths: [path],
      shared_primitives: [`helper-${id}`],
      forbidden_residuals: [`residual-${id}`],
      verification: `verify ${id}`,
    },
  });
  const rejected = {
    assessment: {
      diagnosis_id: 'c',
      confirmed: false,
      title: 'Rejected c',
      file: 'c.test.ts',
      test_id: 'test c',
      evidence: 'candidate evidence',
      rejection_reason: 'The suspected call is fully mocked.',
    },
  };
  const assessments = [diagnosis('a', 'a.test.ts'), diagnosis('b', 'b.test.ts'), rejected];
  const orders = {
    orders: [
      {
        concern_id: 'a',
        title: 'Fix a',
        branch: 'fix/a',
        diagnosis_ids: ['a'],
        why_grouped: 'Owns a.',
      },
      {
        concern_id: 'b',
        title: 'Fix b',
        branch: 'fix/b',
        diagnosis_ids: ['b'],
        why_grouped: 'Owns b.',
      },
    ],
  };

  function prepare(candidateAssessments: unknown, candidateOrders: unknown) {
    return runPython([prepareOrdersPath], {
      INPUTS_ASSESSMENTS: JSON.stringify(candidateAssessments),
      INPUTS_ORDERS: JSON.stringify(candidateOrders),
    });
  }

  test('derives concern payloads from the assessor-owned diagnoses', () => {
    const result = prepare(assessments, orders);
    expect(result.exitCode, result.stderr?.toString() ?? '').toBe(0);

    const prepared = JSON.parse(result.stdout?.toString() ?? '') as {
      orders: Array<{
        diagnosis_ids: string[];
        owned_paths: string[];
        diagnoses: Array<{ diagnosis_id: string }>;
      }>;
    };
    expect(prepared.orders[0]).toMatchObject({
      diagnosis_ids: ['a'],
      owned_paths: ['a.test.ts'],
      diagnoses: [{ diagnosis_id: 'a' }],
    });
    expect(prepared.orders[1]).toMatchObject({
      diagnosis_ids: ['b'],
      owned_paths: ['b.test.ts'],
      diagnoses: [{ diagnosis_id: 'b' }],
    });
  });

  test('rejects incomplete, conflicting, or invented concern plans', () => {
    const cases: Array<[string, unknown, unknown]> = [
      ['missing from work orders', assessments, { orders: [orders.orders[0]] }],
      [
        'duplicate diagnosis assignment',
        assessments,
        { orders: [orders.orders[0], { ...orders.orders[1], diagnosis_ids: ['a'] }] },
      ],
      [
        'unknown diagnosis',
        assessments,
        { orders: [{ ...orders.orders[0], diagnosis_ids: ['unknown'] }, orders.orders[1]] },
      ],
      [
        'rejected diagnosis',
        assessments,
        {
          orders: [
            orders.orders[0],
            orders.orders[1],
            {
              concern_id: 'c',
              title: 'Fix c',
              branch: 'fix/c',
              diagnosis_ids: ['c'],
              why_grouped: 'Invalid rejected slot.',
            },
          ],
        },
      ],
      [
        'assessment slot 3 failed',
        [...assessments, { archon_failed: true, error: 'assessor failed' }],
        orders,
      ],
      [
        'duplicate branch ownership',
        assessments,
        { orders: [orders.orders[0], { ...orders.orders[1], branch: 'fix/a' }] },
      ],
      [
        'duplicate owned path ownership',
        [diagnosis('a', 'same.test.ts'), diagnosis('b', 'same.test.ts'), rejected],
        orders,
      ],
    ];

    for (const [evidence, candidateAssessments, candidateOrders] of cases) {
      const result = prepare(candidateAssessments, candidateOrders);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr?.toString() ?? '').toContain(evidence);
    }
  });

  test('schema accepts honest rejection and forbids diagnosis fields on it', () => {
    const source = Bun.YAML.parse(
      readFileSync(join(packRoot, 'assess', 'archon-stabilize-assess.yaml'), 'utf8')
    ) as {
      nodes: Array<{ id: string; output_format: Record<string, unknown> }>;
    };
    const schema = source.nodes.find(node => node.id === 'assess')?.output_format;
    if (schema === undefined) throw new Error('assess output schema not found');

    expect(validateStructuredOutput(rejected, schema).valid).toBe(true);
    expect(
      validateStructuredOutput(
        { assessment: { ...rejected.assessment, kind: 'make-test-meaningful' } },
        schema
      ).valid
    ).toBe(false);
    expect(validateStructuredOutput(diagnosis('a', 'a.test.ts'), schema).valid).toBe(true);
  });

  test('either blank validation command is red without executing a shell command', () => {
    const artifacts = mkdtempSync(join(tmpdir(), 'archon-stabilizer-verify-'));
    try {
      for (const implement of [
        { test_cmd: '   ', validate_cmd: 'bun run validate' },
        { test_cmd: 'bun test a.test.ts', validate_cmd: '   ' },
      ]) {
        const result = runPython([verifyPath], {
          ARTIFACTS_DIR: artifacts,
          INPUTS_IMPLEMENT: JSON.stringify(implement),
        });
        expect(result.exitCode, result.stderr?.toString() ?? '').toBe(0);
        expect(JSON.parse(result.stdout?.toString() ?? '')).toMatchObject({
          green: false,
          targeted: { passed: false, artifact: null },
          project: { passed: false, artifact: null },
        });
      }
      expect(existsSync(join(artifacts, 'stabilizer-targeted.log'))).toBe(false);
      expect(existsSync(join(artifacts, 'stabilizer-project.log'))).toBe(false);
    } finally {
      rmSync(artifacts, { recursive: true, force: true });
    }
  });

  test('an approved review with findings cannot finish the loop', () => {
    const result = runPython([verdictPath], {
      INPUTS_ORDER: JSON.stringify({ title: 'Concern', diagnosis_ids: ['a'] }),
      INPUTS_IMPLEMENT: JSON.stringify({
        branch: 'fix/a',
        summary: 'Changed a.',
        validate_cmd: 'bun run validate',
        test_cmd: 'bun test a.test.ts',
        addressed_diagnosis_ids: ['a'],
      }),
      INPUTS_VERIFICATION: JSON.stringify({ green: true }),
      INPUTS_REVIEW: JSON.stringify({
        approved: true,
        findings: [{ diagnosis_id: 'a', evidence: 'still present', required_change: 'remove it' }],
      }),
    });

    expect(result.exitCode, result.stderr?.toString() ?? '').toBe(0);
    expect(JSON.parse(result.stdout?.toString() ?? '')).toMatchObject({ done: false });
  });

  test('collector accepts only the engine-owned fan-out array', () => {
    const artifacts = mkdtempSync(join(tmpdir(), 'archon-stabilizer-collect-'));
    try {
      const result = runPython([collectPath], {
        ARTIFACTS_DIR: artifacts,
        INPUTS_FIX_EACH: JSON.stringify({ concern: 'not an array' }),
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr?.toString() ?? '').toContain('engine-owned fan-out array');
    } finally {
      rmSync(artifacts, { recursive: true, force: true });
    }
  });
});

describe('test stabilizer CI watch', () => {
  test('waits for the current PR head and registered checks', () => {
    const source = `
import importlib.util
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("ship", ${JSON.stringify(shipPath)})
ship = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ship)

with patch.object(ship, "read_pr_head", side_effect=["old", "expected", "expected"]), \\
     patch.object(ship, "read_checks", side_effect=[[{"name":"test","bucket":"pending"}], [{"name":"test","bucket":"pass"}]]), \\
     patch.object(ship, "run", return_value=(0, "")) as run, \\
     patch.object(ship.time, "monotonic", side_effect=[100, 101, 102, 103, 104, 105]), \\
     patch.object(ship.time, "sleep") as sleep:
    result = ship.watch_ci("https://example.test/pr/1", "expected")
    assert result == {"ci_verdict":"green", "ci_detail":"test=pass"}
    assert run.call_count == 1
    sleep.assert_called_once_with(2)

with patch.object(ship, "read_pr_head", return_value="expected"), \\
     patch.object(ship, "read_checks", side_effect=[[{"name":"test","bucket":"pending"}], [{"name":"test","bucket":"fail"}]]), \\
     patch.object(ship, "run", return_value=(1, "watch stopped")), \\
     patch.object(ship.time, "monotonic", side_effect=[100, 101, 102, 103]):
    result = ship.watch_ci("https://example.test/pr/2", "expected")
    assert result == {"ci_verdict":"red", "ci_detail":"test=fail"}

with patch.object(ship, "read_pr_head", return_value="expected"), \\
     patch.object(ship, "read_checks", side_effect=RuntimeError("authentication failed")), \\
     patch.object(ship.time, "monotonic", side_effect=[100, 101]):
    try:
        ship.watch_ci("https://example.test/pr/3", "expected")
    except RuntimeError:
        pass
    else:
        raise AssertionError("operational gh failure was reported as a CI verdict")

with patch.object(ship, "read_pr_head", return_value="expected"), \\
     patch.object(ship, "read_checks", return_value=[]), \\
     patch.object(ship.time, "monotonic", side_effect=[100, 101, 2801]):
    result = ship.watch_ci("https://example.test/pr/4", "expected")
    assert result["ci_verdict"] == "timeout"
`;
    const result = runPython(['-c', source]);

    expect(result.exitCode, result.stderr?.toString() ?? '').toBe(0);
  });
});

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..');
const packRoot = join(repoRoot, '.archon', 'workflows', 'test-stabilizer');
const fixRoot = join(packRoot, 'fix');
const shipPath = join(fixRoot, 'scripts', 'ship.py');

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
    const batch = readFileSync(join(packRoot, 'batch', 'archon-stabilize-batch.yaml'), 'utf8');
    const fix = readFileSync(join(fixRoot, 'archon-stabilize-fix.yaml'), 'utf8');
    const verify = readFileSync(join(fixRoot, 'scripts', 'verify.py'), 'utf8');

    expect(batch).toContain('diagnoses: "$assess-each.output"');
    expect(batch).toContain('diagnosis_ids:');
    expect(batch).not.toContain('test_repetitions');
    expect(fix).toContain('context: fresh');
    expect(fix).toContain('mutates_checkout: false');
    expect(fix).toContain('max_iterations: 3');
    expect(fix).toContain('timeout: 2760000');
    expect(verify).toContain('stabilizer-targeted.log');
    expect(verify).toContain('stabilizer-project.log');
    expect(verify).not.toContain('MAX_OUTPUT_CHARS');
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
    const result = Bun.spawnSync(['uv', 'run', 'python', '-c', source], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
  });
});

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..');
const shipPath = join(
  repoRoot,
  '.archon',
  'workflows',
  'sdlc',
  'stabilize-fix',
  'scripts',
  'ship.py'
);

describe('stabilize-fix CI watch', () => {
  test('waits for checks to register before starting the bounded watch', () => {
    const source = `
import importlib.util
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("ship", ${JSON.stringify(shipPath)})
ship = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ship)

responses = [
    (1, "no checks reported"),
    (0, '[{"name":"test","bucket":"pending"}]'),
    (0, ""),
]
with patch.object(ship, "run", side_effect=responses) as run, \\
     patch.object(ship.time, "monotonic", side_effect=[100, 101, 102, 103, 104]), \\
     patch.object(ship.time, "sleep") as sleep:
    assert ship.watch_ci("https://example.test/pr/1") == "green"
    assert run.call_count == 3
    sleep.assert_called_once_with(2)

responses = [
    (0, '[{"name":"test","bucket":"pending"}]'),
    (1, "watch stopped"),
    (1, '[{"name":"test","bucket":"fail"}]'),
]
with patch.object(ship, "run", side_effect=responses), \\
     patch.object(ship.time, "monotonic", side_effect=[100, 101, 102, 103]):
    assert ship.watch_ci("https://example.test/pr/2") == "red"

responses = [
    (0, '[{"name":"test","bucket":"pending"}]'),
    (1, "authentication failed"),
    (1, "authentication failed"),
]
with patch.object(ship, "run", side_effect=responses), \\
     patch.object(ship.time, "monotonic", side_effect=[100, 101, 102, 103]):
    try:
        ship.watch_ci("https://example.test/pr/3")
    except RuntimeError:
        pass
    else:
        raise AssertionError("operational gh failure was reported as a CI verdict")

with patch.object(ship, "run", return_value=(1, "no checks reported")), \\
     patch.object(ship.time, "monotonic", side_effect=[100, 101, 2801]):
    assert ship.watch_ci("https://example.test/pr/4") == "timeout"
`;
    const result = Bun.spawnSync(['uv', 'run', 'python', '-c', source], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
  });
});

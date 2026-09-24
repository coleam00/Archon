import { describe, expect, test } from 'bun:test';
import { shouldReportCliStart } from './cli-start-telemetry';

describe('shouldReportCliStart', () => {
  test.each([[[]], [['--help']], [['version']], [['workflow', 'run', 'x']], [['--bogus']]])(
    'reports %p',
    args => {
      expect(shouldReportCliStart(args, {})).toBe(true);
    }
  );

  test('leaves serve to the server surface, wherever the command sits', () => {
    expect(shouldReportCliStart(['serve'], {})).toBe(false);
    expect(shouldReportCliStart(['--cwd', '/tmp/x', 'serve', '--port', '3090'], {})).toBe(false);
  });

  test('counts a serve that never boots the server', () => {
    expect(shouldReportCliStart(['serve', '--help'], {})).toBe(true);
    expect(shouldReportCliStart(['serve', '--download-only'], {})).toBe(true);
  });

  test('a flag value named serve is not the serve command', () => {
    expect(shouldReportCliStart(['--cwd', 'serve', 'version'], {})).toBe(true);
  });

  test('a detached run owner leaves the report to its parent', () => {
    expect(shouldReportCliStart(['workflow', 'run', 'x'], { ARCHON_DETACHED_RUN_OWNER: '1' })).toBe(
      false
    );
  });
});

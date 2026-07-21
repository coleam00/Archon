import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { readTierNoticeState, markTierNoticeShown } from './tier-notice';

// Drive the real `getArchonHome()` via ARCHON_HOME (same approach as
// update-check.test.ts) — no mock.module, so no cross-file pollution.
describe('tier-notice state cache', () => {
  const testDir = join(tmpdir(), `archon-tier-notice-test-${Date.now()}`);
  let originalArchonHome: string | undefined;

  beforeEach(() => {
    originalArchonHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = testDir;
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (originalArchonHome !== undefined) {
      process.env.ARCHON_HOME = originalArchonHome;
    } else {
      delete process.env.ARCHON_HOME;
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  test('returns null when no state file exists', () => {
    expect(readTierNoticeState()).toBeNull();
  });

  test('persists and reads back the shown version', () => {
    markTierNoticeShown('1.2.3');
    expect(readTierNoticeState()?.shownForVersion).toBe('1.2.3');
  });

  test('re-records when the version changes', () => {
    markTierNoticeShown('1.2.3');
    expect(readTierNoticeState()?.shownForVersion).toBe('1.2.3');
    markTierNoticeShown('1.2.4');
    expect(readTierNoticeState()?.shownForVersion).toBe('1.2.4');
  });

  test('returns null for a corrupt state file (missing shownForVersion)', () => {
    writeFileSync(join(testDir, 'tier-notice.json'), JSON.stringify({ foo: 'bar' }), 'utf-8');
    expect(readTierNoticeState()).toBeNull();
  });

  test('returns null for non-JSON content', () => {
    writeFileSync(join(testDir, 'tier-notice.json'), 'not json at all', 'utf-8');
    expect(readTierNoticeState()).toBeNull();
  });
});

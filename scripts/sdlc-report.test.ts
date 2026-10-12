import { describe, expect, it } from 'bun:test';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { discoveryReport } from '../.archon/workflows/sdlc/.shared/report';

/** The SDLC pack's terminal-report module, tested where the pack lives in this repository. */
const track = trackTempRoots();

function artifactsDir(): string {
  const dir = track(join(tmpdir(), `sdlc-report-${Math.random().toString(36).slice(2)}`));
  mkdirSync(join(dir, 'discoveries'), { recursive: true });
  return dir;
}

function write(path: string, value: unknown, at: number): void {
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  utimesSync(path, at, at);
}

describe('discoveries', () => {
  it('relays the consolidated discoveries and asks an agent to surface them', () => {
    const dir = artifactsDir();
    write(join(dir, 'discoveries.json'), [{ title: 'Flaky timeout', relation: 'unrelated' }], 100);
    const text = discoveryReport(dir);
    expect(text).toContain('Discoveries (1):\n- Flaky timeout');
    expect(text).toContain('If you are an agent reading this');
  });

  // Delivery's simplify pass runs after the review that consolidates, so its raw record
  // is newer than the consolidated file and would otherwise reach nobody.
  it('relays a raw record written after the last consolidation, and not one before it', () => {
    const dir = artifactsDir();
    write(join(dir, 'discoveries', 'review-code.json'), [{ title: 'Already consolidated' }], 100);
    write(join(dir, 'discoveries.json'), [{ title: 'Already consolidated' }], 200);
    write(join(dir, 'discoveries', 'review-simplify.json'), [{ title: 'Found late' }], 300);
    const text = discoveryReport(dir);
    expect(text).toContain('Discoveries (2):\n- Already consolidated\n- Found late');
  });

  it('says nothing when no run recorded a discovery', () => {
    expect(discoveryReport(artifactsDir())).toBe('');
  });

  it('reports a file that is not an array with its path', () => {
    const dir = artifactsDir();
    write(join(dir, 'discoveries.json'), '{}', 100);
    const text = discoveryReport(dir);
    expect(text).toContain('is not a JSON array of records');
    expect(text).toContain(join(dir, 'discoveries.json'));
  });
});

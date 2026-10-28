import { describe, it, expect, afterEach, beforeEach } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { removeTempTree } from '@archon/paths/test-utils';
import { copyArchonSkill } from './skill';
import { checkArchonSkill } from './doctor-skill';

describe('checkArchonSkill', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'archon-doctor-skill-'));
  });

  afterEach(async () => {
    await removeTempTree(tmp);
  });

  it('skips when no skill trees are present', async () => {
    const result = await checkArchonSkill(tmp);
    expect(result.status).toBe('skip');
    expect(result.label).toBe('Archon skill');
  });

  it('fails when a retired skill root is still on disk', async () => {
    mkdirSync(join(tmp, '.claude', 'skills', 'archon'), { recursive: true });
    const result = await checkArchonSkill(tmp);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('retired skill root');
    expect(result.message).toContain('archon skill add');
  });

  it('fails when skills exist but archon-cli is missing', async () => {
    mkdirSync(join(tmp, '.claude', 'skills'), { recursive: true });
    const result = await checkArchonSkill(tmp);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('archon-cli is missing');
  });

  it('fails when one existing skills tree is missing archon-cli', async () => {
    await copyArchonSkill(tmp);
    await removeTempTree(join(tmp, '.agents', 'skills', 'archon-cli'));

    const result = await checkArchonSkill(tmp);
    expect(result.status).toBe('fail');
    expect(result.message).toContain(join(tmp, '.agents', 'skills'));
  });

  it('checks only skill trees that exist', async () => {
    await copyArchonSkill(tmp);
    await removeTempTree(join(tmp, '.agents'));

    const result = await checkArchonSkill(tmp);
    expect(result.status).toBe('pass');
  });

  it('fails when an installed archon-cli differs from the bundled skill', async () => {
    await copyArchonSkill(tmp);
    writeFileSync(join(tmp, '.claude', 'skills', 'archon-cli', 'SKILL.md'), 'stale');

    const result = await checkArchonSkill(tmp);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('differs from the skill bundled');
  });

  it('fails when either installed archon-cli tree contains an extra file', async () => {
    await copyArchonSkill(tmp);

    for (const root of ['.claude', '.agents']) {
      const extra = join(tmp, root, 'skills', 'archon-cli', 'retired.md');
      writeFileSync(extra, 'retired guidance');

      const result = await checkArchonSkill(tmp);
      expect(result.status).toBe('fail');
      expect(result.message).toContain(join(tmp, root, 'skills', 'archon-cli'));

      await removeTempTree(extra);
    }
  });

  it('passes when both installed copies match the bundled skill', async () => {
    await copyArchonSkill(tmp);
    const result = await checkArchonSkill(tmp);
    expect(result.status).toBe('pass');
    expect(result.message).toContain('archon-cli');
  });
});

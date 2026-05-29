/**
 * Tests for codebase commands — id/name resolution and env-var value hiding.
 */
import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import * as codebaseDb from '@archon/core/db/codebases';
import * as envVarsDb from '@archon/core/db/env-vars';
import { resolveCodebase, codebaseEnvListCommand } from './codebase';

type Codebase = Awaited<ReturnType<typeof codebaseDb.getCodebase>>;

function makeCodebase(over: Partial<NonNullable<Codebase>> = {}): NonNullable<Codebase> {
  return {
    id: 'id',
    name: 'name',
    repository_url: null,
    default_cwd: '/repo',
    ai_assistant_type: 'claude',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

describe('resolveCodebase', () => {
  const spies: { mockRestore: () => void }[] = [];
  afterEach(() => {
    spies.forEach(s => s.mockRestore());
    spies.length = 0;
  });

  it('resolves by exact UUID', async () => {
    spies.push(
      spyOn(codebaseDb, 'getCodebase').mockResolvedValue(
        makeCodebase({ id: 'uuid-1', name: 'Repo' })
      )
    );
    const result = await resolveCodebase('uuid-1');
    expect(result.id).toBe('uuid-1');
  });

  it('resolves by case-insensitive name when not a UUID', async () => {
    spies.push(spyOn(codebaseDb, 'getCodebase').mockResolvedValue(null));
    spies.push(
      spyOn(codebaseDb, 'listCodebases').mockResolvedValue([
        makeCodebase({ id: 'a', name: 'MyRepo' }),
      ])
    );
    const result = await resolveCodebase('myrepo');
    expect(result.id).toBe('a');
  });

  it('throws on an ambiguous name', async () => {
    spies.push(spyOn(codebaseDb, 'getCodebase').mockResolvedValue(null));
    spies.push(
      spyOn(codebaseDb, 'listCodebases').mockResolvedValue([
        makeCodebase({ id: 'a', name: 'Dup' }),
        makeCodebase({ id: 'b', name: 'dup' }),
      ])
    );
    await expect(resolveCodebase('dup')).rejects.toThrow(/Ambiguous/);
  });

  it('throws when no codebase matches', async () => {
    spies.push(spyOn(codebaseDb, 'getCodebase').mockResolvedValue(null));
    spies.push(spyOn(codebaseDb, 'listCodebases').mockResolvedValue([]));
    await expect(resolveCodebase('nope')).rejects.toThrow(/not found/);
  });
});

describe('codebaseEnvListCommand', () => {
  const spies: { mockRestore: () => void }[] = [];
  afterEach(() => {
    spies.forEach(s => s.mockRestore());
    spies.length = 0;
  });

  it('prints only keys, never values (human output)', async () => {
    spies.push(
      spyOn(codebaseDb, 'getCodebase').mockResolvedValue(makeCodebase({ id: 'id1', name: 'Repo' }))
    );
    spies.push(
      spyOn(envVarsDb, 'getCodebaseEnvVars').mockResolvedValue({
        API_KEY: 'super-secret',
        TOKEN: 'abc123',
      })
    );
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    spies.push(logSpy);

    await codebaseEnvListCommand('id1');

    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('API_KEY');
    expect(output).toContain('TOKEN');
    expect(output).not.toContain('super-secret');
    expect(output).not.toContain('abc123');
  });

  it('emits keys only in --json output', async () => {
    spies.push(spyOn(codebaseDb, 'getCodebase').mockResolvedValue(makeCodebase({ id: 'id1' })));
    spies.push(
      spyOn(envVarsDb, 'getCodebaseEnvVars').mockResolvedValue({
        SECRET: 'value-should-not-appear',
      })
    );
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    spies.push(logSpy);

    await codebaseEnvListCommand('id1', true);

    const output = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    const parsed = JSON.parse(output) as { keys: string[] };
    expect(parsed.keys).toEqual(['SECRET']);
    expect(output).not.toContain('value-should-not-appear');
  });
});

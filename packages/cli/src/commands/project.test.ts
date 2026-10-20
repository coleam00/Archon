import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { projectKeyForCodebase } from '@archon/paths';
import type { Codebase } from '@archon/core/schemas/codebase';
import { projectCommand, projectListCommand } from './project';

function codebase(overrides: Partial<Codebase> & Pick<Codebase, 'id' | 'name' | 'kind'>): Codebase {
  return {
    repository_url: null,
    default_cwd: `/repos/${overrides.id}`,
    default_branch: null,
    ai_assistant_type: null,
    commands: {},
    created_at: new Date('2026-10-01T00:00:00.000Z'),
    updated_at: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

const ROWS = [
  codebase({ id: 'cb-repo', name: 'acme/widget', kind: 'repo' }),
  codebase({ id: 'cb-folder', name: 'notes', kind: 'folder' }),
];

describe('projectListCommand', () => {
  let logs: string[];
  let stdout: string[];
  let logSpy: ReturnType<typeof spyOn>;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logs = [];
    stdout = [];
    logSpy = spyOn(console, 'log').mockImplementation((line: string) => logs.push(line));
    stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string,
      callback?: () => void
    ) => {
      stdout.push(chunk);
      callback?.();
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    logSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('emits each row with its project key', async () => {
    expect(await projectListCommand({ listCodebases: async () => ROWS }, { json: true })).toBe(0);

    const { projects } = JSON.parse(stdout.join('')) as { projects: Record<string, unknown>[] };
    expect(projects).toEqual(
      ROWS.map(row => ({
        ...JSON.parse(JSON.stringify(row)),
        key: projectKeyForCodebase(row, row.default_cwd),
      }))
    );
  });

  it('prints one line per project, or says none are registered', async () => {
    await projectListCommand({ listCodebases: async () => ROWS }, {});
    expect(logs).toHaveLength(3);
    expect(logs[1]).toContain('cb-repo\trepo\tacme/widget');
    expect(logs[2]).toContain('cb-folder\tfolder\tnotes');

    logs = [];
    await projectListCommand({ listCodebases: async () => [] }, {});
    expect(logs).toEqual(['No projects registered.']);
  });

  it('refuses any subcommand but list before opening the store', async () => {
    expect(await projectCommand(['show'], true)).toBe(1);
    expect(JSON.parse(stdout.join(''))).toEqual({
      ok: false,
      error: 'Usage: archon project list [--json]',
    });
  });
});

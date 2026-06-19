import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { readProjectReadmeSnippet, readProjectReadmes } from './project-readme';
import type { Codebase } from '../schemas/codebase';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'archon-readme-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeCodebase(id: string, cwd: string): Codebase {
  return {
    id,
    name: id,
    repository_url: null,
    default_cwd: cwd,
    default_branch: null,
    ai_assistant_type: 'claude',
    commands: {},
    created_at: new Date(),
    updated_at: new Date(),
  };
}

describe('readProjectReadmeSnippet', () => {
  test('reads README.md and strips badges/comments', async () => {
    const dir = join(root, 'proj');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'README.md'),
      '<!-- a comment -->\n[![Build](https://img.shields.io/x.svg)](https://ci)\n# Coral\n\nThe payments service.\n'
    );
    const snippet = await readProjectReadmeSnippet(dir);
    expect(snippet).toContain('# Coral');
    expect(snippet).toContain('The payments service.');
    expect(snippet).not.toContain('shields.io');
    expect(snippet).not.toContain('a comment');
  });

  test('returns undefined when no README exists', async () => {
    const dir = join(root, 'empty');
    await mkdir(dir, { recursive: true });
    expect(await readProjectReadmeSnippet(dir)).toBeUndefined();
  });

  test('falls back to alternate README filenames', async () => {
    const dir = join(root, 'txt');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'README.txt'), 'Plain text project description.');
    const snippet = await readProjectReadmeSnippet(dir);
    expect(snippet).toContain('Plain text project description.');
  });

  test('truncates long content', async () => {
    const dir = join(root, 'long');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'README.md'), 'x'.repeat(5000));
    const snippet = await readProjectReadmeSnippet(dir);
    expect(snippet?.length).toBeLessThan(1000);
    expect(snippet?.endsWith('…')).toBe(true);
  });
});

describe('readProjectReadmes', () => {
  test('maps codebase id → snippet, skipping projects without a README', async () => {
    const withReadme = join(root, 'a');
    const withoutReadme = join(root, 'b');
    await mkdir(withReadme, { recursive: true });
    await mkdir(withoutReadme, { recursive: true });
    await writeFile(join(withReadme, 'README.md'), 'Project A does X.');

    const map = await readProjectReadmes([
      makeCodebase('a', withReadme),
      makeCodebase('b', withoutReadme),
    ]);

    expect(map.get('a')).toContain('Project A does X.');
    expect(map.has('b')).toBe(false);
  });

  test('returns an empty map for no codebases', async () => {
    const map = await readProjectReadmes([]);
    expect(map.size).toBe(0);
  });
});

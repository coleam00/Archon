/**
 * agent_ref schema + executor-overlay tests.
 *
 * Tests the loader-side validation of `agent_ref` (kebab-case enforced) and
 * the load-agent module that the executor uses at runtime to resolve a ref.
 *
 * The full overlay-into-nodeConfig flow is covered indirectly via the
 * dag-executor tests; this file pins the boundary contract.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { dagNodeSchema } from './schemas/dag-node';
import { loadAgentFile } from '@archon/providers';

describe('agent_ref schema field', () => {
  test('accepts kebab-case names', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n1',
      prompt: 'do the thing',
      agent_ref: 'code-reviewer',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agent_ref).toBe('code-reviewer');
    }
  });

  test('rejects invalid agent_ref names', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n1',
      prompt: 'do the thing',
      agent_ref: 'Bad Name',
    });
    expect(result.success).toBe(false);
  });

  test('agent_ref is optional', () => {
    const result = dagNodeSchema.safeParse({
      id: 'n1',
      prompt: 'do the thing',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agent_ref).toBeUndefined();
    }
  });
});

describe('loadAgentFile via agent_ref', () => {
  let tempHome: string;
  let tempProject: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'agent-ref-home-'));
    tempProject = await mkdtemp(join(tmpdir(), 'agent-ref-proj-'));
    process.env.HOME = tempHome;
    await mkdir(join(tempHome, '.claude', 'agents'), { recursive: true });
    await mkdir(join(tempProject, '.claude', 'agents'), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
    await rm(tempProject, { recursive: true, force: true });
  });

  test('overlay returns model + tools + body when agent file exists', async () => {
    await writeFile(
      join(tempProject, '.claude', 'agents', 'reviewer.md'),
      '---\nname: reviewer\ndescription: code reviewer\nmodel: sonnet\ntools: [Read, Grep]\n---\n\nYou are a meticulous reviewer.\n',
      'utf8'
    );
    const a = await loadAgentFile('reviewer', tempProject);
    expect(a).not.toBeNull();
    expect(a?.model).toBe('sonnet');
    expect(a?.tools).toEqual(['Read', 'Grep']);
    expect(a?.systemPrompt).toBe('You are a meticulous reviewer.');
  });

  test('returns null when agent file is missing — caller raises', async () => {
    expect(await loadAgentFile('does-not-exist', tempProject)).toBeNull();
  });
});

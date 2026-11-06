/**
 * Deliver's `threads` node against a fake forge: it replies to and resolves
 * the threads settle-threads answered, reads back what is still open, and lists the
 * open threads for the next round's implementer.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PR,
  PR_URL,
  forgeOperation,
  forgePrRecord,
  packScriptRunner,
  type ScriptRun,
} from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();

function ok(result: ScriptRun): { open: number; summary: string } {
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  return JSON.parse(result.stdout) as { open: number; summary: string };
}

const listing = (result: ScriptRun): string => readFileSync(join(result.artifacts, 'threads.md'), 'utf8');

describe("deliver's review threads", () => {
  const ref = PR;
  const view = (draft: boolean) =>
    forgeOperation('pr.view', { pr: forgePrRecord({ is_draft: draft }), title: 't', body: 'b' });
  const threads = (resolved: boolean) =>
    forgeOperation('pr.threads', {
      ref,
      threads: [
        {
          id: 'T1',
          resolved,
          outdated: false,
          path: 'src/a.ts',
          line: 3,
          comments: [{ id: 'c1', author: { host: ref.repo.host, id: '7', login: 'reviewer' }, body: 'This leaks the token.', url: `${PR_URL}#c1` }],
        },
      ],
    });
  const applied = (op: string) => forgeOperation(op, { outcome: 'applied' });

  it('answers a thread with a reply then a resolve on that thread, then rereads the threads', () => {
    const reply = 'Fixed in 1a2b3c4.';
    const result = runPackScript('deliver/scripts/threads', {
      forge: {
        kind: 'fake',
        response: [
          view(true),
          threads(false),
          applied('pr.thread.reply'),
          applied('pr.thread.resolve'),
          view(true),
          threads(true),
        ],
      },
      inputs: { INPUTS_ANSWERS: JSON.stringify([{ thread: 'T1', reply }]) },
    });
    expect(ok(result).open).toBe(0);
    expect(result.forge.map(argv => argv.split(' ')[1])).toEqual([
      'pr.view',
      'pr.threads',
      'pr.thread.reply',
      'pr.thread.resolve',
      'pr.view',
      'pr.threads',
    ]);
    expect(JSON.parse(result.forgeRequests[2] ?? '{}')).toMatchObject({ thread: 'T1', body: reply });
    expect(JSON.parse(result.forgeRequests[3] ?? '{}')).toMatchObject({ thread: 'T1' });
  });

  it('lists an open thread and puts a ready pull request back to draft through the forge', () => {
    const result = runPackScript('deliver/scripts/threads', {
      forge: {
        kind: 'fake',
        response: [view(false), threads(false), forgeOperation('pr.draft', { pr: forgePrRecord({ is_draft: true }) })],
      },
      inputs: { INPUTS_ANSWERS: 'null' },
    });
    expect(ok(result).open).toBe(1);
    expect(listing(result)).toContain('- id: `T1`');
    expect(result.forge.map(argv => argv.split(' ')[1])).toEqual(['pr.view', 'pr.threads', 'pr.draft']);
  });

  const ops = (result: ScriptRun): string[] => result.forge.map(argv => argv.split(' ')[1] ?? '');
  const drafted = forgeOperation('pr.draft', { pr: forgePrRecord({ is_draft: true }) });

  it('refuses an answer for a thread the pull request does not have, before writing anything', () => {
    const result = runPackScript('deliver/scripts/threads', {
      forge: { kind: 'fake', response: [view(false), threads(false), drafted] },
      inputs: { INPUTS_ANSWERS: JSON.stringify([{ thread: 'T9', reply: 'Fixed.' }]) },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('answers name threads');
    expect(result.stderr).toContain('T9');
    expect(ops(result)).toEqual(['pr.view', 'pr.threads', 'pr.draft']);
  });

  it('fails and puts the pull request back to draft when an answered thread does not read back resolved', () => {
    const result = runPackScript('deliver/scripts/threads', {
      forge: {
        kind: 'fake',
        response: [view(false), threads(false), applied('pr.thread.reply'), applied('pr.thread.resolve'), view(false), threads(false), drafted],
      },
      inputs: { INPUTS_ANSWERS: JSON.stringify([{ thread: 'T1', reply: 'Fixed in 1a2b3c4.' }]) },
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('threads T1 were answered but do not read back resolved');
    expect(ops(result).at(-1)).toBe('pr.draft');
  });
});

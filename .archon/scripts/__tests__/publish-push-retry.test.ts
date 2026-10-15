import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { PACK, PR, PR_URL, gitCheckout, packScriptRunner } from './deliver-checks-harness';

const { runPackScript } = packScriptRunner();
const track = trackTempRoots();
const pushArgs = ['push', 'upstream', 'HEAD:refs/heads/feature'];
const readArgs = ['ls-remote', 'upstream', 'refs/heads/feature'];

function publish(failures: number, wrongReadBack = false, deadline?: number) {
  const cwd = gitCheckout({}, track);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
  const run = runPackScript('pr/scripts/publish-pr', {
    cwd,
    timeout: deadline,
    gh: { noOpenPr: true, pr: { headRefOid: head } },
    inputs: {
      INPUTS_REPO: JSON.stringify(PR.repo),
      INPUTS_HEAD_REPO: JSON.stringify(PR.repo),
      INPUTS_HEAD: 'feature',
      INPUTS_BASE: 'dev',
      INPUTS_EXISTING: '',
      INPUTS_PULL_REQUEST: '',
      INPUTS_TITLE: 'A title',
      INPUTS_BODY: '{ARTIFACTS}/pr-body.md',
      INPUTS_DRAFT: 'true',
    },
    artifacts: { 'pr-body.md': 'A body' },
    // Keep real git for successful pushes and remote verification. Only the
    // failures are controlled; the deadline case keeps the real clock.
    preload: `
import { appendFileSync as recordFile } from 'node:fs';
const spawn = Bun.spawnSync.bind(Bun);
const sleep = Bun.sleepSync.bind(Bun);
let pushes = 0;
const record = event => recordFile(process.env.ARTIFACTS_DIR + '/push-events.jsonl', JSON.stringify(event) + '\\n');
Bun.sleepSync = milliseconds => {
  record(['sleep', milliseconds]);
  if (${String(deadline !== undefined)}) sleep(milliseconds);
};
Object.defineProperty(Bun, 'spawnSync', { value: (argv, settings) => {
  if (argv[0] === 'git' && argv[1] === 'push') {
    record(argv.slice(1));
    if (++pushes <= ${String(failures)}) {
      if (${String(deadline !== undefined)} && pushes === 1) sleep(11_000);
      return {
        exitCode: 7, stdout: Buffer.from(''), stderr: Buffer.from(pushes === 1 ? '' : 'opaque failure ' + pushes),
      };
    }
  }
  if (argv[0] === 'git' && argv[1] === 'ls-remote') {
    record(argv.slice(1));
    if (${String(wrongReadBack)}) return {
      exitCode: 0, stdout: Buffer.from('different refs/heads/feature'), stderr: Buffer.from(''),
    };
  }
  return spawn(argv, settings);
} });
`,
  });
  const events: unknown[] = readFileSync(join(run.artifacts, 'push-events.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  return { ...run, events, cwd, head };
}

describe('publish-pr push retry', () => {
  it.each([1, 2])('finishes %i slow failed pushes within the publication deadline', failures => {
    const workflow: unknown = Bun.YAML.parse(readFileSync(join(PACK, 'pr/archon-pr.yaml'), 'utf8'));
    if (!workflow || typeof workflow !== 'object' || !('nodes' in workflow) || !Array.isArray(workflow.nodes)) {
      throw new Error('workflow nodes are missing');
    }
    const publishNode: unknown = workflow.nodes.find((node: unknown) => node !== null && typeof node === 'object' && 'id' in node && node.id === 'publish');
    if (!publishNode || typeof publishNode !== 'object' || !('timeout' in publishNode)) {
      throw new Error('publish node is missing');
    }
    const timeout = publishNode.timeout;
    if (typeof timeout !== 'number') throw new Error('publish timeout is missing');
    const result = publish(failures, false, timeout);
    expect(result.events).toEqual(failures === 1
      ? [pushArgs, ['sleep', 20_000], pushArgs, readArgs]
      : [pushArgs, ['sleep', 20_000], pushArgs]);
    expect(result.code).toBe(failures === 1 ? 0 : 1);
    expect('retry' in publishNode).toBe(false);
    if (failures === 1) {
      expect(JSON.parse(result.stdout)).toMatchObject({ number: 42, url: PR_URL });
    } else {
      expect(result.stderr).toBe('publish-pr: git push upstream HEAD:refs/heads/feature refused: opaque failure 2\n');
      expect(result.gh).toEqual([]);
    }
  }, 90_000);

  it.each([0, 1])('publishes after %i failed pushes and verifies the remote head', failures => {
    const result = publish(failures);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ number: 42, url: PR_URL });
    expect(result.gh.some(call => call.startsWith('pr create'))).toBe(true);
    expect(result.events).toEqual(failures === 0
      ? [pushArgs, readArgs]
      : [pushArgs, ['sleep', 20_000], pushArgs, readArgs]);
    const remote = spawnSync('git', readArgs, { cwd: result.cwd, encoding: 'utf8' });
    expect(remote.status).toBe(0);
    expect(remote.stdout.trim().split(/\s+/)[0]).toBe(result.head);
  });

  it('stops after two failures with the existing refusal format and final stderr', () => {
    const result = publish(2);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('publish-pr: git push upstream HEAD:refs/heads/feature refused: opaque failure 2\n');
    expect(result.events).toEqual([pushArgs, ['sleep', 20_000], pushArgs]);
    expect(result.gh).toEqual([]);
  });

  it('refuses publication when the successful retry does not read back as HEAD', () => {
    const result = publish(1, true);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`publish-pr: pushed ${result.head} to upstream refs/heads/feature, but the remote reads different\n`);
    expect(result.events).toEqual([pushArgs, ['sleep', 20_000], pushArgs, readArgs]);
    expect(result.gh).toEqual([]);
  });
});

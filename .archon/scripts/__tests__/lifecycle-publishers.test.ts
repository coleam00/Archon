import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { removeTempTree } from '@archon/paths/test-utils';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..', '..');
const SDLC = join(ROOT, '.archon', 'workflows', 'sdlc');
const scripts = {
  pr: join(SDLC, 'pr', 'scripts', 'publish-pr.ts'),
  body: join(SDLC, 'deliver', 'scripts', 'publish-pr-body.ts'),
  comment: join(SDLC, 'review', 'scripts', 'publish-review.ts'),
  ready: join(SDLC, 'deliver', 'scripts', 'flip-ready.ts'),
};

let dir: string;
let cli: string;
let log: string;
let responses: string;

const ref = { repo: { host: 'forge.example', path: 'owner/repo' }, number: 42 };
function pr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1, ...ref, url: 'https://forge.example/owner/repo/pulls/42',
    head: 'feature', base: 'dev', is_draft: true, state: 'open',
    head_repo: ref.repo, head_revision: 'head-oid', base_revision: 'base-oid',
    maintainer_can_modify: true, ...overrides,
  };
}

function run(
  script: string,
  inputs: Record<string, string>,
  mode: string
): Bun.SyncSubprocess<'pipe', 'pipe'> {
  return Bun.spawnSync(['bun', script], {
    cwd: ROOT,
    env: {
      ...process.env,
      ARCHON_CLI_COMMAND: JSON.stringify(['bun', cli]),
      FAKE_FORGE_MODE: mode,
      FAKE_FORGE_LOG: log,
      FAKE_FORGE_RESPONSES: responses,
      ...Object.fromEntries(Object.entries(inputs).map(([key, value]) => [`INPUTS_${key}`, value])),
    },
    stdout: 'pipe', stderr: 'pipe',
  });
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('fixture JSON must be an object');
  }
  return value as Record<string, unknown>;
}

function parseObject(line: string): Record<string, unknown> {
  return object(JSON.parse(line) as unknown);
}

function calls(): { op: string; data: Record<string, unknown> }[] {
  if (!Bun.file(log).size) return [];
  return readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const call = parseObject(line);
      if (typeof call.op !== 'string') throw new Error('fixture call has no operation');
      return { op: call.op, data: object(call.data) };
    });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'archon-lifecycle-pack-'));
  cli = join(dir, 'fake-forge.ts');
  log = join(dir, 'calls.jsonl');
  responses = join(dir, 'responses.jsonl');
  writeFileSync(log, '');
  writeFileSync(responses, '');
  writeFileSync(cli, `
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const op = args[1] === 'checks' ? 'checks.state' : args[1];
const fileIndex = args.indexOf('--data-file');
const dataIndex = args.indexOf('--data');
const data = fileIndex >= 0 ? JSON.parse(readFileSync(args[fileIndex + 1], 'utf8')) : JSON.parse(args[dataIndex + 1]);
appendFileSync(process.env.FAKE_FORGE_LOG, JSON.stringify({op,data}) + '\\n');
const base = ${JSON.stringify(pr())};
const mode = process.env.FAKE_FORGE_MODE;
let response;
if (mode === 'missing-existing' && op === 'pr.view') response = {operationId:'fake',ok:true,result:{op,value:null}};
else if (mode === 'remote-merged' && op === 'pr.view') response = {operationId:'fake',ok:true,result:{op,value:{pr:{...base,state:'merged',is_draft:false},title:'Merged',body:'Body'}}};
else if (mode === 'remote-closed' && op === 'pr.view') response = {operationId:'fake',ok:true,result:{op,value:{pr:{...base,state:'closed',is_draft:false},title:'Closed',body:'Body'}}};
else if (mode === 'unknown' && op === 'pr.ready') response = {operationId:'fake',ok:false,error:{kind:'timeout',message:'lost response'},mutation:{op,outcome:'outcome_unknown',target:data.ref,requested:{},enforced:{}}};
else if (mode === 'race-merged' && op === 'pr.ready') response = {operationId:'fake',ok:false,error:{kind:'conflict',message:'already merged'},mutation:{op,outcome:'refused',target:data.ref,requested:{},enforced:{},observed:{...base,state:'merged',is_draft:false}}};
else if (op === 'pr.view') response = {operationId:'fake',ok:true,result:{op,value:{pr:{...base,is_draft:false},title:'Existing',body:'Body'}}};
else if (op === 'pr.create') response = {operationId:'fake',ok:true,result:{op,value:{outcome:'applied',changed:true,target:data.repo,requested:{},enforced:{},pr:{...base,head_repo:data.headRepo,head:data.head,base:data.base,is_draft:data.draft,head_revision:data.headRevision}}}};
else if (op === 'pr.edit-body') response = {operationId:'fake',ok:true,result:{op,value:{outcome:'applied',changed:true,target:data.ref,requested:{},enforced:{},pr:base,bodyDigest:'digest'}}};
else if (op === 'comment.upsert') response = {operationId:'fake',ok:true,result:{op,value:{outcome:'applied',changed:mode !== 'comment-second',target:data.ref,requested:{},enforced:{},comment:{ref:data.ref,id:'stable-comment',url:'https://forge.example/comment/1',bodyDigest:'digest'}}}};
else if (op === 'checks.state') response = {operationId:'fake',ok:true,result:{op,value:{ref:data.ref,revision:'head-oid',units:[],required:null,summary:{state:'green',counts:{total:0,green:0,red:0,pending:0,gated:0,unknown:0}}}}};
else if (op === 'pr.ready') response = {operationId:'fake',ok:true,result:{op,value:{outcome:'applied',changed:true,target:data.ref,requested:{},enforced:{},pr:{...base,is_draft:false}}}};
appendFileSync(process.env.FAKE_FORGE_RESPONSES, JSON.stringify(response) + '\\n');
console.log(JSON.stringify(response));
process.exit(mode === 'audit-fail-create' && op === 'pr.create' ? 2 : response.ok ? 0 : 1);
`);
});

afterEach(async () => {
  await removeTempTree(dir);
});

describe('deterministic lifecycle publishers', () => {
  test.each([
    ['same-repository', ref.repo],
    ['authorized fork', { host: 'forge.example', path: 'author/repo' }],
  ])('creates a draft from prepared %s identity', (_, headRepo) => {
    const body = join(dir, 'body.md'); writeFileSync(body, 'Prepared body');
    const intent = join(dir, 'intent.json');
    writeFileSync(intent, JSON.stringify({ repo: ref.repo, headRepo, head: 'feature', headRevision: 'head-oid', base: 'dev', title: 'Title', bodyPath: body, draft: true }));
    const result = run(scripts.pr, { INTENT: intent }, 'create');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ head_repo: headRepo, is_draft: true });
    expect(calls()).toEqual([{ op: 'pr.create', data: { repo: ref.repo, headRepo, head: 'feature', headRevision: 'head-oid', base: 'dev', title: 'Title', body: 'Prepared body', draft: true } }]);
  });

  test('reuses the selected PR and preserves its ready state', () => {
    const intent = join(dir, 'intent.json');
    writeFileSync(intent, JSON.stringify({ existing: { kind: 'number', ref } }));
    const result = run(scripts.pr, { INTENT: intent }, 'existing');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString()).is_draft).toBe(false);
    expect(calls()).toEqual([{ op: 'pr.view', data: { selector: { kind: 'number', ref } } }]);
  });

  test('a selected PR that disappeared refuses instead of falling back to create', () => {
    const intent = join(dir, 'intent.json');
    writeFileSync(intent, JSON.stringify({ existing: { kind: 'number', ref } }));
    const result = run(scripts.pr, { INTENT: intent }, 'missing-existing');
    expect(result.exitCode).toBe(1);
    expect(calls().map(call => call.op)).toEqual(['pr.view']);
  });

  test('an applied create with failed audit is retained and never retried', () => {
    const body = join(dir, 'body.md');
    writeFileSync(body, 'Prepared body');
    const intent = join(dir, 'intent.json');
    writeFileSync(intent, JSON.stringify({ repo: ref.repo, headRepo: ref.repo, head: 'feature', headRevision: 'head-oid', base: 'dev', title: 'Title', bodyPath: body, draft: true }));
    const result = run(scripts.pr, { INTENT: intent }, 'audit-fail-create');
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('applied/read succeeded; audit persistence failed');
    expect(result.stderr.toString()).toContain('"outcome":"applied"');
    expect(result.stderr.toString()).toContain('"repo":{"host":"forge.example","path":"owner/repo"}');
    expect(result.stderr.toString()).toContain('"number":42');
    expect(calls().map(call => call.op)).toEqual(['pr.create']);
  });

  test('body no-change returns the existing record without a forge call', () => {
    const intent = join(dir, 'intent.json'); writeFileSync(intent, '{"change":false}');
    const result = run(scripts.body, { INTENT: intent, PR: JSON.stringify(pr()) }, 'body');
    expect(result.exitCode).toBe(0); expect(JSON.parse(result.stdout.toString())).toEqual(pr());
    expect(calls()).toEqual([]);
  });

  test('canonical comment uses the same qualified target and stable id across rounds', () => {
    const report = join(dir, 'report.md'); writeFileSync(report, 'Report');
    const inputs = { PR: JSON.stringify(pr()), REPORT: report, READY: 'true', ACTION: 'none', SUMMARY: 'ready', REPORT_POINTER: JSON.stringify({type:'archon_artifact',run_id:'run',path:'review/report.md'}) };
    expect(run(scripts.comment, inputs, 'comment-first').exitCode).toBe(0);
    expect(run(scripts.comment, inputs, 'comment-second').exitCode).toBe(0);
    expect(calls().map(call => call.data.ref)).toEqual([ref, ref]);
    expect(calls().map(call => call.op)).toEqual(['comment.upsert', 'comment.upsert']);
    const ids = readFileSync(responses, 'utf8')
      .trim()
      .split('\n')
      .map(line => {
        const result = object(parseObject(line).result);
        const value = object(result.value);
        return object(value.comment).id;
      });
    expect(ids).toEqual(['stable-comment', 'stable-comment']);
  });

  test('working-diff review preserves verdict without a remote call', () => {
    const result = run(scripts.comment, { PR: '{}', REPORT: join(dir,'missing'), READY: 'false', ACTION: 'correct', SUMMARY: 'blocked', REPORT_POINTER: JSON.stringify({type:'archon_artifact',run_id:'run',path:'review/report.md'}) }, 'skip');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ ready: false, action: 'correct' });
    expect(calls()).toEqual([]);
  });

  test('ready refreshes stale input and accepts an already-merged remote PR', () => {
    const result = run(scripts.ready, { PR: JSON.stringify(pr()) }, 'remote-merged');
    expect(result.exitCode).toBe(0);
    expect(calls().map(call => call.op)).toEqual(['pr.view']);
  });

  test('ready refuses a currently closed PR without mutation', () => {
    const result = run(scripts.ready, { PR: JSON.stringify(pr()) }, 'remote-closed');
    expect(result.exitCode).toBe(1);
    expect(calls().map(call => call.op)).toEqual(['pr.view']);
  });

  test('ready accepts a structured merged observation when merge races the mutation', () => {
    const result = run(scripts.ready, { PR: JSON.stringify(pr()) }, 'race-merged');
    expect(result.exitCode).toBe(0);
    expect(calls().map(call => call.op)).toEqual(['pr.view', 'checks.state', 'pr.ready']);
  });

  test('unknown ready outcome aborts after one mutation attempt', () => {
    const result = run(scripts.ready, { PR: JSON.stringify(pr()) }, 'unknown');
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('outcome_unknown');
    expect(calls().map(call => call.op)).toEqual(['pr.view', 'checks.state', 'pr.ready']);
  });
});

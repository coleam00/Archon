import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTempRoots } from '@archon/paths/test-utils';

const FLIP = resolve(import.meta.dir, '../../workflows/sdlc/deliver/scripts/flip-ready.ts');
const REF = { repo: { host: 'ghe.example.com', path: 'example/repo' }, number: 42 };
const PR = {
  schemaVersion: 1, ...REF, url: 'https://ghe.example.com/example/repo/pull/42',
  head: 'feature', base: 'dev', is_draft: true, state: 'open', head_repo: REF.repo,
  head_revision: 'abc123', base_revision: 'base123', maintainer_can_modify: true,
};
const trackTempRoot = trackTempRoots();
type State = 'none' | 'pending' | 'green' | 'red' | 'gated' | 'unknown';

function run(state: State, forgeFail = false): { code: number; stdout: string; stderr: string; ops: string[] } {
  const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'flip-ready-checks-')));
  const cli = join(root, 'forge.ts');
  const log = join(root, 'ops');
  writeFileSync(log, '');
  writeFileSync(cli, `
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const op = args[1] === 'checks' ? 'checks.state' : args[1];
const file = args.indexOf('--data-file');
const data = file >= 0 ? JSON.parse(readFileSync(args[file + 1], 'utf8')) : JSON.parse(args[args.indexOf('--data') + 1]);
appendFileSync(${JSON.stringify(log)}, op + '\\n');
const pr = ${JSON.stringify(PR)};
if (${JSON.stringify(forgeFail)} && op === 'checks.state') { console.error('plugin unavailable'); process.exit(1); }
let response;
if (op === 'pr.view') response = {operationId:'view',ok:true,result:{op,value:{pr,title:'Title',body:'Body'}}};
else if (op === 'checks.state') {
  const state = ${JSON.stringify(state)};
  const units = state === 'none' ? [] : [{unit:{name:'build'},phase:state === 'pending'?'running':'completed',result:state === 'green'?'success':state === 'pending'?null:'failure',state}];
  response = {operationId:'checks',ok:true,result:{op,value:{ref:data.ref,revision:'abc123',units,required:null,summary:{state,counts:{total:units.length,green:state==='green'?1:0,red:state==='red'?1:0,pending:state==='pending'?1:0,gated:state==='gated'?1:0,unknown:state==='unknown'?1:0}}}}};
} else response = {operationId:'ready',ok:true,result:{op,value:{outcome:'applied',changed:true,target:data.ref,requested:{},enforced:{},pr:{...pr,is_draft:false}}}};
console.log(JSON.stringify(response));
`);
  const result = spawnSync(process.execPath, [FLIP], {
    encoding: 'utf8',
    env: { ...process.env, ARCHON_CLI_COMMAND: JSON.stringify([process.execPath, cli]), INPUTS_PR: JSON.stringify(PR) },
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ops: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}

describe('flip-ready forge check policy', () => {
  for (const state of ['green', 'none'] as const) {
    it(`uses the qualified lifecycle target and allows ${state} checks`, () => {
      const result = run(state);
      expect(result.code, result.stderr).toBe(0);
      expect(result.ops).toEqual(['pr.view', 'checks.state', 'pr.ready']);
      expect(JSON.parse(result.stdout)).toEqual({ pr_url: PR.url });
    });
  }

  for (const state of ['pending', 'red', 'gated', 'unknown'] as const) {
    it(`refuses ${state} checks before the ready mutation`, () => {
      const result = run(state);
      expect(result.code).toBe(1);
      expect(result.ops).toEqual(['pr.view', 'checks.state']);
      expect(result.stderr).toContain(state);
    });
  }

  it('refuses a failed lifecycle check read before the ready mutation', () => {
    const result = run('green', true);
    expect(result.code).toBe(1);
    expect(result.ops).toEqual(['pr.view', 'checks.state']);
    expect(result.stderr).toContain('forge check read failed');
  });
});

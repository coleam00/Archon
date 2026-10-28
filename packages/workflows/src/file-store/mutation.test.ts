// @archon-test-isolated
import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTempRoots } from '@archon/paths/test-utils';
const roots = trackTempRoots();
// Disabling the lock makes concurrent commits collide on intent.json, so the probe would fail
// on ENOENT before it ever saw two winners. The commits stay serialized here; instead the
// compare step is skipped, and the probe must fail because more than one racer won.
test.each([
  { probe: 'Claim', method: 'claimPendingWorkflowRun', reopen: 'run.status = "pending";' },
  {
    probe: 'Gate',
    method: 'resolveApprovalGate',
    reopen: 'if (run.metadata.approval) run.metadata.approval.resolved = null;',
  },
])(
  'the real file store fails the $probe conformance probe when its CAS skips the compare',
  async ({ probe, method, reopen }) => {
    const root = roots(await mkdtemp(join(tmpdir(), 'file-broken-cas-')));
    const view = JSON.stringify(join(import.meta.dir, 'transaction-view.ts'));
    const script = `import {mock} from 'bun:test';
const real=await import(${view});
// mock.module rewrites the live namespace, so keep the real factory first.
const create=real.createTransactionView;
let wins=0;
mock.module(${view},()=>({...real,createTransactionView:(runs,events,getCodebase)=>{
  const inner=create(runs,events,getCodebase);
  return {...inner,${method}:async (id,...args)=>{
    const run=runs.get(id);
    if (run) {${reopen}}
    const result=await inner.${method}(id,...args);
    if (result !== null && result.resolved !== false) wins++;
    return result;
  }};
}}));
const {createFileWorkflowStore}=await import(${JSON.stringify(join(import.meta.dir, 'store.ts'))});
const {assertWorkflow${probe}Race}=await import(${JSON.stringify(join(import.meta.dir, '../store-conformance.ts'))});
const store=await createFileWorkflowStore({root:${JSON.stringify(root)}});
let rejected=false;
try {await assertWorkflow${probe}Race(store);} catch {rejected=true;}
console.log(JSON.stringify({rejected,wins}));`;
    const child = Bun.spawn([process.execPath, '-e', script], {
      env: { ...process.env, LOG_LEVEL: 'silent' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(error).toBe('');
    expect(code).toBe(0);
    const { rejected, wins } = JSON.parse(output) as { rejected: boolean; wins: number };
    expect(rejected).toBe(true);
    // The race itself ran eight writers; a lost CAS shows as several winners.
    expect(wins).toBeGreaterThan(1);
  },
  30000
);

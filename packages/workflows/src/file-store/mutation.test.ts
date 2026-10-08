import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTempRoots } from '@archon/paths/test-utils';
const roots = trackTempRoots();
test.each(['Claim', 'Gate'])(
  'the real file store fails the %s conformance probe with its mutex disabled',
  async probe => {
    const root = roots(await mkdtemp(join(tmpdir(), 'file-broken-cas-')));
    const script = `import {mock} from 'bun:test';
const lock=await import(${JSON.stringify(join(import.meta.dir, 'lock.ts'))});
mock.module(${JSON.stringify(join(import.meta.dir, 'lock.ts'))},()=>({...lock,withFileStoreLock:async (_root,operation)=>operation()}));
const {createFileWorkflowStore}=await import(${JSON.stringify(join(import.meta.dir, 'store.ts'))});
const {assertWorkflow${probe}Race}=await import(${JSON.stringify(join(import.meta.dir, '../store-conformance.ts'))});
const store=await createFileWorkflowStore({root:${JSON.stringify(root)}});
try {await assertWorkflow${probe}Race(store);process.exit(1);}
catch {console.log('broken mutex rejected');}`;
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
    expect(output.trim()).toBe('broken mutex rejected');
    expect(code).toBe(0);
  },
  30000
);

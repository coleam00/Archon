import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import * as realPaths from '@archon/paths';

const bundledName = '__archon_pack__bundled:video-pack:render::hello';

mock.module('@archon/paths', () => ({
  ...realPaths,
  createLogger: mock(() => ({
    debug: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  })),
}));

mock.module('./defaults/bundled-defaults', () => ({
  BUNDLED_SCRIPTS: {
    [bundledName]: {
      content: "console.log('BUNDLED SCRIPT OK');\n",
      extension: '.js',
      runtime: 'bun',
    },
  },
  isBinaryBuild: () => true,
}));

import { discoverScriptsForCwd } from './script-discovery';

describe('bundled packaged script materialization (#2527)', () => {
  let root: string;
  let originalArchonHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'archon-bundled-script-'));
    originalArchonHome = process.env.ARCHON_HOME;
    process.env.ARCHON_HOME = join(root, 'home');
  });

  afterEach(async () => {
    if (originalArchonHome === undefined) delete process.env.ARCHON_HOME;
    else process.env.ARCHON_HOME = originalArchonHome;
    await rm(root, { recursive: true, force: true });
  });

  it('writes embedded content to a stable file and executes it', async () => {
    const scripts = await discoverScriptsForCwd(join(root, 'repo'));
    const script = scripts.get(bundledName);
    expect(script?.runtime).toBe('bun');
    expect(script?.path).toContain('/cache/workflow-scripts/video-pack/render/hello-');
    expect(await readFile(script!.path, 'utf-8')).toBe("console.log('BUNDLED SCRIPT OK');\n");

    const processResult = Bun.spawn(['bun', '--no-env-file', 'run', script!.path], {
      stdout: 'pipe',
    });
    expect((await new Response(processResult.stdout).text()).trim()).toBe('BUNDLED SCRIPT OK');
    expect(await processResult.exited).toBe(0);

    const second = await discoverScriptsForCwd(join(root, 'repo'));
    expect(second.get(bundledName)?.path).toBe(script?.path);
  });
});

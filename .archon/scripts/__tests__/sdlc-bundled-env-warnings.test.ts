import { providerRegistry } from '@archon/providers';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '../../../packages/paths/src/test-utils';
import { discoverWorkflows } from '../../../packages/workflows/src/workflow-discovery';

// The bundled SDLC pack ships from this repo's own .archon/workflows/sdlc — this test
// discovers it for real (no mocked filesystem), reproducing what `archon workflow list`
// sees on a fresh install.

const trackTempRoot = trackTempRoots();

let projectDir: string;
let previousArchonHome: string | undefined;

beforeEach(async () => {
  projectDir = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-sdlc-pack-project-')));
  // A real ~/.archon/workflows/ on the machine running this test must not leak
  // unrelated warnings into the assertion below.
  const homeDir = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-sdlc-pack-home-')));
  previousArchonHome = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = homeDir;
});

afterEach(() => {
  if (previousArchonHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousArchonHome;
});

test('the bundled sdlc pack never warns about ARCHON_SDLC_FORGE', async () => {
  const result = await discoverWorkflows(projectDir, {providers: providerRegistry,  loadDefaults: true });

  expect(result.errors).toEqual([]);
  const warnings = result.workflows.flatMap(w => w.parseWarnings ?? []);
  expect(warnings.filter(warning => warning.includes('ARCHON_SDLC_FORGE'))).toEqual([]);
});

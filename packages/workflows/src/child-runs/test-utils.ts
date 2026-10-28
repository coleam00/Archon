import { providerRegistry } from '@archon/providers';
import { settlingProvider } from '../test-settling-provider';
/**
 * Shared scaffolding for the end-to-end `workflow:` sub-run tests (#2121 Phase 2), the
 * `child-runs.*.test.ts` files beside child-runs.ts.
 *
 * Those tests drive the REAL executor recursion — executeWorkflow → runChildWorkflow
 * closure → executeDagWorkflow → executeWorkflowNode → child executeWorkflow — with
 * a stateful in-memory store (`InMemoryStore`, in test-store.ts), a canned AI
 * provider, and real workflow files on disk (so runChildWorkflow's
 * discovery/resolveWorkflowName and the parent auto-resume hook both work against
 * real definitions).
 *
 * Importing this module replaces `@archon/paths`, `@archon/git` and `fs/promises`
 * with test doubles and registers the built-in providers, so it must be the first
 * import of a test file that starts with `// @archon-test-isolated`. Such a file
 * deliberately does NOT mock ./dag-executor, so it cannot share a process with the
 * executor.*.test.ts files, which do (mock.module is process-global and irreversible).
 */
import { readBundleIndex } from '../defaults/bundle-inventory';
import { afterAll, mock } from 'bun:test';
import { mkdir, cp } from 'fs/promises';
import { removeTempTree } from '@archon/paths/test-utils';
import { existsSync } from 'fs';
import { dirname, join, sep } from 'path';
import { tmpdir } from 'os';

// --- Mock logger + telemetry (passthrough real path utilities like loader.test.ts) ---
export const mockLogger = {
  fatal: mock(() => undefined),
  error: mock(() => undefined),
  warn: mock(() => undefined),
  info: mock(() => undefined),
  debug: mock(() => undefined),
  trace: mock(() => undefined),
  child: mock(function () {
    return mockLogger;
  }),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
// Capture-cost control: captureWorkflowSource writes the BUNDLED defaults scope
// (the repo's own .archon/workflows + .archon/commands) into EVERY staged source
// capture, on every executeWorkflow level of every run in this file — e2e timing
// evidence (#2121 Phase 2 CI) shows that uncontrolled per-run fs fan-out is what
// pushed the specimen test past the 5000ms budget Windows CI then had. #2924
// hoisted the READ and the hash of that scope out of the per-capture path, but
// the bytes still have to land in each capture, so the writes remain and so does
// this lever. No test here exercises bundled default CONTENT: every discovery call
// opts out of loading them (`loadDefaults: false`) and every workflow under test is
// written to the tmp cwd. Pointing the two bundle path getters at a dedicated EMPTY
// directory (outside ARCHON_HOME) keeps the capture's bundled-scope semantics (an
// existing-but-empty tree is scanned, recorded in the manifest with 0 files) while
// removing that file fan-out per capture per platform-multiplied runner.
const bundledDefaultsRoot = join(tmpdir(), `subrun-test-empty-bundled-${process.pid}`);
await mkdir(join(bundledDefaultsRoot, 'defaults'), { recursive: true });
for (const pack of await readBundleIndex())
  await mkdir(join(bundledDefaultsRoot, pack), { recursive: true });
afterAll(() => removeTempTree(bundledDefaultsRoot));
export const realArchonPaths = await import('@archon/paths');
/** Every `workflow_invoked` telemetry call, in order, so a resumed drive's categorization
 *  can be compared with the dispatch that started the run. */
export const telemetryInvocations: { workflowName: string; workflowSource?: string }[] = [];
/** Each `workflow_invoked` call's resume flag, kept apart so the categorization records
 *  above stay comparable as whole objects. */
export const telemetryResumeFlags: { workflowName: string; isResume?: boolean }[] = [];
mock.module('@archon/paths', () => ({
  ...realArchonPaths,
  // NB: point these one level DEEP (`<root>/defaults`) — captureWorkflowSource copies
  // dirname(getDefault*Path()), so the getter's PARENT must be the owned empty tree.
  getBundledWorkflowsPath: () => bundledDefaultsRoot,
  createLogger: mock(() => mockLogger),
  captureWorkflowInvoked: mock(
    (props: { workflowName: string; workflowSource?: string; isResume?: boolean }) => {
      telemetryInvocations.push({
        workflowName: props.workflowName,
        workflowSource: props.workflowSource,
      });
      telemetryResumeFlags.push({ workflowName: props.workflowName, isResume: props.isResume });
    }
  ),
  captureApprovalResolved: mock(() => undefined),
}));

// --- Mock git (no real repo needed) ---
export const detectDefaultBranch = mock(async () => 'main');
mock.module('@archon/git', () => ({
  getDefaultBranch: detectDefaultBranch,
  getDefaultRemote: mock(async () => 'origin'),
  toRepoPath: mock((p: string) => p),
}));

// --- Filesystem controls keep source removal pending or force the rename the recursive
//     executeWorkflow performs (moving the staged capture under the child's
//     artifacts directory) to throw. The wrap's `finally` is the only thing that
//     can reclaim that staged capture when the rename fails — without the fix
//     in runChildWorkflow, the staged tree leaks until the hourly age-based
//     sweep reaps it (review R1). Removal gates only target existing, finalized
//     roots under the current test staging directory; preparation and other cleanup
//     delegate to the real filesystem.
//
//     The forced failure targets ONLY the move-out-of-staging rename: source
//     lives under `staged-source/`, destination does NOT. `captureWorkflowSource`
//     also does a rename (staged-source/<uuid>.partial -> staged-source/<uuid>)
//     and that one must keep working, otherwise `prepareWorkflowSource` itself
//     throws before runChildWorkflow reaches the recursive call.
//
//     The path predicate uses `path.sep`, not a hardcoded forward slash:
//     `fs/promises.rename` on Windows is called with backslash-separated paths
//     produced by `path.join`, so a literal `'staged-source/'` substring check
//     never matches there and the test fails to exercise the reclaim path it is
//     here to prove. ---
const realFsPromises = await import('fs/promises');
let forceRenameFailure = false;
export function setForceRenameFailure(value: boolean): void {
  forceRenameFailure = value;
}
const passthroughRename = realFsPromises.rename;
const passthroughRemove = realFsPromises.rm;
let removeSource: typeof passthroughRemove | undefined;

export function holdSourceRemoval(
  stagedDir: string,
  removalError?: Error
): {
  started: Promise<string>;
  release: () => void;
  finish: () => Promise<void>;
} {
  let signalStarted!: (root: string) => void;
  let release!: () => void;
  let activeRemoval: Promise<void> = Promise.resolve();
  const started = new Promise<string>(resolve => {
    signalStarted = resolve;
  });
  const released = new Promise<void>(resolve => {
    release = resolve;
  });
  removeSource = (path, options) => {
    if (
      typeof path !== 'string' ||
      dirname(path) !== stagedDir ||
      path.endsWith('.partial') ||
      !existsSync(path)
    ) {
      return passthroughRemove(path, options);
    }
    signalStarted(path);
    activeRemoval = released.then(async () => {
      if (removalError) throw removalError;
      await passthroughRemove(path, options);
    });
    return activeRemoval;
  };
  return {
    started,
    release,
    finish: async () => {
      release();
      await activeRemoval.catch(() => undefined);
      removeSource = undefined;
    },
  };
}
const stagedSourcePathSep = `staged-source${sep}`;
mock.module('fs/promises', () => ({
  ...realFsPromises,
  rm: (...args: Parameters<typeof passthroughRemove>): Promise<void> =>
    (removeSource ?? passthroughRemove)(...args),
  rename: async (src: string, dst: string): Promise<void> => {
    if (
      forceRenameFailure &&
      src.includes(stagedSourcePathSep) &&
      !dst.includes(stagedSourcePathSep)
    ) {
      throw new Error(`forced rename failure for test: ${src} -> ${dst}`);
    }
    return passthroughRename(src, dst);
  },
}));

// --- Bootstrap provider registry (load-time isRegisteredProvider checks) ---
import { clearRegistry } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
clearRegistry();
registerBuiltinProviders();

import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from '../deps';
import type { IWorkflowStore } from '../store';
import type { WorkflowRunConfigMetadata } from '../schemas/run-config';
import type {
  ChildIsolationResolver,
  ChildIsolationRequest,
  ChildIsolationResult,
} from '../child-isolation';

// --- Canned AI provider: every prompt node yields the same output + a small cost ---
export function makeProvider() {
  return {
    getType: () => 'claude',
    getCapabilities: () => ({
      backgroundWork: 'unobserved' as const,
      sessionResume: true,
      mcp: true,
      hooks: true,
      skills: true,
      agents: true,
      toolRestrictions: true,
      structuredOutput: 'enforced' as const,
      envInjection: true,
      costControl: true,
      effortControl: true,
      fallbackModel: true,
      sandbox: true,
    }),
    sendQuery: mock(function* () {
      yield { type: 'agent_message_chunk', text: 'ai-output' };
      yield {
        type: 'result',
        sessionId: 'sess',
        cost: 0.01,
        tokens: { input: 7, output: 3, cacheRead: 5, cacheWrite: 0 },
      };
    }),
  };
}

export function makeDeps(store: IWorkflowStore): WorkflowDeps {
  return {
    providers: providerRegistry,
    store,
    getAgentProvider: mock(() =>
      settlingProvider(makeProvider())
    ) as unknown as WorkflowDeps['getAgentProvider'],
    loadConfig: mock(
      (): Promise<WorkflowConfig> =>
        Promise.resolve({
          assistant: 'claude',
          assistants: { claude: {}, codex: {} },
          commands: {},
          defaults: { loadDefaultCommands: false, loadDefaultWorkflows: false },
        })
    ),
    sealRunConfig: (layer, source): WorkflowRunConfigMetadata => ({
      version: 1,
      ciphertext: 'opaque-test-payload',
      source,
      keys: [
        ...Object.keys(layer.tiers ?? {}).map(name => `tiers.${name}`),
        ...Object.keys(layer.envVars ?? {}).map(name => `env.${name}`),
      ].sort(),
    }),
  };
}

export function makePlatform(): IWorkflowPlatform {
  return {
    sendMessage: mock(() => Promise.resolve()),
    getStreamingMode: mock(() => 'batch' as const),
    getPlatformType: mock(() => 'test'),
    sendStructuredEvent: mock(() => Promise.resolve()),
  };
}

/**
 * Fake child-isolation resolver (slice 2, PR-A). Records the requests it receives
 * and returns a fixed per-child cwd, creating it on disk so the child's
 * executeWorkflow (artifacts/logs) has a real directory — a real worktree IS a
 * real checkout.
 */
export function makeFakeResolver(childCwd: string): {
  resolver: ChildIsolationResolver;
  calls: ChildIsolationRequest[];
} {
  const calls: ChildIsolationRequest[] = [];
  const resolver: ChildIsolationResolver = {
    async resolve(req: ChildIsolationRequest): Promise<ChildIsolationResult> {
      calls.push(req);
      await mkdir(childCwd, { recursive: true });
      return {
        cwd: childCwd,
        envId: `env-${String(req.childIndex ?? 0)}`,
        baseBranch: 'child-release',
        branchName: `archon/task-${req.parentRun.id.slice(0, 8)}-child-${String(req.childIndex ?? 0)}`,
      };
    },
  };
  return { resolver, calls };
}

/**
 * Fan-out child-isolation resolver (slice 2, PR-C): gives each child a DISTINCT
 * worktree keyed by childIndex (so N concurrent siblings don't collide on the path
 * lock) and copies the repo's `.archon` into it so the child can still discover its
 * own target workflow from the isolated checkout. Records the requests it saw.
 */
export function makeFanResolver(root: string): {
  resolver: ChildIsolationResolver;
  calls: ChildIsolationRequest[];
} {
  const calls: ChildIsolationRequest[] = [];
  const resolver: ChildIsolationResolver = {
    async resolve(req: ChildIsolationRequest): Promise<ChildIsolationResult> {
      calls.push(req);
      const idx = req.childIndex ?? 0;
      const dir = join(root, 'wt', `${req.parentRun.id}-child-${String(idx)}`);
      await mkdir(dir, { recursive: true });
      // Copy ONLY the workflows subtree, not all of `.archon`: the child reads no
      // other fixture state out of its isolated checkout (config comes from the
      // mocked loadConfig; artifacts land under ARCHON_HOME). A full-tree cp re-copied
      // every artifact/log directory earlier drives had created into `.archon`,
      // growing per child per drive — exactly the uncontrolled per-child fs cost this
      // resolver exists to keep bounded.
      const workflowsRoot = join(root, '.archon', 'workflows');
      if (existsSync(workflowsRoot)) {
        await mkdir(join(dir, '.archon'), { recursive: true });
        await cp(workflowsRoot, join(dir, '.archon', 'workflows'), { recursive: true });
      }
      return {
        cwd: dir,
        envId: `env-${req.parentRun.id.slice(0, 8)}-${String(idx)}`,
        baseBranch: 'child-release',
        branchName: `archon/task-${req.parentRun.id.slice(0, 8)}-child-${String(idx)}`,
      };
    },
  };
  return { resolver, calls };
}

/** Child that echoes its per-item $ARGUMENTS, so fan-out aggregate ordering + the
 *  item→$ARGUMENTS channel are both observable. Declares no `mutates_checkout`, so it
 *  is treated as a repo-writing child (the default posture). */
export const fanChildEcho = `
name: fan-child
description: echoes its per-item argument
nodes:
  - id: echo
    bash: |
      printf 'did:%s' "$ARGUMENTS"
`;

/** Child that succeeds echoing its arg, but fails (exit 3) on the item "boom". Read-only,
 *  so N of these share the parent checkout without contending for the path lock. */
export const fanChildCond = `
name: fan-child-cond
description: fails on the item "boom", echoes otherwise
mutates_checkout: false
nodes:
  - id: run
    bash: |
      if [ "$ARGUMENTS" = "boom" ]; then exit 3; fi
      printf 'ok:%s' "$ARGUMENTS"
`;

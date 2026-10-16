/**
 * Installed workflow packs in the one catalog: every consumer resolves them through
 * `discoverWorkflowsWithConfig`, only manifest entrypoints are dispatchable, and a run
 * keeps the pack bytes it captured.
 *
 * Packs are written the way `archon plugin add` leaves them (a receipt under
 * `plugins/installed/` and a tree under `plugins/packs/`) into a temp ARCHON_HOME.
 */
import { providerRegistry, claudeDescriptor } from '@archon/providers';
import { registerBuiltinProviders } from '@archon/providers/in-process';
import { readHomeMcpDirectory } from './compiled-command';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, cp, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { packTreePath, receiptPath } from '@archon/plugin-manifest/store';
import { trackTempRoots } from '@archon/paths/test-utils';
import { discoverWorkflowsWithConfig, workflowLoadErrorName } from './workflow-discovery';
import { findWorkflow, resolveWorkflowName } from './router';
import { validateWorkflowResources } from './validator';
import { loadCommandPrompt } from './executor-shared';
import { discoverScriptsForCwd } from './script-discovery';
import { resolveContinuationWorkflow } from './executor';
import { resolveFanOutChildDefinition } from './dag-executor';
import {
  captureWorkflowSource,
  capturedSourceRoots,
  resolveChildInstalledPacks,
  isSourceReadFailure,
  type WorkflowSourceCapture,
} from './workflow-source';
import * as sourceIntegrity from './workflow-source';
import { WORKFLOW_SOURCE_METADATA_KEY } from './schemas/workflow-run';
import { isAgentNode, type ResolvedWorkflow } from './schemas';
import type { WorkflowDeps } from './deps';

const trackTempRoot = trackTempRoots();
const loadConfig = async (): Promise<Record<string, never>> => ({});
const deps = { loadConfig } as unknown as WorkflowDeps;

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const ID = 'acme/packs/review-kit';
const REVIEW = 'acme/review-kit:review';
const HELPER = 'acme/review-kit:helper';

let home: string;
let project: string;
let previousHome: string | undefined;

interface PackFixture {
  id: string;
  name: string;
  commit: string;
  entrypoints: Record<string, string>;
  files: Record<string, string>;
}

/** Write a pack exactly where `archon plugin add` puts one. */
async function install(pack: PackFixture): Promise<void> {
  const pluginsDir = join(home, 'plugins');
  const manifest = {
    schemaVersion: 1,
    kind: 'workflow-pack',
    name: pack.name,
    description: 'fixture pack',
    entrypoints: pack.entrypoints,
  };
  const tree = packTreePath(pluginsDir, pack.id, pack.commit);
  for (const [path, content] of Object.entries({
    ...pack.files,
    'archon-plugin.json': JSON.stringify(manifest),
  })) {
    await mkdir(dirname(join(tree, path)), { recursive: true });
    await writeFile(join(tree, path), content);
  }
  const receipt = receiptPath(pluginsDir, pack.id);
  await mkdir(dirname(receipt), { recursive: true });
  await writeFile(
    receipt,
    JSON.stringify({
      schemaVersion: 1,
      id: pack.id,
      manifest,
      commit: pack.commit,
      installedAt: new Date(0).toISOString(),
    })
  );
}

async function uninstall(id: string, commit: string): Promise<void> {
  await rm(receiptPath(join(home, 'plugins'), id));
  await rm(packTreePath(join(home, 'plugins'), id, commit), { recursive: true });
}

/**
 * review-kit: the `review` entrypoint uses its own command and script and includes the
 * `helper` support workflow, which has a command of its own.
 */
function reviewKit(commit = COMMIT_A, marker = 'v1'): PackFixture {
  return {
    id: ID,
    name: 'review-kit',
    commit,
    entrypoints: { review: 'review/code-review.yaml' },
    files: {
      'review/code-review.yaml': `name: code-review
description: Review a change (${marker})
nodes:
  - id: scope
    command: scope
  - id: helper
    include: helper
    depends_on: [scope]
  - id: check
    script: check
    runtime: bun
    depends_on: [helper]
`,
      'review/commands/scope.md': `Scope the change (${marker}).\n`,
      'review/scripts/check.ts': 'console.log("ok");\n',
      'helper/helper.yaml': `name: helper
description: Support workflow
nodes:
  - id: summarize
    command: summarize
`,
      'helper/commands/summarize.md': 'Summarize.\n',
      '.shared/util.ts': 'export const util = 1;\n',
    },
  };
}

const discover = (): ReturnType<typeof discoverWorkflowsWithConfig> =>
  discoverWorkflowsWithConfig(project, loadConfig, providerRegistry);
const names = (entries: readonly { workflow: { name: string } }[]): string[] =>
  entries.map(entry => entry.workflow.name);

beforeEach(async () => {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'installed-packs-')));
  home = join(root, 'home');
  project = join(root, 'project');
  await mkdir(join(project, '.archon', 'workflows'), { recursive: true });
  previousHome = process.env.ARCHON_HOME;
  process.env.ARCHON_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousHome;
});

describe('installed packs in the catalog', () => {
  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a failed installed workflow does not reserve impossible manifest entrypoint names',
    async () => {
      await install({ ...reviewKit(), id: 'other/repo', name: 'broken' });
      const name = 'other/broken:review extra';
      await writeFile(
        join(project, '.archon/workflows/project.yaml'),
        `name: '${name}'\ndescription: Project\nnodes:\n  - id: done\n    prompt: done\n`
      );
      const path = join(
        packTreePath(join(home, 'plugins'), 'other/repo', COMMIT_A),
        'review/code-review.yaml'
      );
      try {
        await chmod(path, 0o000);
        expect(names((await discover()).workflows)).toContain(name);
      } finally {
        await chmod(path, 0o644);
      }
    }
  );

  for (const fault of ['malformed', 'missing', 'unreadable'] as const) {
    test.skipIf(
      fault === 'unreadable' && (process.platform === 'win32' || process.getuid?.() === 0)
    )(`a selected ${fault} entrypoint retains its public name and load diagnostic`, async () => {
      const pack = reviewKit();
      if (fault === 'malformed') pack.files['review/code-review.yaml'] = 'nodes: [';
      if (fault === 'missing') delete pack.files['review/code-review.yaml'];
      await install(pack);
      const path = join(
        packTreePath(join(home, 'plugins'), ID, COMMIT_A),
        'review/code-review.yaml'
      );
      try {
        if (fault === 'unreadable') await chmod(path, 0o000);
        const catalog = await discover();
        const errors = catalog.errors.filter(error => workflowLoadErrorName(error) === REVIEW);
        expect(errors.length).toBeGreaterThan(0);
        expect(
          errors.every(error => error.filename === 'acme/review-kit/review/code-review.yaml')
        ).toBe(true);
        const diagnostic = errors.find(
          error =>
            error.errorType ===
            (fault === 'malformed'
              ? 'parse_error'
              : fault === 'unreadable'
                ? 'read_error'
                : 'validation_error')
        );
        if (!diagnostic) throw new Error(`Missing ${fault} entrypoint diagnostic`);
        const resolution = resolveFanOutChildDefinition(
          { ...deps, providers: providerRegistry },
          project,
          REVIEW
        );
        if (fault === 'unreadable') {
          await expect(resolution).rejects.toMatchObject({ code: 'EACCES' });
        } else {
          expect(await resolution).toEqual({ unresolved: diagnostic.error });
        }
      } finally {
        if (fault === 'unreadable') await chmod(path, 0o644);
      }
    });
  }

  for (const fault of [
    'pack-read',
    'path-read',
    'directory-read',
    'cardinality',
    'support-dispatch',
  ] as const) {
    test.skipIf(
      ['pack-read', 'path-read', 'directory-read'].includes(fault) &&
        (process.platform === 'win32' || process.getuid?.() === 0)
    )(`a selected entrypoint retains its actual ${fault} diagnostic`, async () => {
      const pack = reviewKit();
      if (fault === 'support-dispatch') {
        pack.files['review/code-review.yaml'] =
          'name: code-review\ndescription: Review\nnodes:\n  - id: child\n    workflow: helper\n';
      }
      await install(pack);
      const tree = packTreePath(join(home, 'plugins'), ID, COMMIT_A);
      const folder = join(tree, 'review');
      const denied = join(home, 'denied');
      if (fault === 'pack-read') await chmod(tree, 0o111);
      if (fault === 'directory-read') await chmod(folder, 0o000);
      if (fault === 'path-read') {
        await mkdir(denied);
        await rename(folder, join(denied, 'review'));
        await symlink(join(denied, 'review'), folder);
        await chmod(denied, 0o000);
      }
      if (fault === 'cardinality') await writeFile(join(folder, 'extra.yaml'), 'name: extra');
      try {
        const catalog = await discover();
        const errors = catalog.errors.filter(error => workflowLoadErrorName(error) === REVIEW);
        expect(errors).toHaveLength(1);
        const diagnostic = errors[0];
        if (fault === 'support-dispatch' || fault === 'cardinality') {
          expect(diagnostic.error).toContain(
            fault === 'support-dispatch' ? 'only entrypoints are dispatchable' : 'exactly one'
          );
          expect(
            await resolveFanOutChildDefinition(
              { ...deps, providers: providerRegistry },
              project,
              REVIEW
            )
          ).toEqual({ unresolved: diagnostic.error });
        } else {
          expect(diagnostic).toMatchObject({ errorType: 'read_error', cause: { code: 'EACCES' } });
          await expect(
            resolveFanOutChildDefinition({ ...deps, providers: providerRegistry }, project, REVIEW)
          ).rejects.toMatchObject({ code: 'EACCES' });
        }
      } finally {
        if (fault === 'pack-read') await chmod(tree, 0o755);
        if (fault === 'directory-read') await chmod(folder, 0o755);
        if (fault === 'path-read') await chmod(denied, 0o755);
      }
    });
  }

  for (const fault of ['duplicate-name', 'support-dispatch'] as const) {
    test(`authored-name collisions preserve each file's public identity for ${fault}`, async () => {
      const pack = reviewKit();
      pack.files['review/code-review.yaml'] =
        `name: shared\ndescription: Review\nnodes:\n  - id: child\n    ${fault === 'support-dispatch' ? 'workflow: helper' : 'prompt: review'}\n`;
      pack.files['z-support/support.yaml'] =
        'name: shared\ndescription: Support\nnodes:\n  - id: done\n    prompt: support\n';
      if (fault === 'duplicate-name') {
        pack.files['zz-support/support.yaml'] = pack.files['z-support/support.yaml'];
      }
      await install(pack);
      const catalog = await discover();
      const selectedErrors = catalog.errors.filter(
        error => workflowLoadErrorName(error) === REVIEW
      );
      const resolution = await resolveFanOutChildDefinition(
        { ...deps, providers: providerRegistry },
        project,
        REVIEW
      );
      if (fault === 'support-dispatch') {
        expect(selectedErrors).toHaveLength(1);
        expect(selectedErrors[0]).toMatchObject({
          filename: 'acme/review-kit/review/code-review.yaml',
          errorType: 'validation_error',
        });
        expect(selectedErrors[0].error).toContain('only entrypoints are dispatchable');
        expect(resolution).toEqual({ unresolved: selectedErrors[0].error });
      } else {
        expect(selectedErrors).toEqual([]);
        expect(names(catalog.workflows)).toContain(REVIEW);
        expect(resolution).not.toHaveProperty('unresolved');
        const supportErrors = catalog.errors.filter(
          error => workflowLoadErrorName(error) === 'acme/review-kit:shared'
        );
        expect(supportErrors).toHaveLength(2);
        for (const error of supportErrors) expect(error.error).toContain('Duplicate workflow name');
      }
    });
  }

  for (const collision of ['entrypoint', 'support'] as const) {
    for (const reference of [
      'include',
      'workflow',
      'fan-out include',
      'fan-out workflow',
      'loop include',
    ] as const) {
      test(`ambiguous authored references reject ${reference} with an entrypoint/${collision} collision`, async () => {
        const field = reference.includes('workflow') ? 'workflow' : 'include';
        let nodes = `  - id: child\n    ${field}: shared\n`;
        if (reference.startsWith('fan-out')) {
          nodes += `    fan_out:\n      items: '["a"]'\n      as: item\n`;
        }
        if (reference === 'loop include') {
          nodes = `  - id: group\n    loop_group:\n      until_bash: exit 0\n      max_iterations: 1\n      nodes:\n        - id: child\n          include: shared\n`;
        }
        await install({
          id: ID,
          name: 'review-kit',
          commit: COMMIT_A,
          entrypoints: {
            review: 'review/review.yaml',
            first: 'first/first.yaml',
            ...(collision === 'entrypoint' ? { second: 'second/second.yaml' } : {}),
          },
          files: {
            'review/review.yaml': `name: review\ndescription: Caller\nnodes:\n${nodes}`,
            'first/first.yaml':
              'name: shared\ndescription: First\nnodes:\n  - id: done\n    bash: echo first\n',
            'second/second.yaml':
              'name: shared\ndescription: Second\nnodes:\n  - id: done\n    bash: echo second\n',
          },
        });
        const catalog = await discover();
        const errors = catalog.errors.filter(error => workflowLoadErrorName(error) === REVIEW);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({
          filename: 'acme/review-kit/review/review.yaml',
          errorType: 'validation_error',
        });
        expect(errors[0].error).toContain("Ambiguous workflow reference 'shared'");
        expect(names(catalog.workflows)).not.toContain(REVIEW);
        expect(names(catalog.workflows)).toContain('acme/review-kit:first');
        expect(
          names(collision === 'entrypoint' ? catalog.workflows : (catalog.support ?? []))
        ).toContain(`acme/review-kit:${collision === 'entrypoint' ? 'second' : 'shared'}`);
        expect(
          await resolveFanOutChildDefinition(
            { ...deps, providers: providerRegistry },
            project,
            REVIEW
          )
        ).toEqual({
          unresolved: errors[0].error,
        });
      });
    }
  }

  for (const casing of ['exact', 'mixed'] as const) {
    for (const collision of ['entrypoint', 'support'] as const) {
      for (const aliases of [1, 2]) {
        for (const reference of [
          'include',
          'workflow',
          'fan-out include',
          'fan-out workflow',
          'loop include',
        ] as const) {
          test(`qualified ${reference} selects its public target over ${aliases} colliding ${collision} aliases (${casing} case)`, async () => {
            const target = 'acme/review-kit:first';
            const requested = casing === 'mixed' ? 'ACME/Review-Kit:FIRST' : target;
            const field = reference.includes('workflow') ? 'workflow' : 'include';
            let nodes = `  - id: child\n    ${field}: ${requested}\n`;
            if (reference.startsWith('fan-out')) {
              nodes += `    fan_out:\n      items: '["a"]'\n      as: item\n`;
            }
            if (reference === 'loop include') {
              nodes = `  - id: group\n    loop_group:\n      until_bash: exit 0\n      max_iterations: 1\n      nodes:\n        - id: child\n          include: ${requested}\n`;
            }
            await install({
              id: ID,
              name: 'review-kit',
              commit: COMMIT_A,
              entrypoints: {
                review: 'review/review.yaml',
                first: 'first/first.yaml',
                ...(collision === 'entrypoint' ? { second: 'second/second.yaml' } : {}),
                ...(collision === 'entrypoint' && aliases === 2
                  ? { third: 'third/third.yaml' }
                  : {}),
              },
              files: {
                'review/review.yaml': `name: review\ndescription: Caller\nnodes:\n${nodes}`,
                'first/first.yaml':
                  'name: shared\ndescription: First\nnodes:\n  - id: done\n    bash: echo first\n',
                'second/second.yaml': `name: ${requested}\ndescription: Second\nnodes:\n  - id: done\n    bash: echo second\n`,
                ...(aliases === 2
                  ? {
                      'third/third.yaml': `name: ${requested}\ndescription: Third\nnodes:\n  - id: done\n    bash: echo third\n`,
                    }
                  : {}),
              },
            });
            const catalog = await discover();
            expect(catalog.errors.filter(error => workflowLoadErrorName(error) === REVIEW)).toEqual(
              []
            );
            const caller = catalog.workflows.find(entry => entry.workflow.name === REVIEW);
            const node = caller?.workflow.nodes[0];
            if (reference === 'loop include') {
              expect(node).toMatchObject({
                loop_group: { nodes: [{ script: 'echo first' }] },
              });
            } else {
              expect(node).toMatchObject(
                field === 'workflow'
                  ? { workflow: target }
                  : reference === 'fan-out include'
                    ? { include: target }
                    : { script: 'echo first' }
              );
            }
            if (reference.startsWith('fan-out') || field === 'workflow') {
              await expect(
                resolveFanOutChildDefinition(
                  { ...deps, providers: providerRegistry },
                  project,
                  target
                )
              ).resolves.toMatchObject({ definition: { nodes: [{ script: 'echo first' }] } });
            }
          });
        }
      }
    }
  }

  for (const reference of [
    'include',
    'workflow',
    'fan-out include',
    'fan-out workflow',
    'loop include',
  ] as const) {
    const field = reference.includes('workflow') ? 'workflow' : 'include';
    const callerNodes = (target: string): string => {
      if (reference === 'loop include') {
        return `  - id: group
    loop_group:
      until_bash: exit 0
      max_iterations: 1
      nodes:
        - id: child
          include: ${target}
`;
      }
      return `  - id: child
    ${field}: ${target}
${reference.startsWith('fan-out') ? `    fan_out:\n      items: '["a"]'\n      as: item\n` : ''}`;
    };

    for (const entrypoint of [false, true]) {
      test(`ambiguous qualified ${reference} rejects only its caller (${entrypoint ? 'entrypoint/support' : 'two supports'})`, async () => {
        const requested = 'ACME/review-kit:HeLpEr';
        await install({
          id: ID,
          name: 'review-kit',
          commit: COMMIT_A,
          entrypoints: {
            review: 'review/workflow.yaml',
            healthy: 'healthy/workflow.yaml',
            ...(entrypoint ? { helper: 'first/workflow.yaml' } : {}),
          },
          files: {
            'review/workflow.yaml': `name: review\ndescription: Caller\nnodes:\n${callerNodes(requested)}`,
            'healthy/workflow.yaml':
              'name: healthy\ndescription: Healthy\nnodes:\n  - id: done\n    bash: echo healthy\n',
            'first/workflow.yaml':
              'name: helper\ndescription: First\nnodes:\n  - id: done\n    bash: echo first\n',
            'second/workflow.yaml':
              'name: HELPER\ndescription: Second\nnodes:\n  - id: done\n    bash: echo second\n',
          },
        });
        const catalog = await discover();
        const errors = catalog.errors.filter(error => workflowLoadErrorName(error) === REVIEW);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({
          filename: 'acme/review-kit/review/workflow.yaml',
          errorType: 'validation_error',
        });
        expect(errors[0].error).toContain(`Ambiguous workflow '${requested}'`);
        expect(errors[0].error).toContain('acme/review-kit:helper');
        expect(errors[0].error).toContain('acme/review-kit:HELPER');
        expect(names(catalog.workflows)).not.toContain(REVIEW);
        expect(names(catalog.workflows)).toContain('acme/review-kit:healthy');
        await expect(
          resolveFanOutChildDefinition(
            { ...deps, providers: providerRegistry },
            project,
            'acme/review-kit:healthy'
          )
        ).resolves.toMatchObject({ definition: { nodes: [{ script: 'echo healthy' }] } });
      });
    }

    for (const source of ['project', 'global'] as const) {
      for (const entrypoint of [false, true]) {
        test(`rejected installed ${reference} cannot fall back to a ${source} shadow (${entrypoint ? 'entrypoint' : 'support'})`, async () => {
          const requested = 'ACME/review-kit:HeLpEr';
          await install({
            id: ID,
            name: 'review-kit',
            commit: COMMIT_A,
            entrypoints: {
              healthy: 'healthy/workflow.yaml',
              ...(entrypoint ? { review: 'review/workflow.yaml' } : {}),
            },
            files: {
              'review/workflow.yaml': `name: review\ndescription: Caller\nnodes:\n${callerNodes(requested)}`,
              'healthy/workflow.yaml':
                'name: healthy\ndescription: Healthy\nnodes:\n  - id: done\n    bash: echo healthy\n',
              'first/workflow.yaml':
                'name: helper\ndescription: First\nnodes:\n  - id: done\n    bash: echo first\n',
              'second/workflow.yaml':
                'name: HELPER\ndescription: Second\nnodes:\n  - id: done\n    bash: echo second\n',
            },
          });
          const folder =
            source === 'project' ? join(project, '.archon', 'workflows') : join(home, 'workflows');
          await mkdir(folder, { recursive: true });
          await writeFile(
            join(folder, 'shadow.yaml'),
            `name: ${REVIEW}\ndescription: Shadow\nnodes:\n  - id: wrong\n    bash: echo wrong\n`
          );
          const catalog = await discover();
          expect(names([...catalog.workflows, ...(catalog.support ?? [])])).not.toContain(REVIEW);
          expect(catalog.errors.find(error => error.filename === REVIEW)?.error).toContain(
            `The ${source} workflow named '${REVIEW}' is not loaded: that name belongs to an installed plugin.`
          );
          const diagnostic = catalog.errors.find(error => error.workflowName === REVIEW);
          if (!diagnostic) throw new Error('Missing installed caller diagnostic');
          expect(diagnostic).toMatchObject({
            filename: 'acme/review-kit/review/workflow.yaml',
            errorType: 'validation_error',
          });
          expect(diagnostic.error).toContain(`Ambiguous workflow '${requested}'`);
          await expect(
            resolveFanOutChildDefinition({ ...deps, providers: providerRegistry }, project, REVIEW)
          ).resolves.toEqual({ unresolved: diagnostic.error });
        });
      }
    }

    test(`missing qualified ${reference} cannot select an authored alias`, async () => {
      const requested = 'absent/pack:target';
      await install({
        id: ID,
        name: 'review-kit',
        commit: COMMIT_A,
        entrypoints: {
          review: 'review/workflow.yaml',
          ...(field === 'workflow' ? { redirect: 'redirect/workflow.yaml' } : {}),
        },
        files: {
          'review/workflow.yaml': `name: review\ndescription: Caller\nnodes:\n${callerNodes(requested)}`,
          'redirect/workflow.yaml': `name: ${requested}\ndescription: Alias\nnodes:\n  - id: wrong\n    bash: echo wrong\n`,
        },
      });
      const catalog = await discover();
      if (field === 'include') {
        expect(names(catalog.workflows)).not.toContain(REVIEW);
        expect(
          catalog.errors.find(error => workflowLoadErrorName(error) === REVIEW)?.error
        ).toContain(`include target '${requested}' not found`);
      } else {
        expect(catalog.errors.filter(error => workflowLoadErrorName(error) === REVIEW)).toEqual([]);
        expect(
          catalog.workflows.find(entry => entry.workflow.name === REVIEW)?.workflow.nodes[0]
        ).toMatchObject({ workflow: requested });
        await expect(
          resolveFanOutChildDefinition({ ...deps, providers: providerRegistry }, project, requested)
        ).resolves.toEqual({ unresolved: `no workflow named '${requested}' was found` });
      }
    });
  }

  for (const fanOut of [false, true]) {
    for (const failed of [false, true]) {
      test(`qualified cross-pack child keeps its public target (${fanOut ? 'fan-out' : 'plain'}, ${failed ? 'failed' : 'loaded'})`, async () => {
        const target = 'acme/review-kit:review';
        const pack = reviewKit();
        if (failed) pack.files['review/code-review.yaml'] = 'nodes: [invalid';
        await install(pack);
        await install({
          id: 'other/borrower',
          name: 'borrower',
          commit: COMMIT_A,
          entrypoints: { caller: 'caller/workflow.yaml', redirect: 'redirect/workflow.yaml' },
          files: {
            'caller/workflow.yaml': `name: caller
description: Caller
nodes:
  - id: child
    workflow: ${target}
${fanOut ? `    fan_out:\n      items: '["a"]'\n      as: item\n` : ''}`,
            'redirect/workflow.yaml': `name: ${target}
description: Alias
nodes:
  - id: wrong
    bash: echo wrong
`,
          },
        });
        const catalog = await discover();
        expect(
          catalog.errors.filter(error => workflowLoadErrorName(error) === 'other/borrower:caller')
        ).toEqual([]);
        expect(
          catalog.workflows.find(entry => entry.workflow.name === 'other/borrower:caller')?.workflow
            .nodes[0]
        ).toMatchObject({ workflow: target });
        const resolution = resolveFanOutChildDefinition(
          { ...deps, providers: providerRegistry },
          project,
          target
        );
        if (failed) {
          expect(catalog.errors.some(error => workflowLoadErrorName(error) === target)).toBe(true);
          await expect(resolution).resolves.toMatchObject({
            unresolved: expect.stringContaining('YAML'),
          });
        } else {
          await expect(resolution).resolves.toMatchObject({ definition: { name: target } });
        }
      });
    }
  }

  for (const field of ['include', 'workflow'] as const) {
    test(`qualified ${field} keeps a failed manifest entrypoint's identity and diagnostic`, async () => {
      await install({
        id: ID,
        name: 'review-kit',
        commit: COMMIT_A,
        entrypoints: {
          review: 'review/workflow.yaml',
          broken: 'broken/workflow.yaml',
          redirect: 'redirect/workflow.yaml',
        },
        files: {
          'review/workflow.yaml': `name: review
description: Caller
nodes:
  - id: child
    ${field}: acme/review-kit:broken
`,
          'broken/workflow.yaml': 'nodes: [invalid',
          'redirect/workflow.yaml':
            'name: acme/review-kit:broken\ndescription: Alias\nnodes:\n  - id: wrong\n    bash: echo wrong\n',
        },
      });
      const catalog = await discover();
      const targetErrors = catalog.errors.filter(
        error => workflowLoadErrorName(error) === 'acme/review-kit:broken'
      );
      expect(targetErrors).toHaveLength(1);
      expect(targetErrors[0].error).toContain('YAML');
      if (field === 'include') {
        expect(names(catalog.workflows)).not.toContain(REVIEW);
        expect(
          catalog.errors.find(error => workflowLoadErrorName(error) === REVIEW)?.error
        ).toContain(targetErrors[0].error);
      } else {
        expect(
          catalog.workflows.find(entry => entry.workflow.name === REVIEW)?.workflow.nodes[0]
        ).toMatchObject({ workflow: 'acme/review-kit:broken' });
      }
    });
  }

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a pack-root read fault retains the actual cause for every entrypoint',
    async () => {
      const pack = reviewKit();
      pack.entrypoints.helper = 'helper/helper.yaml';
      await install(pack);
      const tree = packTreePath(join(home, 'plugins'), ID, COMMIT_A);
      try {
        await chmod(tree, 0o111);
        const catalog = await discover();
        const packErrors = catalog.errors.filter(error =>
          error.filename.startsWith('acme/review-kit')
        );
        expect(packErrors).toHaveLength(2);
        for (const name of [REVIEW, HELPER]) {
          const errors = packErrors.filter(error => workflowLoadErrorName(error) === name);
          expect(errors).toHaveLength(1);
          expect(errors[0]).toMatchObject({
            filename: 'acme/review-kit',
            errorType: 'read_error',
            cause: { code: 'EACCES' },
          });
          expect(errors[0].error).toContain('Directory read error');
        }
        expect(packErrors[0].cause).toBe(packErrors[1].cause);
      } finally {
        await chmod(tree, 0o755);
      }
    }
  );

  test('installed MCP declarations stay checkout-only despite adjacent and home configs', async () => {
    registerBuiltinProviders();
    await install({
      id: ID,
      name: 'review-kit',
      commit: COMMIT_A,
      entrypoints: { review: 'review/review.yaml' },
      files: {
        'review/review.yaml': `name: review
description: Installed MCP
nodes:
  - id: check
    prompt: Check
    mcp: servers.json
`,
        'review/servers.json': '{"installed":{"command":"example"}}',
      },
    });
    await mkdir(join(home, 'workflows'), { recursive: true });
    await writeFile(join(home, 'workflows', 'servers.json'), '{"home":{"command":"example"}}');
    const catalog = await discover();
    expect(catalog.errors).toEqual([]);
    const entry = catalog.workflows.find(e => e.workflow.name === REVIEW);
    if (!entry) throw new Error('Missing installed workflow');
    expect(entry.source).toBe('installed');
    expect(readHomeMcpDirectory(entry.workflow.nodes[0])).toBeUndefined();
    const issues = (
      await validateWorkflowResources(entry.workflow, project, providerRegistry)
    ).filter(i => i.field === 'mcp');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe(
      `MCP config file not found: 'servers.json'. Tried: ${join(project, 'servers.json')}`
    );
    for (const bundled of catalog.workflows.filter(e => e.source === 'bundled')) {
      for (const node of bundled.workflow.nodes) expect(readHomeMcpDirectory(node)).toBeUndefined();
    }
  });

  test('entrypoints are dispatchable as owner/plugin:entrypoint; support workflows only compose', async () => {
    await install(reviewKit());
    const { workflows, support, errors } = await discover();
    expect(errors.filter(error => error.filename.includes('review-kit'))).toEqual([]);

    const review = workflows.find(entry => entry.workflow.name === REVIEW);
    expect(review?.source).toBe('installed');
    // The support workflow's nodes are inlined through its include.
    expect(review?.workflow.nodes.map(node => node.id)).toEqual([
      'scope',
      'helper__summarize',
      'check',
    ]);
    expect(names(workflows)).not.toContain(HELPER);
    expect(names(workflows)).not.toContain('helper');
    expect(names(workflows)).not.toContain('code-review');
    expect(names(support ?? [])).toEqual([HELPER]);
    // Bundled workflows are still there, as before.
    expect(workflows.find(entry => entry.workflow.name === 'archon-review')?.source).toBe(
      'bundled'
    );
  });

  test('consumer parity: run, routing, validation and resume resolve the same installed workflow', async () => {
    await install(reviewKit());
    const { workflows } = await discover();
    const definitions = workflows.map(entry => entry.workflow);

    // Explicit run (CLI, API, chat, run management, resume) resolves through
    // resolveWorkflowName; chat routing's /invoke-workflow through findWorkflow.
    expect(resolveWorkflowName(REVIEW, definitions)?.name).toBe(REVIEW);
    expect(findWorkflow(REVIEW, definitions)?.name).toBe(REVIEW);
    // Neither a support workflow nor a guess reaches past the entrypoints.
    expect(resolveWorkflowName(HELPER, definitions)).toBeUndefined();
    expect(findWorkflow(HELPER, definitions)).toBeUndefined();

    // Validation resolves the pack's own command and script.
    const review = resolveWorkflowName(REVIEW, definitions) as ResolvedWorkflow;
    const issues = await validateWorkflowResources(review, project, providerRegistry, {
      workflowSource: 'installed',
    });
    expect(issues.filter(issue => issue.level === 'error')).toEqual([]);
    const scope = review.nodes.find(node => node.id === 'scope');
    if (!scope || !isAgentNode(scope) || scope.source.kind !== 'command') {
      throw new Error('scope is a command node');
    }
    const live = await loadCommandPrompt(deps, project, scope.source.name);
    expect(live).toEqual({ success: true, content: 'Scope the change (v1).\n' });
    const scripts = await discoverScriptsForCwd(project);
    expect(
      [...scripts.values()].some(script => script.path.endsWith('review/scripts/check.ts'))
    ).toBe(true);

    // Resume: the run captured its source, then the plugin was removed.
    const capture = await captureWorkflowSource({
      sourceRoot: project,
      captureRoot: join(home, 'runs', 'run-1'),
    });
    await uninstall(ID, COMMIT_A);
    expect(names((await discover()).workflows)).not.toContain(REVIEW);
    const resumed = await resolveContinuationWorkflow(deps, runWith(capture, REVIEW), project);
    expect(resumed?.workflow.name).toBe(REVIEW);
    expect(
      await loadCommandPrompt(deps, project, scope.source.name, undefined, resumed?.roots)
    ).toEqual({ success: true, content: 'Scope the change (v1).\n' });
  });

  test('a run resumes on the bytes it captured after the plugin is updated', async () => {
    await install(reviewKit(COMMIT_A, 'v1'));
    const capture = await captureWorkflowSource({
      sourceRoot: project,
      captureRoot: join(home, 'runs', 'run-1'),
    });
    expect(capture.manifest).toMatchObject({
      version: 2,
      scopes: expect.arrayContaining(['installed']),
      installed_plugins: [{ key: 'acme.review-kit', id: ID, commit: COMMIT_A }],
    });

    await uninstall(ID, COMMIT_A);
    await install(reviewKit(COMMIT_B, 'v2'));
    const live = (await discover()).workflows.find(entry => entry.workflow.name === REVIEW);
    expect(live?.workflow.description).toBe('Review a change (v2)');
    const resumed = await resolveContinuationWorkflow(deps, runWith(capture, REVIEW), project);
    expect(resumed?.workflow.description).toBe('Review a change (v1)');
  });

  test("a workflow: child takes its installed packs from the parent's capture", async () => {
    await install(reviewKit(COMMIT_A, 'v1'));
    const parent = await captureWorkflowSource({
      sourceRoot: project,
      captureRoot: join(home, 'runs', 'parent'),
    });
    await uninstall(ID, COMMIT_A);
    await install(reviewKit(COMMIT_B, 'v2'));

    const installedFrom = await resolveChildInstalledPacks(runWith(parent, REVIEW).metadata);
    const child = await captureWorkflowSource({
      sourceRoot: project,
      captureRoot: join(home, 'runs', 'child'),
      ...(installedFrom ? { installedFrom } : {}),
    });
    expect(child.manifest).toMatchObject({
      version: 2,
      installed_plugins: [{ id: ID, commit: COMMIT_A }],
    });
    const { workflows } = await discoverWorkflowsWithConfig(
      project,
      loadConfig,
      providerRegistry,
      capturedSourceRoots(child.anchor)
    );
    expect(workflows.find(entry => entry.workflow.name === REVIEW)?.workflow.description).toBe(
      'Review a change (v1)'
    );
  });

  test('a capture with no installed pack stays manifest version 1', async () => {
    const capture = await captureWorkflowSource({
      sourceRoot: project,
      captureRoot: join(home, 'runs', 'run-1'),
    });
    expect(capture.manifest.version).toBe(1);
    expect(capture.manifest.scopes).not.toContain('installed');
  });
});

describe('installed pack boundaries', () => {
  test('an incompatible provider receipt is reported without hiding installed workflows', async () => {
    await install(reviewKit());
    const file = receiptPath(join(home, 'plugins'), 'owner/stale-provider');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        id: 'owner/stale-provider',
        manifest: {
          schemaVersion: 1,
          kind: 'provider',
          name: 'stale-provider',
          description: 'test',
          executable: 'archon-provider-claude',
        },
        commit: COMMIT_A,
        installedAt: new Date(0).toISOString(),
        files: [{ path: 'archon-provider-claude', sha256: 'b'.repeat(64) }],
        descriptor: { ...claudeDescriptor, protocol: 1 },
      })
    );
    const { workflows, errors } = await discover();
    expect(names(workflows)).toContain(REVIEW);
    expect(errors.some(error => error.error.includes(file))).toBe(true);
  });

  test('another pack and a project workflow cannot include a support workflow', async () => {
    await install(reviewKit());
    await install({
      id: 'other/repo',
      name: 'borrower',
      commit: COMMIT_A,
      entrypoints: { go: 'go/go.yaml', qualified: 'qualified/qualified.yaml' },
      files: {
        'go/go.yaml': 'name: go\ndescription: d\nnodes:\n  - id: h\n    include: helper\n',
        'qualified/qualified.yaml': `name: qualified\ndescription: d\nnodes:\n  - id: h\n    include: ${HELPER}\n`,
      },
    });
    await writeFile(
      join(project, '.archon', 'workflows', 'reach.yaml'),
      `name: reach\ndescription: d\nnodes:\n  - id: h\n    include: ${HELPER}\n`
    );
    const { workflows, errors } = await discover();
    expect(names(workflows)).not.toContain('other/borrower:go');
    expect(names(workflows)).not.toContain('other/borrower:qualified');
    expect(names(workflows)).not.toContain('reach');
    expect(errors.some(error => error.filename.startsWith('other/borrower/go'))).toBe(true);
    expect(names(workflows)).toContain(REVIEW);
  });

  test('a workflow: child inside a pack may launch an entrypoint but not a support workflow', async () => {
    await install({
      id: 'acme/kids',
      name: 'kids',
      commit: COMMIT_A,
      entrypoints: { parent: 'parent/parent.yaml', launch: 'launch/launch.yaml' },
      files: {
        'parent/parent.yaml':
          'name: parent\ndescription: d\nnodes:\n  - id: run-launch\n    workflow: launch\n',
        'launch/launch.yaml':
          'name: launch\ndescription: d\nnodes:\n  - id: run-helper\n    workflow: helper\n',
        'helper/helper.yaml': 'name: helper\ndescription: d\nnodes:\n  - id: a\n    bash: echo\n',
      },
    });
    const { workflows, errors } = await discover();
    const parent = workflows.find(entry => entry.workflow.name === 'acme/kids:parent');
    expect(parent?.workflow.nodes[0]).toMatchObject({ workflow: 'acme/kids:launch' });
    expect(names(workflows)).not.toContain('acme/kids:launch');
    expect(
      errors.find(error => error.filename === 'acme/kids/launch/launch.yaml')?.error
    ).toContain("support workflow 'helper'");
  });

  test('a composed fan-out body may be a support workflow', async () => {
    await install(reviewKit());
    await expect(resolveFanOutChildDefinition(deps, project, HELPER)).resolves.toMatchObject({
      definition: { name: HELPER },
    });
  });

  test('a qualified name never falls through to a longer name or a copy', async () => {
    await install(reviewKit());
    await writeFile(
      join(project, '.archon', 'workflows', 'copy.yaml'),
      'name: review-kit-review\ndescription: a copy\nnodes:\n  - id: a\n    bash: echo\n'
    );
    await install({
      ...reviewKit(),
      id: 'acme/packs/review-kit-extended',
      name: 'review-kit-extended',
    });
    const definitions = (await discover()).workflows.map(entry => entry.workflow);
    expect(resolveWorkflowName('acme/review-kit:rev', definitions)).toBeUndefined();
    expect(resolveWorkflowName('acme/review:review', definitions)).toBeUndefined();
    expect(resolveWorkflowName('ACME/review-kit:review', definitions)?.name).toBe(REVIEW);
  });

  test('a project workflow cannot shadow an installed name', async () => {
    await install(reviewKit());
    await writeFile(
      join(project, '.archon', 'workflows', 'shadow.yaml'),
      `name: ${REVIEW}\ndescription: shadow\nnodes:\n  - id: a\n    bash: echo\n`
    );
    const { workflows, errors } = await discover();
    const matches = workflows.filter(entry => entry.workflow.name === REVIEW);
    expect(matches.map(entry => entry.source)).toEqual(['installed']);
    expect(errors.find(error => error.filename === REVIEW)?.error).toContain(
      'belongs to an installed plugin'
    );
  });

  test('a manifest naming one file twice is reported, not silently narrowed to one name', async () => {
    await install({
      ...reviewKit(),
      id: 'acme/twice',
      name: 'twice',
      entrypoints: { review: 'review/code-review.yaml', again: 'review/code-review.yaml' },
    });
    const { workflows, errors } = await discover();
    expect(names(workflows).filter(name => name.startsWith('acme/twice:'))).toEqual([]);
    expect(
      errors.some(error => error.error.includes('each entrypoint must name a different workflow'))
    ).toBe(true);
  });

  // A pack installed from a repository root carries that repository's other
  // directories. Neither a dot directory nor one with no YAML can be a workflow folder.
  test('ordinary repository directories in a pack root are not workflow folders', async () => {
    await install({
      ...reviewKit(),
      files: {
        ...reviewKit().files,
        '.github/workflows/ci.yml': 'name: ci\non: push\n',
        'tests/test_x.py': 'def test_x(): pass\n',
        'crowded/one.yaml': 'name: one\ndescription: d\nnodes:\n  - id: a\n    bash: echo\n',
        'crowded/two.yaml': 'name: two\ndescription: d\nnodes:\n  - id: a\n    bash: echo\n',
      },
    });
    const { workflows, errors } = await discover();
    expect(names(workflows)).toContain(REVIEW);
    expect(errors.filter(error => error.filename.startsWith('acme/review-kit/'))).toEqual([
      {
        filename: 'acme/review-kit/crowded',
        error:
          "Packaged workflow 'acme/review-kit/crowded' must contain exactly one .yaml or .yml file (found 2).",
        errorType: 'validation_error',
      },
    ]);
  });

  test('files at a pack root are not workflows, installed or copied into a project', async () => {
    const pack = {
      ...reviewKit(),
      files: {
        ...reviewKit().files,
        'README.md': '# review-kit\n',
        'example.yaml': 'model: sonnet\n',
      },
    };
    // Bundled defaults report their own errors in this isolated process; only the pack's count.
    const packErrors = (errors: readonly { filename: string }[]): unknown[] =>
      errors.filter(error => !error.filename.startsWith('archon-'));
    await install(pack);
    const installed = await discover();
    expect(packErrors(installed.errors)).toEqual([]);
    expect(names(installed.workflows)).toContain(REVIEW);

    // `archon plugin copy`: the installed tree, verbatim, at `.archon/workflows/<name>/`.
    await cp(
      packTreePath(join(home, 'plugins'), pack.id, pack.commit),
      join(project, '.archon', 'workflows', pack.name),
      { recursive: true }
    );
    await uninstall(pack.id, pack.commit);
    const copied = await discover();
    expect(packErrors(copied.errors)).toEqual([]);
    expect(names(copied.workflows)).toEqual(expect.arrayContaining(['code-review', 'helper']));
  });

  test('an unreadable pack is reported without hiding the others', async () => {
    await install(reviewKit());
    await install({ ...reviewKit(), id: 'broken/repo', name: 'broken' });
    await rm(
      join(packTreePath(join(home, 'plugins'), 'broken/repo', COMMIT_A), 'archon-plugin.json')
    );
    const { workflows, errors } = await discover();
    expect(names(workflows)).toContain(REVIEW);
    expect(errors.some(error => error.error.includes('archon-plugin.json'))).toBe(true);
  });
});

/** A run row that recorded `capture` as its source. */
function runWith(
  capture: WorkflowSourceCapture,
  workflowName: string
): { workflow_name: string; metadata: Record<string, unknown> } {
  return {
    workflow_name: workflowName,
    metadata: {
      [WORKFLOW_SOURCE_METADATA_KEY]: {
        version: 1,
        root: capture.anchor.root,
        origin: capture.origin,
        captured_at: capture.manifest.captured_at,
        digest: capture.manifest.digest,
        source_config: capture.manifest.source_config,
        file_count: capture.manifest.file_count,
        byte_count: capture.manifest.byte_count,
      },
    },
  };
}

describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'captured installed pack read ownership',
  () => {
    for (const fault of ['manifest', 'missing-key'] as const) {
      test(`a child capture rejects a parent's ${fault} read failure`, async () => {
        await install(reviewKit());
        const parent = await captureWorkflowSource({
          sourceRoot: project,
          captureRoot: join(home, 'runs/parent'),
        });
        const installedFrom = await resolveChildInstalledPacks(runWith(parent, REVIEW).metadata);
        if (!installedFrom) throw new Error('Parent must own captured packs');
        const pack = join(parent.anchor.root, 'installed/acme.review-kit');
        const manifest = join(pack, 'archon-plugin.json');
        const childRoot = join(home, 'runs/child');
        if (fault === 'manifest') await chmod(manifest, 0o000);
        else await rename(pack, join(parent.anchor.root, 'held-pack'));
        try {
          const outcome = await captureWorkflowSource({
            sourceRoot: project,
            captureRoot: childRoot,
            installedFrom,
          }).then(
            capture => ({ kind: 'capture' as const, capture }),
            (error: unknown) => ({ kind: 'error' as const, error })
          );
          expect(outcome.kind).toBe('error');
          if (outcome.kind === 'error') expect(isSourceReadFailure(outcome.error)).toBe(true);
        } finally {
          if (fault === 'manifest') await chmod(manifest, 0o644);
          else await rename(join(parent.anchor.root, 'held-pack'), pack);
        }
        const child = await captureWorkflowSource({
          sourceRoot: project,
          captureRoot: childRoot,
          installedFrom,
        });
        expect(child.manifest).toMatchObject({
          version: 2,
          installed_plugins: [{ key: 'acme.review-kit', commit: COMMIT_A }],
        });
        const catalog = await discoverWorkflowsWithConfig(
          project,
          loadConfig,
          providerRegistry,
          capturedSourceRoots(child.anchor)
        );
        expect(names(catalog.workflows)).toContain(REVIEW);
      });
    }

    for (const fault of [
      'manifest',
      'workflow-file',
      'workflow-directory',
      'missing-pack',
    ] as const) {
      test(`a persistent unrelated pack ${fault} fault blocks continuation until readable`, async () => {
        await install(reviewKit());
        await install({ ...reviewKit(), id: 'other/repo', name: 'broken' });
        const capture = await captureWorkflowSource({
          sourceRoot: project,
          captureRoot: join(home, 'runs/workflows'),
        });
        const pack = join(capture.anchor.root, 'installed/other.broken');
        const broken =
          fault === 'manifest'
            ? join(pack, 'archon-plugin.json')
            : fault === 'workflow-file'
              ? join(pack, 'review/code-review.yaml')
              : fault === 'workflow-directory'
                ? join(pack, 'review')
                : pack;
        const held = join(home, 'held-pack');
        const failure =
          fault === 'missing-pack'
            ? sourceIntegrity.WorkflowSourceIntegrityError
            : sourceIntegrity.WorkflowSourceUnavailableError;
        try {
          if (fault === 'missing-pack') await rename(pack, held);
          else await chmod(broken, 0o000);
          await expect(
            resolveContinuationWorkflow(deps, runWith(capture, REVIEW), project)
          ).rejects.toBeInstanceOf(failure);
          await expect(
            resolveFanOutChildDefinition(deps, project, REVIEW, capturedSourceRoots(capture.anchor))
          ).rejects.toBeInstanceOf(failure);
        } finally {
          if (fault === 'missing-pack') await rename(held, pack);
          else await chmod(broken, fault === 'workflow-directory' ? 0o755 : 0o644);
        }
        expect(
          (await resolveContinuationWorkflow(deps, runWith(capture, REVIEW), project))?.workflow
            .name
        ).toBe(REVIEW);
        const composed = await resolveFanOutChildDefinition(
          deps,
          project,
          REVIEW,
          capturedSourceRoots(capture.anchor)
        );
        expect('definition' in composed && composed.definition.name).toBe(REVIEW);
      });
    }
  }
);

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';
import {
  buildAnswerArgv,
  buildSnapshotArgv,
  buildWatchArgv,
  fetchAttentionSnapshot,
  parseAnswerResult,
  submitAttentionAnswer,
} from '../plugins/claude-code-attention/hooks/archon-cli.ts';
import {
  applySnapshot,
  applyStreamLine,
  createQueueState,
  declaredChoicesForItem,
  findItemByRefOrRunId,
  getSortedOpenItems,
  nextBackoffMs,
  parseSnapshotJson,
  parseStreamLine,
  splitJsonLines,
  validateAnswerChoice,
} from '../plugins/claude-code-attention/hooks/queue-state.ts';
import { register } from '../plugins/claude-code-attention/hooks/register.ts';

const PLUGIN_ROOT = join(import.meta.dir, '..', 'plugins', 'claude-code-attention');

const PAUSED_RUN_ITEM = {
  kind: 'attention',
  ref: 'run-123:occ-1',
  project: { key: 'archon', codebaseId: 'cb-1', name: 'Archon' },
  item: { id: 'item-1', projectKey: 'archon', key: '#4349', title: 'Claude Code plugin' },
  priority: true,
  revision: 1,
  labels: { stage: 'review' },
  pausedAt: '2026-11-28T10:00:00.000Z',
  run: {
    id: 'run-123',
    workflow: 'archon-review',
    parentRunId: null,
    node: 'decide',
    occurrence: 'occ-1',
    context: {
      artifactsDir: '/tmp/artifacts/run-123',
      transcript: '/tmp/transcripts/run-123.jsonl',
      workingPath: '/tmp/wt/run-123',
      branch: 'feat/test',
    },
  },
  message: 'Proceed with merge after fixing lint?',
  form: 'select' as const,
  options: [
    { id: 'merge', label: 'Merge', does: 'Merge PR now', cost: 'low' },
    { id: 'revise', label: 'Revise', does: 'Open another rework round' },
  ],
  other: true as const,
  recommendation: { option: 'merge', why: 'All checks passed', confidence: 'high' as const },
  context: 'Blocks delivery until decided.',
};

const ASK_ITEM = {
  kind: 'attention',
  ref: 'ask:ask-99',
  project: { key: 'archon', codebaseId: 'cb-1', name: 'Archon' },
  item: { id: 'item-2', projectKey: 'archon', key: '#5441' },
  priority: false,
  revision: 1,
  labels: {},
  pausedAt: '2026-11-28T09:00:00.000Z',
  askedIn: { runId: 'run-999', workflow: 'archon-plan' },
  message: 'Choose target rollout phase',
  form: 'select' as const,
  options: [
    { id: 'now', does: 'Start immediately' },
    { id: 'later', does: 'Defer to next cycle' },
  ],
  other: true as const,
  noRecommendation: 'Product trade-off requires human choice.',
  artifacts: [{ type: 'archon_artifact' as const, run_id: 'run-999', path: 'plan.md' }],
};

describe('claude-code-attention manifest & skill', () => {
  test('plugin manifest, hooks.json, and opt-in skill follow constraints', () => {
    const pluginJson = JSON.parse(
      readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')
    ) as { name: string };
    expect(pluginJson.name).toBe('archon-attention');
    expect(pluginJson.name.startsWith('claude-')).toBe(false);

    expect(existsSync(join(PLUGIN_ROOT, 'archon-plugin.json'))).toBe(false);

    const hooksJson = JSON.parse(
      readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8')
    ) as { modules: string[] };
    expect(hooksJson.modules).toEqual(['./register.ts']);

    const skillText = readFileSync(
      join(PLUGIN_ROOT, 'skills', 'archon-attention-auto', 'SKILL.md'),
      'utf8'
    );
    expect(skillText).toContain('disable-model-invocation: true');
    expect(skillText).toContain('AGENTS.md');
    expect(skillText).toContain('.archon/direction.md');
  });
});

describe('claude-code-attention argv builders & CLI parsing', () => {
  test('builds pure argv arrays without shell and passes --protocol with --after', () => {
    expect(buildSnapshotArgv()).toEqual(['archon', 'workflow', 'attention', '--all', '--json']);
    expect(buildWatchArgv()).toEqual([
      'archon',
      'workflow',
      'attention',
      '--all',
      '--watch',
      '--protocol',
      '--json',
    ]);
    expect(buildWatchArgv('sql:42')).toEqual([
      'archon',
      'workflow',
      'attention',
      '--all',
      '--watch',
      '--protocol',
      '--json',
      '--after',
      'sql:42',
    ]);
  });

  test('uses respond for run-held items and answer --ref for completed-run asks', () => {
    expect(buildAnswerArgv(PAUSED_RUN_ITEM, 'merge', 'ship it')).toEqual([
      'archon',
      'workflow',
      'respond',
      'run-123',
      'merge',
      '--occurrence',
      'occ-1',
      '--text',
      'ship it',
      '--json',
    ]);
    expect(buildAnswerArgv(ASK_ITEM, 'now', 'approved by doc')).toEqual([
      'archon',
      'workflow',
      'answer',
      '--ref',
      'ask:ask-99',
      '--choose',
      'now',
      '--text',
      'approved by doc',
      '--json',
    ]);
  });

  test('validates declared choices and requires text for other', () => {
    expect(validateAnswerChoice(PAUSED_RUN_ITEM, 'merge')).toEqual({ ok: true });
    expect(validateAnswerChoice(PAUSED_RUN_ITEM, 'bogus').ok).toBe(false);
    expect(validateAnswerChoice(PAUSED_RUN_ITEM, 'other', '').ok).toBe(false);
    expect(validateAnswerChoice(PAUSED_RUN_ITEM, 'other', 'custom ruling')).toEqual({ ok: true });

    const gateItem = {
      kind: 'awaiting_response',
      ref: 'run-g:occ-g',
      project: null,
      run: { id: 'run-g', workflow: 'deploy', occurrence: 'occ-g' },
      message: 'Deploy to prod?',
    };
    expect(declaredChoicesForItem(gateItem).map(o => o.id)).toEqual(['approve', 'reject']);
    expect(validateAnswerChoice(gateItem, 'approve')).toEqual({ ok: true });
    expect(validateAnswerChoice(gateItem, 'merge').ok).toBe(false);
  });

  test('parses snapshot and answer CLI outputs cleanly', () => {
    const snap = parseSnapshotJson(
      JSON.stringify({ ok: true, items: [PAUSED_RUN_ITEM], degraded: [] })
    );
    expect(snap.ok).toBe(true);
    expect(snap.items?.length).toBe(1);

    const okAns = parseAnswerResult('run-123:occ-1', 'merge', {
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, action: 'respond' }),
      stderr: '',
    });
    expect(okAns.ok).toBe(true);

    const errAns = parseAnswerResult('ask:ask-99', 'now', {
      exitCode: 1,
      stdout: JSON.stringify({ ok: false, error: 'already_answered', message: 'Already closed' }),
      stderr: '',
    });
    expect(errAns.ok).toBe(false);
    expect(errAns.message).toBe('Already closed');
  });
});

describe('claude-code-attention stream state & cursor tracking', () => {
  test('tracks snapshot, incremental JSONL stream, resolved removal, and cursor_invalid reset', () => {
    const state = createQueueState();
    applySnapshot(state, { ok: true, items: [PAUSED_RUN_ITEM] });
    expect(state.items.size).toBe(1);

    const chunk1 = `${JSON.stringify({ type: 'ready', cursor: 'sql:10' })}\n${JSON.stringify({
      type: 'attention',
      cursor: 'sql:11',
      snapshot: false,
      item: ASK_ITEM,
    })}\n{"type":"resol`;
    const split1 = splitJsonLines('', chunk1);
    expect(split1.lines.length).toBe(2);
    for (const raw of split1.lines) {
      const line = parseStreamLine(raw);
      if (line) applyStreamLine(state, line);
    }
    expect(state.connected).toBe(true);
    expect(state.committedCursor).toBe('sql:10');
    expect(state.items.size).toBe(2);
    expect(getSortedOpenItems(state)[0]?.ref).toBe('run-123:occ-1');

    const chunk2 = `ved","cursor":"sql:12","ref":"run-123:occ-1","reason":"answered"}\n${JSON.stringify(
      {
        type: 'degraded',
        cursor: 'sql:12',
        reason: 'run_unreadable',
      }
    )}\n`;
    const split2 = splitJsonLines(split1.remainder, chunk2);
    expect(split2.lines.length).toBe(2);
    for (const raw of split2.lines) {
      const line = parseStreamLine(raw);
      if (line) applyStreamLine(state, line);
    }
    expect(state.items.has('run-123:occ-1')).toBe(false);
    expect(state.committedCursor).toBe('sql:11');
    expect(state.degradedReason).toBe('run_unreadable');

    const inv = applyStreamLine(state, { type: 'error', error: 'cursor_invalid' });
    expect(inv.cursorInvalid).toBe(true);
    expect(state.committedCursor).toBeUndefined();
    expect(nextBackoffMs(0)).toBe(1000);
    expect(nextBackoffMs(2)).toBe(4000);
    expect(nextBackoffMs(20)).toBe(30_000);
  });

  test('fetchAttentionSnapshot and submitAttentionAnswer handle CLI runs', async () => {
    const recordedArgvs: string[][] = [];
    const mockMod = {
      process: {
        async run(argv: string[]) {
          recordedArgvs.push(argv);
          if (argv.includes('attention')) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ ok: true, items: [ASK_ITEM] }),
              stderr: '',
            };
          }
          return { exitCode: 0, stdout: JSON.stringify({ ok: true, settled: true }), stderr: '' };
        },
      },
    };
    const snap = await fetchAttentionSnapshot(mockMod);
    expect(snap.ok).toBe(true);
    expect(
      findItemByRefOrRunId(
        { ...createQueueState(), items: new Map([[ASK_ITEM.ref, ASK_ITEM]]) },
        undefined,
        'run-999'
      )?.ref
    ).toBe('ask:ask-99');

    const rejected = await submitAttentionAnswer(mockMod, ASK_ITEM, 'undeclared');
    expect(rejected.ok).toBe(false);
    expect(recordedArgvs.length).toBe(1); // CLI was NOT called

    const ok = await submitAttentionAnswer(mockMod, ASK_ITEM, 'now', 'policy allows');
    expect(ok.ok).toBe(true);
    expect(recordedArgvs[1]).toEqual([
      'archon',
      'workflow',
      'answer',
      '--ref',
      'ask:ask-99',
      '--choose',
      'now',
      '--text',
      'policy allows',
      '--json',
    ]);
  });
});

interface RecordedHook {
  event: string;
  matcher?: Record<string, unknown>;
  fn: (...args: never[]) => unknown;
}

interface RenderedNode {
  type: string;
  props?: {
    key?: string;
    children?: unknown[];
    onPress?: () => unknown;
  };
}

function findElement(node: unknown, pred: (n: RenderedNode) => boolean): RenderedNode | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const candidate = node as RenderedNode;
  if (pred(candidate)) return candidate;
  const children = candidate.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const hit = findElement(child, pred);
      if (hit) return hit;
    }
  }
  return undefined;
}

describe('claude-code-attention mod register(on) integration', () => {
  test('registers command/tool, renders pane with confirm, answers end-to-end, and validates answer_attention tool', async () => {
    const handlers: RecordedHook[] = [];
    register((event: string, matcherOrFn: unknown, maybeFn?: (...args: never[]) => unknown) => {
      if (typeof matcherOrFn === 'function') {
        handlers.push({ event, fn: matcherOrFn as (...args: never[]) => unknown });
      } else if (maybeFn) {
        handlers.push({
          event,
          matcher: matcherOrFn as Record<string, unknown>,
          fn: maybeFn,
        });
      }
    });

    const registeredCommands: unknown[] = [];
    const registeredTools: unknown[] = [];
    const executedArgvs: string[][] = [];
    const toasts: string[] = [];
    let openedPane: unknown = null;
    let invalidations = 0;
    let pushStreamChunk!: (chunk: string) => void;
    let finishStream!: () => void;

    const streamDone = new Promise<void>(resolve => {
      finishStream = resolve;
    });

    const $ = {
      command: {
        register: async (def: unknown) => {
          registeredCommands.push(def);
        },
      },
      tool: {
        register: async (def: unknown) => {
          registeredTools.push(def);
        },
      },
      process: {
        run: async (argv: string[]) => {
          executedArgvs.push(argv);
          if (argv.includes('attention')) {
            return {
              exitCode: 0,
              stdout: JSON.stringify({ ok: true, items: [PAUSED_RUN_ITEM] }),
              stderr: '',
            };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({ ok: true, action: 'respond' }),
            stderr: '',
          };
        },
        spawn: () => ({
          async *[Symbol.asyncIterator]() {
            yield `${JSON.stringify({ type: 'ready', cursor: 'sql:1' })}\n`;
            await new Promise<void>(resolve => {
              pushStreamChunk = (chunk: string) => {
                void chunk;
                resolve();
              };
            });
            yield `${JSON.stringify({ type: 'resolved', cursor: 'sql:2', ref: ASK_ITEM.ref, reason: 'answered' })}\n`;
            await streamDone;
          },
        }),
      },
      clock: {
        after: () => ({ cancel: () => undefined }),
      },
      ui: {
        open: async (opts: unknown) => {
          openedPane = opts;
          return { isPlaced: true };
        },
        invalidate: () => {
          invalidations += 1;
        },
        toast: (msg: string) => {
          toasts.push(msg);
        },
        resolve: () => ({
          Box: (props: Record<string, unknown>) => ({ type: 'Box', props }),
          Text: (props: Record<string, unknown>) => ({ type: 'Text', props }),
          Button: (props: Record<string, unknown>) => ({ type: 'Button', props }),
          Input: (props: Record<string, unknown>) => ({ type: 'Input', props }),
        }),
      },
    };

    const startHook = handlers.find(h => h.event === 'session.start');
    expect(startHook).toBeDefined();
    await startHook!.fn($, { surface: 'terminal' }, async (e: unknown) => e);
    expect(registeredCommands.length).toBe(1);
    expect(registeredTools.length).toBe(1);

    const cmdHook = handlers.find(
      h => h.event === 'command.run' && h.matcher?.command === 'archon-attention'
    );
    await cmdHook!.fn($, { args: '' }, async (e: unknown) => e);
    expect(openedPane).toEqual({
      id: 'archon-attention',
      title: 'Archon Attention',
      focus: true,
      closeOnEscape: true,
    });

    const renderHook = handlers.find(
      h => h.event === 'ui.render' && h.matcher?.component === 'Pane'
    );
    const invokeHook = (hook: RecordedHook | undefined, ...args: unknown[]): Promise<unknown> =>
      Promise.resolve((hook?.fn as (...a: unknown[]) => unknown)(...args));

    const tree1 = await invokeHook(
      renderHook,
      $,
      { requestId: 'archon-attention' },
      async (e: unknown) => e
    );

    // Click 'merge' -> shows confirmation step instead of immediately calling CLI
    const mergeBtn = findElement(
      tree1,
      n => n.type === 'Button' && n.props?.key === 'choose-run-123:occ-1-merge'
    );
    expect(mergeBtn).toBeDefined();
    mergeBtn?.props?.onPress?.();
    expect(executedArgvs.filter(a => a.includes('respond')).length).toBe(0);

    const tree2 = await invokeHook(
      renderHook,
      $,
      { requestId: 'archon-attention' },
      async (e: unknown) => e
    );
    const confirmBtn = findElement(
      tree2,
      n => n.type === 'Button' && n.props?.key === 'confirm-run-123:occ-1-merge'
    );
    expect(confirmBtn).toBeDefined();
    await confirmBtn?.props?.onPress?.();
    expect(executedArgvs.some(a => a.includes('respond') && a.includes('merge'))).toBe(true);
    expect(toasts.some(t => t.includes('merge'))).toBe(true);
    expect(invalidations).toBeGreaterThan(0);

    // Tool call validation: undeclared choice must be refused without calling CLI
    const toolHook = handlers.find(
      h => h.event === 'tool.call' && h.matcher?.tool === 'mcp__archon-attention__answer_attention'
    );
    expect(toolHook).toBeDefined();
    // Refresh snapshot with ASK_ITEM via mock
    executedArgvs.length = 0;
    const prevRun = $.process.run;
    $.process.run = async (argv: string[]) => {
      executedArgvs.push(argv);
      if (argv.includes('attention')) {
        return { exitCode: 0, stdout: JSON.stringify({ ok: true, items: [ASK_ITEM] }), stderr: '' };
      }
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, settled: true }), stderr: '' };
    };

    const refusedRaw = (await invokeHook(toolHook, $, {
      ref: 'ask:ask-99',
      choice: 'nonexistent',
    })) as { result: string };
    const refusedRes = JSON.parse(refusedRaw.result) as { ok: boolean; error: string };
    expect(refusedRes.ok).toBe(false);
    expect(refusedRes.error).toContain('not declared');
    expect(executedArgvs.filter(a => a.includes('answer')).length).toBe(0);

    const validRaw = (await invokeHook(toolHook, $, {
      ref: 'ask:ask-99',
      choice: 'now',
      text: 'justified',
    })) as { result: string };
    const validRes = JSON.parse(validRaw.result) as { ok: boolean };
    expect(validRes.ok).toBe(true);
    expect(
      executedArgvs.some(
        a => a.includes('answer') && a.includes('--ref') && a.includes('ask:ask-99')
      )
    ).toBe(true);

    $.process.run = prevRun;
    pushStreamChunk('');
    finishStream();
    const endHook = handlers.find(h => h.event === 'session.end');
    await invokeHook(endHook, $, {}, async (e: unknown) => e);
  });
});

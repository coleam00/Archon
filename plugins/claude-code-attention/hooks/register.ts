import { buildWatchArgv, fetchAttentionSnapshot, submitAttentionAnswer } from './archon-cli';
import {
  type AttentionQueueItem,
  applySnapshot,
  applyStreamLine,
  createQueueState,
  declaredChoicesForItem,
  findItemByRefOrRunId,
  getSortedOpenItems,
  isAnswerableItem,
  nextBackoffMs,
  parseStreamLine,
  splitJsonLines,
  validateAnswerChoice,
} from './queue-state';

const PANE_ID = 'archon-attention';
const COMMAND_NAME = 'archon-attention';
const TOOL_NAME = 'answer_attention';
const FULL_TOOL_NAME = 'mcp__archon-attention__answer_attention';

interface PendingConfirmation {
  ref: string;
  choice: string;
}

interface UiElements {
  Box: (props: Record<string, unknown>) => unknown;
  Text: (props: Record<string, unknown>) => unknown;
  Button: (props: Record<string, unknown>) => unknown;
  Input: (props: Record<string, unknown>) => unknown;
}

const state = createQueueState();
const rulingDrafts = new Map<string, string>();
let pendingConfirm: PendingConfirmation | null = null;
let statusNotice: string | null = null;
let watchGeneration = 0;
let reconnectTimer: { cancel(): void } | null = null;

function formatPlainSummary(): string {
  const items = getSortedOpenItems(state);
  if (items.length === 0) {
    return 'No open Archon attention items.';
  }
  const lines = [`Open Archon attention items (${items.length}):`];
  for (const item of items) {
    const label = item.item?.key ?? item.run?.workflow ?? item.askedIn?.workflow ?? item.ref;
    const summary = item.message ?? item.summary ?? item.detail ?? item.kind;
    const rec = item.recommendation ? ` [rec: ${item.recommendation.option}]` : '';
    lines.push(`- ${label} (${item.ref}): ${summary}${rec}`);
  }
  return lines.join('\n');
}

function collectEvidencePaths(item: AttentionQueueItem): string[] {
  const paths: string[] = [];
  if (item.run?.context?.branch) {
    paths.push(`branch: ${item.run.context.branch}`);
  }
  if (item.run?.context?.transcript) {
    paths.push(`transcript: ${item.run.context.transcript}`);
  }
  if (item.run?.context?.artifactsDir) {
    paths.push(`artifacts: ${item.run.context.artifactsDir}`);
  }
  for (const art of item.artifacts ?? []) {
    paths.push(`artifact: ${art.path} (${art.run_id})`);
  }
  return paths;
}

function stopWatchLoop(): void {
  watchGeneration += 1;
  if (reconnectTimer !== null) {
    reconnectTimer.cancel();
    reconnectTimer = null;
  }
}

function extractChunkText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk === null || typeof chunk !== 'object') return '';
  const record = chunk as { stdout?: unknown; data?: unknown };
  if (typeof record.stdout === 'string') return record.stdout;
  if (typeof record.data === 'string') return record.data;
  return '';
}

function processWatchChunk(
  buffer: string,
  text: string
): { remainder: string; sawCursorInvalid: boolean; shouldRedraw: boolean } {
  const split = splitJsonLines(buffer, text);
  let sawCursorInvalid = false;
  let shouldRedraw = false;
  for (const rawLine of split.lines) {
    const parsed = parseStreamLine(rawLine);
    if (!parsed) continue;
    const outcome = applyStreamLine(state, parsed);
    if (outcome.cursorInvalid) sawCursorInvalid = true;
    if (outcome.changed) shouldRedraw = true;
  }
  return { remainder: split.remainder, sawCursorInvalid, shouldRedraw };
}

function scheduleWatchReconnect(
  $: any,
  generation: number,
  attempt: number,
  sawCursorInvalid: boolean
): void {
  const nextAttempt = sawCursorInvalid ? 0 : attempt + 1;
  const delayMs = sawCursorInvalid ? 250 : nextBackoffMs(attempt);
  reconnectTimer = $.clock.after(delayMs, () => {
    reconnectTimer = null;
    if (generation !== watchGeneration) return;
    void refreshSnapshotAndWatch($, generation, nextAttempt);
  });
}

async function consumeWatchStream($: any, generation: number): Promise<boolean> {
  const argv = buildWatchArgv(state.committedCursor);
  let buffer = '';
  let sawCursorInvalid = false;
  const stream = $.process.spawn(argv);
  for await (const chunk of stream) {
    if (generation !== watchGeneration) return sawCursorInvalid;
    const text = extractChunkText(chunk);
    if (text.length === 0) continue;
    const processed = processWatchChunk(buffer, text);
    buffer = processed.remainder;
    if (processed.sawCursorInvalid) sawCursorInvalid = true;
    if (processed.shouldRedraw) $.ui.invalidate('ui.render');
  }
  return sawCursorInvalid;
}

async function runWatchConnection($: any, generation: number, attempt: number): Promise<void> {
  if (generation !== watchGeneration) return;
  let sawCursorInvalid = false;
  try {
    sawCursorInvalid = await consumeWatchStream($, generation);
  } catch (error) {
    if (generation !== watchGeneration) return;
    state.lastError = error instanceof Error ? error.message : String(error);
  }
  if (generation !== watchGeneration) return;
  state.connected = false;
  $.ui.invalidate('ui.render');
  scheduleWatchReconnect($, generation, attempt, sawCursorInvalid);
}

async function refreshSnapshotAndWatch($: any, generation: number, attempt: number): Promise<void> {
  if (generation !== watchGeneration) return;
  const snapshot = await fetchAttentionSnapshot($);
  if (generation !== watchGeneration) return;
  applySnapshot(state, snapshot);
  $.ui.invalidate('ui.render');
  await runWatchConnection($, generation, attempt);
}

async function refreshSnapshotOnly($: any): Promise<void> {
  const snapshot = await fetchAttentionSnapshot($);
  applySnapshot(state, snapshot);
  $.ui.invalidate('ui.render');
}

async function performConfirmedAnswer(
  $: any,
  item: AttentionQueueItem,
  choice: string
): Promise<void> {
  const draft = rulingDrafts.get(item.ref) ?? '';
  const result = await submitAttentionAnswer($, item, choice, draft);
  pendingConfirm = null;
  statusNotice = result.message;
  if (result.ok) {
    rulingDrafts.delete(item.ref);
    state.items.delete(item.ref);
    $.ui.toast(result.message);
  } else {
    state.lastError = result.message;
    $.ui.toast(`Refused: ${result.message}`);
  }
  $.ui.invalidate('ui.render');
}

function renderCardDetails(ui: UiElements, item: AttentionQueueItem): unknown[] {
  const { Text } = ui;
  const lines: unknown[] = [];
  const headerParts = [
    item.project?.name ?? 'unscoped',
    item.item?.key ?? item.run?.workflow ?? item.askedIn?.workflow ?? item.kind,
    item.ref,
  ];
  lines.push(Text({ bold: true, children: [headerParts.join(' · ')] }));
  if (item.item?.title) lines.push(Text({ children: [item.item.title] }));
  if (item.message) lines.push(Text({ children: [item.message] }));
  if (item.context) {
    lines.push(Text({ dimColor: true, children: [`Why it matters: ${item.context}`] }));
  }
  if (item.recommendation) {
    const conf = item.recommendation.confidence ? ` (${item.recommendation.confidence})` : '';
    lines.push(
      Text({
        color: 'cyan',
        children: [
          `Recommended: ${item.recommendation.option}${conf} — ${item.recommendation.why}`,
        ],
      })
    );
  } else if (item.noRecommendation) {
    lines.push(Text({ dimColor: true, children: [`No recommendation: ${item.noRecommendation}`] }));
  }
  if (item.deadline) {
    lines.push(Text({ color: 'yellow', children: [`Overdue since: ${item.deadline}`] }));
  }
  if (item.summary) lines.push(Text({ dimColor: true, children: [item.summary] }));
  for (const pathLine of collectEvidencePaths(item)) {
    lines.push(Text({ dimColor: true, children: [pathLine] }));
  }
  return lines;
}

function renderConfirmationRow(
  $: any,
  ui: UiElements,
  item: AttentionQueueItem,
  chosenId: string
): unknown {
  const { Box, Text, Button } = ui;
  return Box({
    flexDirection: 'row',
    columnGap: 1,
    children: [
      Text({ color: 'yellow', children: [`Confirm '${chosenId}' on ${item.ref}?`] }),
      Button({
        key: `confirm-${item.ref}-${chosenId}`,
        label: `Confirm ${chosenId}`,
        variant: 'primary',
        onPress: async () => {
          await performConfirmedAnswer($, item, chosenId);
        },
      }),
      Button({
        key: `cancel-${item.ref}`,
        label: 'Cancel',
        variant: 'secondary',
        onPress: () => {
          pendingConfirm = null;
          $.ui.invalidate('ui.render');
        },
      }),
    ],
  });
}

function renderChoiceControls($: any, ui: UiElements, item: AttentionQueueItem): unknown[] {
  const { Box, Text, Button, Input } = ui;
  if (!isAnswerableItem(item)) {
    return [Text({ dimColor: true, children: [`Kind: ${item.kind} (inspect in CLI/console)`] })];
  }
  const controls: unknown[] = [];
  const choices = declaredChoicesForItem(item);
  for (const opt of choices) {
    const detailParts = [opt.id];
    if (opt.label && opt.label !== opt.id) detailParts.push(`(${opt.label})`);
    if (opt.does) detailParts.push(`— ${opt.does}`);
    if (opt.cost) detailParts.push(`[cost: ${opt.cost}]`);
    controls.push(Text({ dimColor: true, children: [`• ${detailParts.join(' ')}`] }));
  }
  controls.push(
    Input({
      key: `ruling-${item.ref}`,
      label: 'Ruling note',
      placeholder: 'Optional ruling text (required for other)',
      value: rulingDrafts.get(item.ref) ?? '',
      submitLabel: 'save note',
      onInput: (value: string) => {
        rulingDrafts.set(item.ref, value);
      },
      onSubmit: (value: string) => {
        rulingDrafts.set(item.ref, value);
        $.ui.invalidate('ui.render');
      },
    })
  );
  if (pendingConfirm !== null && pendingConfirm.ref === item.ref) {
    controls.push(renderConfirmationRow($, ui, item, pendingConfirm.choice));
  } else {
    controls.push(
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: choices.map(opt =>
          Button({
            key: `choose-${item.ref}-${opt.id}`,
            label: opt.label ?? opt.id,
            variant: item.recommendation?.option === opt.id ? 'primary' : 'secondary',
            onPress: () => {
              const check = validateAnswerChoice(item, opt.id, rulingDrafts.get(item.ref) ?? '');
              if (!check.ok) {
                state.lastError = check.error ?? 'Invalid choice';
                $.ui.invalidate('ui.render');
                return;
              }
              state.lastError = null;
              pendingConfirm = { ref: item.ref, choice: opt.id };
              $.ui.invalidate('ui.render');
            },
          })
        ),
      })
    );
  }
  return controls;
}

function renderPaneBody($: any, ui: UiElements): unknown {
  const { Box, Text, Button } = ui;
  const items = getSortedOpenItems(state);
  const children: unknown[] = [
    Box({
      flexDirection: 'row',
      columnGap: 2,
      children: [
        Text({ bold: true, children: [`Archon Attention (${items.length})`] }),
        Text({ dimColor: true, children: [state.connected ? 'live' : 'reconnecting'] }),
        Button({
          key: 'refresh-queue',
          label: 'Refresh',
          hotkey: 'r',
          plain: true,
          onPress: async () => {
            await refreshSnapshotOnly($);
          },
        }),
      ],
    }),
  ];
  if (state.degradedReason) {
    children.push(Text({ color: 'yellow', children: [`Degraded: ${state.degradedReason}`] }));
  }
  if (state.lastError) {
    children.push(Text({ color: 'red', children: [`Error: ${state.lastError}`] }));
  }
  if (statusNotice) {
    children.push(Text({ color: 'green', children: [statusNotice] }));
  }
  if (items.length === 0) {
    children.push(Text({ dimColor: true, children: ['No items waiting on attention.'] }));
    return Box({ flexDirection: 'column', gap: 1, children });
  }
  for (const item of items) {
    children.push(
      Box({
        key: `card-${item.ref}`,
        flexDirection: 'column',
        borderStyle: 'round',
        paddingX: 1,
        children: [...renderCardDetails(ui, item), ...renderChoiceControls($, ui, item)],
      })
    );
  }
  return Box({ flexDirection: 'column', gap: 1, children });
}

export function register(on: any): void {
  on('session.start', async ($: any, e: any, next: any) => {
    await $.command.register({
      name: COMMAND_NAME,
      description: 'Open the live Archon attention queue pane',
      immediate: true,
    });
    await $.tool.register({
      name: TOOL_NAME,
      description:
        'Answer an open Archon attention item after validating that the choice is declared by the item. Provide ref or run_id, choice, and optional ruling text.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description: 'Opaque attention item ref (e.g. ask:... or <runId>:<occ>)',
          },
          run_id: { type: 'string', description: 'Workflow run ID holding the attention item' },
          choice: {
            type: 'string',
            description: 'Declared option id (or approve/reject for a gate)',
          },
          text: {
            type: 'string',
            description: 'Optional ruling text (required when choice is other)',
          },
        },
        required: ['choice'],
      },
    });

    stopWatchLoop();
    const generation = watchGeneration;
    const snapshot = await fetchAttentionSnapshot($);
    applySnapshot(state, snapshot);
    void runWatchConnection($, generation, 0);
    return next(e);
  });

  on('session.end', async (_$: any, e: any, next: any) => {
    stopWatchLoop();
    return next(e);
  });

  on('command.run', { command: COMMAND_NAME }, async ($: any) => {
    await refreshSnapshotOnly($);
    const opened = await $.ui.open({
      id: PANE_ID,
      title: 'Archon Attention',
      focus: true,
      closeOnEscape: true,
    });
    if (!opened?.isPlaced) {
      return { text: formatPlainSummary(), isTextDisplayOnly: true };
    }
    return {};
  });

  on('tool.call', { tool: FULL_TOOL_NAME }, async ($: any, e: any) => {
    const ref = typeof e.ref === 'string' ? e.ref.trim() : undefined;
    const runId = typeof e.run_id === 'string' ? e.run_id.trim() : undefined;
    const choice = typeof e.choice === 'string' ? e.choice : '';
    const text = typeof e.text === 'string' ? e.text : undefined;

    if (!ref && !runId) {
      return {
        result: JSON.stringify({
          ok: false,
          error: 'Either ref or run_id must be provided to answer_attention.',
        }),
      };
    }

    let item = findItemByRefOrRunId(state, ref, runId);
    if (!item) {
      await refreshSnapshotOnly($);
      item = findItemByRefOrRunId(state, ref, runId);
    }
    if (!item) {
      return {
        result: JSON.stringify({
          ok: false,
          error: `No open attention item matched ${ref ?? runId}.`,
        }),
      };
    }

    const validation = validateAnswerChoice(item, choice, text);
    if (!validation.ok) {
      return {
        result: JSON.stringify({
          ok: false,
          ref: item.ref,
          error: validation.error,
        }),
      };
    }

    const answerResult = await submitAttentionAnswer($, item, choice, text);
    if (answerResult.ok) {
      state.items.delete(item.ref);
      $.ui.invalidate('ui.render');
    }
    return { result: JSON.stringify(answerResult) };
  });

  on('ui.render', { component: 'Pane' }, async ($: any, e: any, next: any) => {
    if (e.requestId !== PANE_ID) return next(e);
    const ui = $.ui.resolve(e) as UiElements;
    return renderPaneBody($, ui);
  });
}

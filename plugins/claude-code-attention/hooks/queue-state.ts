export interface AttentionOption {
  id: string;
  label?: string;
  does?: string;
  cost?: string;
  requiresText?: boolean;
}

export interface AttentionRecommendation {
  option: string;
  why: string;
  confidence?: 'low' | 'medium' | 'high';
}

export interface AttentionArtifactRef {
  type: 'archon_artifact';
  run_id: string;
  path: string;
}

export interface AttentionRunContext {
  artifactsDir?: string | null;
  transcript?: string | null;
  workingPath?: string | null;
  branch?: string | null;
}

export interface AttentionRunInfo {
  id: string;
  workflow: string;
  parentRunId?: string | null;
  node?: string;
  occurrence?: string;
  context?: AttentionRunContext;
}

export interface AttentionQueueItem {
  kind: string;
  ref: string;
  project: { key: string; codebaseId?: string | null; name: string } | null;
  item?: { id: string; projectKey: string; key: string; title?: string | null };
  priority?: boolean;
  revision?: number;
  labels?: Record<string, string>;
  pausedAt?: string | null;
  run?: AttentionRunInfo;
  askedIn?: { runId: string; workflow: string };
  message?: string;
  form?: 'message' | 'approval' | 'select' | 'multi_select';
  options?: AttentionOption[];
  other?: true;
  recommendation?: AttentionRecommendation;
  noRecommendation?: string;
  context?: string;
  artifacts?: AttentionArtifactRef[];
  summary?: string | null;
  deadline?: string;
  resetAt?: string;
  detail?: string;
}

export interface AttentionSnapshotResponse {
  ok: boolean;
  items?: AttentionQueueItem[];
  degraded?: Array<{ type: string; reason: string; runId?: string }>;
  error?: string;
}

export interface AttentionStreamLine {
  type: string;
  cursor?: string;
  snapshot?: boolean;
  item?: AttentionQueueItem;
  ref?: string;
  reason?: string;
  error?: string;
  needs?: 'answer' | 'look' | 'nothing';
}

export interface ChoiceValidationResult {
  ok: boolean;
  error?: string;
}

export interface QueueState {
  items: Map<string, AttentionQueueItem>;
  committedCursor: string | undefined;
  pendingCursor: string | undefined;
  connected: boolean;
  degradedReason: string | null;
  lastError: string | null;
}

export function createQueueState(): QueueState {
  return {
    items: new Map(),
    committedCursor: undefined,
    pendingCursor: undefined,
    connected: false,
    degradedReason: null,
    lastError: null,
  };
}

export function isAnswerableItem(item: AttentionQueueItem): boolean {
  return item.kind === 'attention' || item.kind === 'awaiting_response';
}

export function declaredChoicesForItem(item: AttentionQueueItem): AttentionOption[] {
  if (item.kind === 'awaiting_response') {
    return [
      { id: 'approve', label: 'Approve', does: 'Approve and resume the paused workflow gate.' },
      { id: 'reject', label: 'Reject', does: 'Reject the paused workflow gate.' },
    ];
  }
  const declared = Array.isArray(item.options) ? [...item.options] : [];
  if (item.other === true && !declared.some(opt => opt.id === 'other')) {
    declared.push({
      id: 'other',
      label: 'Other',
      does: 'None of these. Provide ruling text explaining what to do instead.',
      requiresText: true,
    });
  }
  return declared;
}

export function validateAnswerChoice(
  item: AttentionQueueItem,
  choice: string,
  text?: string
): ChoiceValidationResult {
  if (!isAnswerableItem(item)) {
    return {
      ok: false,
      error: `Item '${item.ref}' (kind '${item.kind}') does not accept an answer.`,
    };
  }
  const trimmedChoice = choice.trim();
  if (trimmedChoice.length === 0) {
    return { ok: false, error: 'A non-empty choice is required.' };
  }
  const trimmedText = (text ?? '').trim();
  if (item.kind === 'attention' && item.form === 'message') {
    if (trimmedText.length === 0) {
      return { ok: false, error: `Item '${item.ref}' requires non-empty ruling text.` };
    }
    return { ok: true };
  }
  const declared = declaredChoicesForItem(item);
  const matched = declared.find(opt => opt.id === trimmedChoice);
  if (!matched) {
    const allowed = declared.map(opt => opt.id).join(', ');
    return {
      ok: false,
      error: `Choice '${trimmedChoice}' is not declared for '${item.ref}'. Allowed choices: ${allowed || '(none)'}.`,
    };
  }
  if ((trimmedChoice === 'other' || matched.requiresText === true) && trimmedText.length === 0) {
    return {
      ok: false,
      error: `Choice '${trimmedChoice}' on '${item.ref}' requires non-empty ruling text.`,
    };
  }
  return { ok: true };
}

export function parseSnapshotJson(stdout: string): AttentionSnapshotResponse {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Empty response from archon workflow attention' };
  }
  try {
    const parsed = JSON.parse(trimmed) as AttentionSnapshotResponse;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.ok !== 'boolean') {
      return { ok: false, error: 'Unexpected JSON shape from archon workflow attention' };
    }
    return parsed;
  } catch (error) {
    return {
      ok: false,
      error: `Failed to parse snapshot JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function applySnapshot(state: QueueState, snapshot: AttentionSnapshotResponse): void {
  if (!snapshot.ok) {
    state.lastError = snapshot.error ?? 'Failed to load attention snapshot';
    return;
  }
  state.items.clear();
  for (const item of snapshot.items ?? []) {
    if (item && typeof item.ref === 'string') {
      state.items.set(item.ref, item);
    }
  }
  state.degradedReason =
    snapshot.degraded && snapshot.degraded.length > 0
      ? snapshot.degraded.map(d => d.reason).join(', ')
      : null;
  state.lastError = null;
}

export function splitJsonLines(
  buffer: string,
  chunk: string
): { lines: string[]; remainder: string } {
  const combined = buffer + chunk;
  const parts = combined.split('\n');
  const remainder = parts.pop() ?? '';
  const lines = parts.map(line => line.trim()).filter(line => line.length > 0);
  return { lines, remainder };
}

export function parseStreamLine(rawLine: string): AttentionStreamLine | null {
  try {
    const parsed = JSON.parse(rawLine) as AttentionStreamLine;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.type !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function advancePendingCursor(state: QueueState, cursor: string | undefined): void {
  if (!cursor) return;
  if (state.pendingCursor !== undefined && state.pendingCursor !== cursor) {
    state.committedCursor = state.pendingCursor;
  }
  state.pendingCursor = cursor;
}

function applyStreamError(
  state: QueueState,
  errorText: string | undefined
): { cursorInvalid: boolean; changed: boolean } {
  const cursorInvalid = errorText === 'cursor_invalid';
  if (cursorInvalid) {
    state.committedCursor = undefined;
    state.pendingCursor = undefined;
  }
  state.lastError = errorText ?? 'stream_error';
  return { cursorInvalid, changed: true };
}

function applyStreamHeartbeat(
  state: QueueState,
  line: AttentionStreamLine
): { cursorInvalid: boolean; changed: boolean } {
  if (line.cursor) {
    state.committedCursor = line.cursor;
    state.pendingCursor = undefined;
  }
  if (line.type === 'ready') {
    state.connected = true;
    state.lastError = null;
  }
  return { cursorInvalid: false, changed: line.type === 'ready' };
}

export function applyStreamLine(
  state: QueueState,
  line: AttentionStreamLine
): { cursorInvalid: boolean; changed: boolean } {
  if (line.type === 'error') return applyStreamError(state, line.error);
  if (line.type === 'degraded') {
    state.degradedReason = line.reason ?? 'run_unreadable';
    return { cursorInvalid: false, changed: true };
  }
  if (line.type === 'ready' || line.type === 'bookmark') {
    return applyStreamHeartbeat(state, line);
  }
  advancePendingCursor(state, line.cursor);
  if (line.type === 'attention' && line.item && typeof line.item.ref === 'string') {
    state.items.set(line.item.ref, line.item);
    return { cursorInvalid: false, changed: true };
  }
  if ((line.type === 'resolved' || line.type === 'unmatched') && typeof line.ref === 'string') {
    return { cursorInvalid: false, changed: state.items.delete(line.ref) };
  }
  return { cursorInvalid: false, changed: false };
}

export function findItemByRefOrRunId(
  state: QueueState,
  ref?: string,
  runId?: string
): AttentionQueueItem | undefined {
  if (ref && state.items.has(ref)) {
    return state.items.get(ref);
  }
  if (runId) {
    for (const item of state.items.values()) {
      if (item.run?.id === runId || item.askedIn?.runId === runId) {
        return item;
      }
    }
  }
  return undefined;
}

export function getSortedOpenItems(state: QueueState): AttentionQueueItem[] {
  return [...state.items.values()].sort((a, b) => {
    const aPri = a.priority ? 0 : 1;
    const bPri = b.priority ? 0 : 1;
    if (aPri !== bPri) return aPri - bPri;
    const aTime = a.pausedAt ?? '';
    const bTime = b.pausedAt ?? '';
    return aTime.localeCompare(bTime);
  });
}

export function nextBackoffMs(attempt: number, baseMs = 1000, maxMs = 30_000): number {
  const safeAttempt = Math.max(0, Math.min(attempt, 10));
  return Math.min(maxMs, baseMs * 2 ** safeAttempt);
}

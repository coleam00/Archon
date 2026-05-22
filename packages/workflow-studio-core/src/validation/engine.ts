import type { DagNode, WorkflowDefinition } from '../schemas';
import type { WorkflowApiClient } from '../api/WorkflowApiClient';
import { runStructuralRules } from './rules/structural';
import { runGraphRules } from './rules/graph';
import { runContentRules } from './rules/content';
import { type Issue, issueId } from './types';

export interface EngineSnapshot {
  issues: Issue[];
  isValidating: boolean;
  lastRunAt: number;
}

export interface EngineInput {
  nodes: readonly DagNode[];
  /** Full WorkflowDefinition required to run the server tier. If absent, server tier is skipped. */
  definition?: WorkflowDefinition;
}

export interface EngineOptions {
  debounceMs?: number;
  client?: Pick<WorkflowApiClient, 'validateWorkflow'>;
  /** Test hook: fires every time the debounced tier completes. */
  onDebouncedRun?: () => void;
}

type Listener = () => void;

/**
 * Three-tier engine. Tiers own disjoint slices of the issue list so a slow
 * server response cannot clobber a fresh client run.
 *
 * Tier ordering:
 *   1. Instant   — structural rules; runs synchronously on every update().
 *   2. Debounced — graph + content rules; coalesces bursts via setTimeout.
 *   3. Server    — validateWorkflow RPC; only runs when no client errors exist.
 *
 * Stale-response defence:
 *   - AbortController: signals the outer call that a new server run has started
 *     (the real WorkflowApiClient.validateWorkflow does NOT accept AbortSignal —
 *     see drift 6.4.1 — so abort() only closes local state).
 *   - Monotonic sequence number: `mySeq !== this.seq` drops any response that
 *     resolves after a newer run has started. This is the effective stale guard.
 */
export class ValidationEngine {
  private debounceMs: number;
  private client?: Pick<WorkflowApiClient, 'validateWorkflow'>;
  private onDebouncedRun?: () => void;

  private input: EngineInput | null = null;
  private instantIssues: Issue[] = [];
  private debouncedIssues: Issue[] = [];
  private serverIssues: Issue[] = [];
  private isValidating = false;
  private lastRunAt = 0;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private inflightAbort: AbortController | null = null;

  private listeners = new Set<Listener>();
  private cachedSnapshot: EngineSnapshot | null = null;
  private notifying = false;

  constructor(opts: EngineOptions = {}) {
    this.debounceMs = opts.debounceMs ?? 300;
    this.client = opts.client;
    this.onDebouncedRun = opts.onDebouncedRun;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Returns the current composed snapshot. Memoized — the same reference is
   * returned across calls until any tier's issue list, `isValidating`, or
   * `lastRunAt` changes. Task 6.5's `useSyncExternalStore` requires this
   * referential stability (a new object each call would cause infinite
   * re-renders in React 18+ strict mode). The cache is invalidated by
   * `notify()` before listeners fire (drift 6.4.5).
   */
  snapshot(): EngineSnapshot {
    if (this.cachedSnapshot) return this.cachedSnapshot;
    this.cachedSnapshot = {
      issues: [...this.instantIssues, ...this.debouncedIssues, ...this.serverIssues],
      isValidating: this.isValidating,
      lastRunAt: this.lastRunAt,
    };
    return this.cachedSnapshot;
  }

  update(input: EngineInput): void {
    this.input = input;
    this.instantIssues = runStructuralRules(input.nodes);
    this.scheduleDebounced();
    this.notify();
  }

  /**
   * Force the engine to re-run all tiers against its last input.
   * No-op when no input has been provided yet. Re-uses the same debounce
   * + server-tier pipeline as a normal `update()` call.
   */
  revalidate(): void {
    if (!this.input) return;
    this.update(this.input);
  }

  dispose(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.inflightAbort?.abort();
    // Bump seq so any in-flight validateWorkflow that resolves after dispose
    // sees mySeq !== this.seq and exits without writing to inert state (M1).
    this.seq++;
    this.listeners.clear();
  }

  private scheduleDebounced(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.isValidating = true;
    this.debounceTimer = setTimeout(() => {
      this.runDebounced();
    }, this.debounceMs);
  }

  private runDebounced(): void {
    this.debounceTimer = null;
    if (!this.input) return;
    const { nodes } = this.input;
    this.debouncedIssues = [...runGraphRules(nodes), ...runContentRules(nodes)];
    this.onDebouncedRun?.();
    this.lastRunAt = Date.now();

    const hasClientErrors =
      this.instantIssues.some(i => i.severity === 'error') ||
      this.debouncedIssues.some(i => i.severity === 'error');

    if (this.client && this.input.definition && !hasClientErrors) {
      void this.runServer();
    } else {
      // Harden against stale server responses: abort in-flight call and bump
      // seq so any pending runServer resolves with mySeq !== this.seq and
      // does not overwrite the freshly-cleared serverIssues (drift 6.4.2).
      if (hasClientErrors) {
        this.inflightAbort?.abort();
        this.seq++;
        this.serverIssues = [];
      }
      this.isValidating = false;
      this.notify();
    }
  }

  private async runServer(): Promise<void> {
    if (!this.client || !this.input?.definition) return;
    this.inflightAbort?.abort();
    const ac = new AbortController();
    this.inflightAbort = ac;
    const mySeq = ++this.seq;
    try {
      const res = await this.client.validateWorkflow(this.input.definition);
      if (mySeq !== this.seq) return; // superseded by a newer run
      // NOTE (M3): server messages are unconstrained free-form strings and may
      // contain `|`, which is the `issueId` djb2 key separator. The hash is
      // advisory (React keys / scroll preservation), not authoritative, so
      // collisions are visually harmless. See `issueId` docstring in types.ts.
      this.serverIssues = (res.errors ?? []).map(msg => ({
        id: issueId('server.unknown', {}, msg),
        rule: 'server.unknown',
        severity: 'error' as const,
        source: 'server' as const,
        message: msg,
        path: {},
      }));
      this.lastRunAt = Date.now();
    } catch (e) {
      if (mySeq !== this.seq) return;
      const message = `Server validation failed: ${e instanceof Error ? e.message : String(e)}`;
      this.serverIssues = [
        {
          id: issueId('server.error', {}, message),
          rule: 'server.error',
          severity: 'error' as const,
          source: 'server' as const,
          message,
          path: {},
        },
      ];
    } finally {
      if (mySeq === this.seq) {
        // Only clear isValidating if no fresh debounce is queued (I2).
        // Otherwise a rapid edit during a server call would briefly flicker
        // the UI to "settled" between the server resolve and the next debounce.
        if (!this.debounceTimer) this.isValidating = false;
        this.notify();
      }
    }
  }

  private notify(): void {
    // Invalidate cached snapshot BEFORE listeners observe (so a listener that
    // calls snapshot() inside its callback sees fresh state). Re-entrancy
    // guard (M2) prevents a listener-triggered update from re-firing all
    // listeners synchronously — the outer notify call will pick up the new
    // state on its remaining iteration since the cache is already invalid.
    this.cachedSnapshot = null;
    if (this.notifying) return;
    this.notifying = true;
    try {
      for (const l of this.listeners) l();
    } finally {
      this.notifying = false;
    }
  }
}

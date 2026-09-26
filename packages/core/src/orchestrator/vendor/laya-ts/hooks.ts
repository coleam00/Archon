/**
 * Opt-in prediction hooks: observe or shape every decision without forking.
 *
 * A hook is either a plain `(ctx) => void` or an object implementing any subset of the
 * lifecycle methods on `Hook`. Hooks are configured on `Agent` / `Router` and can be
 * overridden per call. Port of `laya/hooks.py`.
 */

/** Mutable state passed to every hook for one call. */
export class PredictContext {
  /** `states` / `questions` may be rewritten by `onPredictStart`. */
  states: unknown[];
  questions: Record<string, unknown>;
  /** Shared by every hook of one call. */
  runId: string;
  /** Set by `skip()` or after inference; `onPredictEnd` may rewrite it. */
  results: Record<string, unknown>[] | null = null;
  /** Router: the RouteDecision. */
  decision: Record<string, unknown> | null = null;
  /** Resolved checkpoint name. */
  model: string | null = null;
  agent: unknown = null;
  router: unknown = null;
  /** Per-call token-budget overrides; null = agent config. */
  maxLen: number | null = null;
  headMaxLen: number | null = null;
  /** Aggregated input/output tokens across results. */
  usage: Record<string, number> | null = null;
  startedAt: number;
  elapsedMs: number | null = null;
  error: unknown = null;

  constructor(
    init: { states: unknown[]; questions: Record<string, unknown> } & Partial<PredictContext>
  ) {
    this.states = init.states;
    this.questions = init.questions;
    this.runId = newRunId();
    this.startedAt = now();
    for (const [k, v] of Object.entries(init)) {
      if (k !== 'states' && k !== 'questions' && v !== undefined) {
        (this as unknown as Record<string, unknown>)[k] = v;
      }
    }
  }

  /** Set cached results from a start hook; inference is skipped, end hooks still run. */
  skip(results: Record<string, unknown>[]): void {
    this.results = results;
  }

  /** Set elapsedMs from startedAt. Called by the dispatching call, not by hooks. */
  markElapsed(): void {
    this.elapsedMs = now() - this.startedAt;
  }
}

function newRunId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().replaceAll('-', '');
  let hex = '';
  for (let i = 0; i < 32; i++) hex += Math.floor(Math.random() * 16).toString(16);
  return hex;
}

function now(): number {
  const p = (globalThis as { performance?: { now?: () => number } }).performance;
  return p && typeof p.now === 'function' ? p.now() : Date.now();
}

/** Optional lifecycle methods. Implement any subset; missing methods are skipped. */
export interface Hook {
  onPredictStart?(ctx: PredictContext): void;
  onPredictEnd?(ctx: PredictContext): void;
  onRoute?(ctx: PredictContext): void;
  onLoad?(ctx: PredictContext): void;
  onEvict?(ctx: PredictContext): void;
  onError?(ctx: PredictContext): void;
}

export type PredictHook = (ctx: PredictContext) => void;
export type HookArg = Hook | Hook[] | null | undefined;
export type PredictHookArg = PredictHook | PredictHook[] | null | undefined;

export const HOOK_EVENTS = [
  'onPredictStart',
  'onPredictEnd',
  'onRoute',
  'onLoad',
  'onEvict',
  'onError',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * No-op base class: subclass it and override only the events you need.
 *
 * `Hook` is the structural interface; `BaseHook` is the concrete convenience when you would
 * rather subclass than implement methods by shape. Every method does nothing by default.
 */
export class BaseHook implements Hook {
  onPredictStart(_ctx: PredictContext): void {}
  onPredictEnd(_ctx: PredictContext): void {}
  onRoute(_ctx: PredictContext): void {}
  onLoad(_ctx: PredictContext): void {}
  onEvict(_ctx: PredictContext): void {}
  onError(_ctx: PredictContext): void {}
}

function isHookLike(item: unknown): item is Hook {
  return (
    typeof item === 'object' &&
    item !== null &&
    HOOK_EVENTS.some(e => typeof (item as Record<string, unknown>)[e] === 'function')
  );
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'Array';
  if (typeof v === 'object') return (v as object).constructor?.name ?? 'object';
  return typeof v;
}

/**
 * Normalise the hook arguments shared by Agent, Router and every predict call: an optional
 * hook (object or list) plus optional plain start/end callables. A plain callable is not a
 * hook on its own -- which lifecycle event would it bind to? Passing one as `hooks` is a
 * TypeError; pass it as `onPredictStart` / `onPredictEnd` instead. The same callable as both
 * start and end is a TypeError too: the registry dedupes by identity, so one of the two would
 * silently never fire.
 */
export function normaliseHooks(
  hooks?: unknown,
  onPredictStart?: PredictHookArg,
  onPredictEnd?: PredictHookArg
): Hook[] {
  const out: Hook[] = [];
  const append = (item: unknown): void => {
    if (item === null || item === undefined) return;
    if (typeof item === 'function') {
      // A JS function can carry properties; one that also defines hook methods is ambiguous.
      if (
        HOOK_EVENTS.some(e => typeof (item as unknown as Record<string, unknown>)[e] === 'function')
      ) {
        throw new TypeError('a hook must be a plain callable or implement hook methods, not both');
      }
      throw new TypeError(
        'a plain callable is ambiguous; pass it as onPredictStart or onPredictEnd'
      );
    }
    if (Array.isArray(item)) {
      for (const h of item) append(h);
      return;
    }
    if (typeof item !== 'object') {
      throw new TypeError(`hooks must be Hook objects, got ${typeName(item)}`);
    }
    if (!isHookLike(item)) {
      throw new TypeError(
        `a hook must implement at least one hook method (${HOOK_EVENTS.join(', ')})`
      );
    }
    out.push(item as Hook);
  };
  append(hooks);
  if (onPredictStart !== null && onPredictStart !== undefined) {
    if (typeof onPredictStart !== 'function') {
      throw new TypeError(`onPredictStart must be callable, got ${typeName(onPredictStart)}`);
    }
    out.push({ onPredictStart });
  }
  if (onPredictEnd !== null && onPredictEnd !== undefined) {
    if (typeof onPredictEnd !== 'function') {
      throw new TypeError(`onPredictEnd must be callable, got ${typeName(onPredictEnd)}`);
    }
    out.push({ onPredictEnd });
  }
  if (
    onPredictStart !== null &&
    onPredictStart !== undefined &&
    onPredictStart === (onPredictEnd as unknown)
  ) {
    throw new TypeError(
      'onPredictStart and onPredictEnd must be different callables; one callable cannot serve both events'
    );
  }
  return out;
}

const defaultHooksList: Hook[] = [];

/** The process-wide hooks, a copy, in order. Empty unless set via `setDefaultHooks`. */
export function defaultHooks(): Hook[] {
  return [...defaultHooksList];
}

/**
 * Replace the process-wide default hooks.
 *
 * Defaults run before installed and per-call hooks for every `Agent` and `Router` in the
 * process, so a tracer or metrics hook does not have to be threaded through every
 * construction. Accepts the same arguments as the `hooks` option.
 */
export function setDefaultHooks(
  hooks?: HookArg,
  onPredictStart?: PredictHookArg,
  onPredictEnd?: PredictHookArg
): void {
  const normalised = normaliseHooks(hooks, onPredictStart, onPredictEnd);
  defaultHooksList.length = 0;
  defaultHooksList.push(...normalised);
}

/** Append one hook or a list of hooks to the process-wide defaults. */
export function addDefaultHook(hook: HookArg): void {
  defaultHooksList.push(...normaliseHooks(hook));
}

/** Remove every process-wide default hook. */
export function clearDefaultHooks(): void {
  defaultHooksList.length = 0;
}

/**
 * Effective hook list for one call: defaults, then installed, then per-call hooks.
 *
 * Reads the process-wide defaults at call time, so hooks set after construction still apply.
 */
export function composeHooks(
  installed: readonly Hook[],
  hooks?: HookArg,
  onPredictStart?: PredictHookArg,
  onPredictEnd?: PredictHookArg
): Hook[] {
  return [
    ...defaultHooksList,
    ...installed,
    ...normaliseHooks(hooks, onPredictStart, onPredictEnd),
  ];
}

/**
 * Base class giving a runtime-mutable hook list.
 *
 * `Agent` and `Router` extend it so hooks can be added, removed or scoped after construction.
 * Mutation replaces the array, so a call that already snapshotted its active hooks is never
 * disturbed by an add or remove that lands mid-flight.
 */
export class HookRegistry {
  hooks: Hook[] = [];

  /** Install one hook or a list of them. Returns this for chaining. */
  addHook(hook: HookArg): this {
    const added = normaliseHooks(hook);
    if (added.length > 0) this.hooks = [...this.hooks, ...added];
    return this;
  }

  /** Remove a hook by identity. Returns true if it was installed. */
  removeHook(hook: unknown): boolean {
    const before = this.hooks.length;
    this.hooks = this.hooks.filter(installed => installed !== hook);
    return this.hooks.length !== before;
  }

  /**
   * Run `fn` with hooks installed, then remove them -- works for sync and async `fn`:
   *
   *     await router.withHooks([tracer], () => router.predict(state, questions));
   */
  withHooks<T>(hookArgs: HookArg[], fn: () => T): T {
    const added = normaliseHooks(hookArgs);
    this.hooks = [...this.hooks, ...added];
    const release = (): void => {
      this.hooks = this.hooks.filter(installed => !added.includes(installed));
    };
    let out: T;
    try {
      out = fn();
    } catch (err) {
      release();
      throw err;
    }
    if (out instanceof Promise) {
      return out.finally(release) as T;
    }
    release();
    return out;
  }
}

/** Sum the per-state usage blocks so a hook sees one total for the call. */
export function aggregateUsage(results: Record<string, unknown>[]): Record<string, number> {
  const total = (key: string): number =>
    results.reduce((acc, r) => {
      const usage = r?.['usage'] as Record<string, unknown> | null | undefined;
      const v = usage?.[key];
      return acc + (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0);
    }, 0);
  return { input_tokens: total('input_tokens'), output_tokens: total('output_tokens') };
}

/**
 * Call `event` on every hook that implements it.
 *
 * `raiseErrors=false` warns and continues, for hooks (telemetry) that must not fail a
 * request. Python also takes a `lock` to serialise dispatch for hooks that are not safe to
 * run concurrently; JS hooks run synchronously on one thread, so there is nothing to lock.
 */
export function dispatch(
  hooks: Hook[],
  event: HookEvent,
  ctx: PredictContext,
  opts: { raiseErrors?: boolean } = {}
): void {
  const raiseErrors = opts.raiseErrors ?? true;
  for (const hook of hooks) {
    const method = hook?.[event];
    if (typeof method !== 'function') continue;
    try {
      method.call(hook, ctx);
    } catch (err) {
      if (raiseErrors) throw err;
      const name = (hook as object)?.constructor?.name ?? 'hook';
      console.warn(`laya: hook ${name}.${event} failed: ${String(err)}`);
    }
  }
}

import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions,
  TerminalInputHandler,
} from '@mariozechner/pi-coding-agent';
import { Theme } from '@mariozechner/pi-coding-agent';

import type { MessageChunk } from '../../types';

/**
 * Emitter used by the UI stub to push notifications into Archon's event stream.
 * `bridgeSession` wires `setEmitter` at session start and clears it in finally,
 * so notifications fired after teardown are silently dropped.
 */
export interface ArchonUIBridge {
  /** Invoked by ExtensionUIContext.notify(). */
  emit(chunk: MessageChunk): void;
  /** Wire the concrete emitter (called once from bridgeSession). */
  setEmitter(fn: ((chunk: MessageChunk) => void) | undefined): void;
}

export function createArchonUIBridge(): ArchonUIBridge {
  let emitter: ((chunk: MessageChunk) => void) | undefined;
  return {
    emit(chunk: MessageChunk): void {
      emitter?.(chunk);
    },
    setEmitter(fn: ((chunk: MessageChunk) => void) | undefined): void {
      emitter = fn;
    },
  };
}

const noop = (): void => {
  /* intentional no-op for TUI-only setters */
};

/**
 * Build a minimal ExtensionUIContext for Archon's server-side Pi sessions.
 *
 * Pi's ExtensionRunner reports `hasUI: true` to extensions as long as any UI
 * context is bound (i.e. not the internal `noOpUIContext`). Several community
 * extensions (notably `@plannotator/pi-extension`) gate whole feature flows on
 * `ctx.hasUI` — when false, plannotator auto-approves every plan silently and
 * the browser UI never spawns. Passing this stub to `session.bindExtensions()`
 * flips that gate on while keeping Archon's headless execution model intact.
 *
 * Interaction semantics — matches Pi's own RPC-mode defaults (see
 * `dist/modes/rpc/rpc-mode.js:81-209`):
 *   - `notify()` forwards to Archon's event stream as a `system` chunk so the
 *     user sees plannotator's "Open manually: http://host:port/" URL.
 *   - Interactive prompts (`select`, `confirm`, `input`, `editor`, `custom`)
 *     return undefined / false immediately. No operator is on the terminal to
 *     answer, so the extension gets the same "cancelled" signal it would from
 *     a dismissed RPC dialog and must cope.
 *   - TUI-only setters (`setWidget`, `setFooter`, `setHeader`, `setStatus`, …)
 *     no-op. No terminal to paint into.
 *   - Getters return safe defaults. `theme` uses a lazy Proxy because Archon
 *     does not own Pi's theme singleton; the extensions we currently exercise
 *     (plannotator + pi-agent-browser) never touch it, and an extension that
 *     does will fail loudly rather than silently render garbage.
 */
export function createArchonUIContext(bridge: ArchonUIBridge): ExtensionUIContext {
  const themeProxy = new Proxy({} as Theme, {
    get(_target: Theme, prop: string | symbol): never {
      throw new Error(
        `Pi extension accessed ctx.ui.theme.${String(prop)} — Archon's remote UI stub does not expose a terminal theme. Extensions that render to a TUI are unsupported in server-side workflow execution.`
      );
    },
  });

  return {
    select(
      _title: string,
      _options: string[],
      _opts?: ExtensionUIDialogOptions
    ): Promise<string | undefined> {
      return Promise.resolve(undefined);
    },
    confirm(_title: string, _message: string, _opts?: ExtensionUIDialogOptions): Promise<boolean> {
      return Promise.resolve(false);
    },
    input(
      _title: string,
      _placeholder?: string,
      _opts?: ExtensionUIDialogOptions
    ): Promise<string | undefined> {
      return Promise.resolve(undefined);
    },
    notify(message: string, type: 'info' | 'warning' | 'error' = 'info'): void {
      // Extension notifications are user-facing by design — plannotator, for
      // example, sends its browser review URL through here, and the user
      // MUST see it to approve the plan. Emit as `assistant` chunks so they
      // (a) stream to the workflow user's stdout/SSE like normal model output,
      // (b) accumulate into `$nodeId.output` for downstream bash/script nodes
      // to grep for URLs or parse structured data, and (c) land in the
      // workflow JSONL log. A `system`-typed chunk would satisfy (a) only on
      // the ⚠️/MCP-prefix forwarding path in the DAG executor and would NOT
      // be captured in node output at all — so the URL never reaches bash.
      // The prefix encodes the extension-notification origin + severity so
      // readers can distinguish these from model-generated prose.
      const icon = type === 'error' ? '❌' : type === 'warning' ? '⚠️' : 'ℹ️';
      bridge.emit({ type: 'assistant', content: `\n[pi extension ${icon}] ${message}\n` });
    },
    onTerminalInput(_handler: TerminalInputHandler): () => void {
      return noop;
    },
    setStatus(_key: string, _text: string | undefined): void {
      noop();
    },
    setWorkingMessage(_message?: string): void {
      noop();
    },
    setHiddenThinkingLabel(_label?: string): void {
      noop();
    },
    setWidget(_key: string, _content: unknown, _options?: ExtensionWidgetOptions): void {
      noop();
    },
    setFooter(_factory: Parameters<ExtensionUIContext['setFooter']>[0]): void {
      noop();
    },
    setHeader(_factory: Parameters<ExtensionUIContext['setHeader']>[0]): void {
      noop();
    },
    setTitle(_title: string): void {
      noop();
    },
    custom<T>(): Promise<T> {
      return Promise.resolve(undefined as unknown as T);
    },
    pasteToEditor(_text: string): void {
      noop();
    },
    setEditorText(_text: string): void {
      noop();
    },
    getEditorText(): string {
      return '';
    },
    editor(_title: string, _prefill?: string): Promise<string | undefined> {
      return Promise.resolve(undefined);
    },
    setEditorComponent(_factory: Parameters<ExtensionUIContext['setEditorComponent']>[0]): void {
      noop();
    },
    get theme(): Theme {
      return themeProxy;
    },
    getAllThemes(): ReturnType<ExtensionUIContext['getAllThemes']> {
      return [];
    },
    getTheme(_name: string): Theme | undefined {
      return undefined;
    },
    setTheme(_theme: string | Theme): { success: boolean; error?: string } {
      return { success: false, error: 'Theme switching not supported in Archon remote UI stub' };
    },
    getToolsExpanded(): boolean {
      return false;
    },
    setToolsExpanded(_expanded: boolean): void {
      noop();
    },
  };
}

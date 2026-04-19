import type {
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions,
  TerminalInputHandler,
} from '@mariozechner/pi-coding-agent';
import { Theme } from '@mariozechner/pi-coding-agent';

import type { MessageChunk } from '../../types';

/** Pushes UI notifications into Archon's event stream. Set/cleared by bridgeSession. */
export interface ArchonUIBridge {
  emit(chunk: MessageChunk): void;
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
  /* no-op — TUI-only setter, nothing to paint into */
};

/**
 * Minimal ExtensionUIContext for Archon's headless Pi sessions. Binding this
 * (vs Pi's internal `noOpUIContext`) flips `ctx.hasUI` to true so extensions
 * like plannotator surface UI flows. `notify()` forwards to the event stream;
 * interactive prompts resolve to undefined/false; TUI setters no-op; `theme`
 * throws on access so TUI-only extensions fail loudly instead of rendering
 * garbage. Mirrors Pi's own RPC-mode defaults.
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
      // Emit as `assistant` (not `system`) so the content is captured into
      // `$nodeId.output` for downstream bash/script nodes. System chunks are
      // filtered to ⚠️/MCP-prefix only by the DAG executor.
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

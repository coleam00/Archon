import type { MessageChunk } from '../../types';

export interface ArchonOmpUIBridge {
  emit(chunk: MessageChunk): void;
  setEmitter(fn: ((chunk: MessageChunk) => void) | undefined): void;
}

interface DialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}
interface TerminalInputResult {
  consume?: boolean;
  data?: string;
}
type TerminalInputHandler = (data: string) => TerminalInputResult | undefined;
type OmpTheme = Record<string, unknown>;

export interface OmpExtensionUIContext {
  select(
    title: string,
    options: string[],
    dialogOptions?: DialogOptions
  ): Promise<string | undefined>;
  confirm(title: string, message: string, dialogOptions?: DialogOptions): Promise<boolean>;
  input(
    title: string,
    placeholder?: string,
    dialogOptions?: DialogOptions
  ): Promise<string | undefined>;
  notify(message: string, type?: 'info' | 'warning' | 'error'): void;
  onTerminalInput(handler: TerminalInputHandler): () => void;
  setStatus(key: string, text: string | undefined): void;
  setWorkingMessage(message?: string): void;
  setWidget(key: string, content: unknown, options?: unknown): void;
  setFooter(factory: unknown): void;
  setHeader(factory: unknown): void;
  setTitle(title: string): void;
  custom<T>(): Promise<T>;
  pasteToEditor(text: string): void;
  setEditorText(text: string): void;
  getEditorText(): string;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  setEditorComponent(factory: unknown): void;
  readonly theme: OmpTheme;
  getAllThemes(): Promise<{ name: string; path: string | undefined }[]>;
  getTheme(name: string): Promise<OmpTheme | undefined>;
  setTheme(theme: string | OmpTheme): Promise<{ success: boolean; error?: string }>;
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
}

export function createArchonOmpUIBridge(): ArchonOmpUIBridge {
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

const noop = (): void => undefined;

function lastStringArg(args: unknown[]): string {
  for (let i = args.length - 1; i >= 0; i -= 1) {
    const value = args[i];
    if (typeof value === 'string') return value;
  }
  return '';
}

export function createArchonOmpUIContext(bridge: ArchonOmpUIBridge): OmpExtensionUIContext {
  const theme = new Proxy({} as OmpTheme, {
    get(_target, prop: string | symbol): unknown {
      if (prop === 'getColorMode') return () => 'truecolor';
      if (prop === 'getFgAnsi' || prop === 'getBgAnsi') return () => '';
      if (prop === 'name' || prop === 'sourcePath' || prop === 'sourceInfo') return undefined;
      return (...args: unknown[]) => lastStringArg(args);
    },
  });

  return {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify(message: string, type: 'info' | 'warning' | 'error' = 'info'): void {
      bridge.emit({
        type: 'assistant',
        content: `\n[omp extension ${type}] ${message}\n`,
        flush: true,
      });
    },
    onTerminalInput: () => noop,
    setStatus: noop,
    setWorkingMessage: noop,
    setWidget: noop,
    setFooter: noop,
    setHeader: noop,
    setTitle: noop,
    custom: async <T>() => undefined as T,
    pasteToEditor: noop,
    setEditorText: noop,
    getEditorText: () => '',
    editor: async () => undefined,
    setEditorComponent: noop,
    get theme(): OmpTheme {
      return theme;
    },
    getAllThemes: async () => [],
    getTheme: async () => undefined,
    setTheme: async () => ({
      success: false,
      error: 'Theme switching not supported in Archon OMP UI stub',
    }),
    getToolsExpanded: () => false,
    setToolsExpanded: noop,
  };
}

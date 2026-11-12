export type ScriptRuntime = 'bun' | 'uv';

const EXTENSION_RUNTIME_MAP: Readonly<Partial<Record<string, ScriptRuntime>>> = {
  '.ts': 'bun',
  '.js': 'bun',
  '.py': 'uv',
};

export function getRuntimeForExtension(ext: string): ScriptRuntime | undefined {
  return EXTENSION_RUNTIME_MAP[ext];
}

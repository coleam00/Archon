import type { ScriptRuntime } from '../script-discovery';

/** Files retain authored pack-relative paths; only entry points can be script nodes. */
export interface BundledScriptPack {
  readonly files: Readonly<Record<string, string>>;
  readonly scripts: Readonly<
    Record<string, { readonly path: string; readonly runtime: ScriptRuntime }>
  >;
}

/**
 * The script API as text, for a host to hand to a script's process and to write out for
 * an editor. Bun embeds both files, in a source run and in a compiled binary.
 * TypeScript resolves them as a module and a declaration file, neither of which has
 * this default export.
 */
// @ts-expect-error TS1192: the text of the module, not its exports.
import moduleSource from './module.ts' with { type: 'text' };
// @ts-expect-error TS2846: the text of the declaration file, not its types.
import declaration from './archon-script.d.ts' with { type: 'text' };

/** The source of the `archon:script` module: TypeScript that imports only Node and Bun built-ins. */
export const scriptApiModuleSource: string = moduleSource;

/**
 * The declaration of `archon:script`: the module's public surface and its contract types.
 * Always LF: a checkout that converts line endings would otherwise embed CRLF, and the
 * file `archon script types` writes would differ by platform.
 */
export const scriptApiDeclaration: string = (declaration as string).replaceAll('\r\n', '\n');

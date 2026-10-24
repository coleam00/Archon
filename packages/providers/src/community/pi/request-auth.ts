/**
 * Custom Pi provider per-call `${VAR}` template substitution.
 *
 * pi-coding-agent 0.84+ consults a fresh `new ModelRegistry(this._modelRuntime)`
 * for session auth — the `ModelRegistry` a caller pre-builds and hands in via
 * extensions is discarded inside `createAgentSession`. An earlier
 * `getApiKeyAndHeaders` wrapper plugged into the discarded facade and never
 * reached the SDK's actual session-auth seam; credentialless custom providers
 * (e.g. `mygw`) declaring `apiKey: '$MYGW_API_KEY'` silently regressed because
 * the SDK fell through to `process.env.MYGW_API_KEY`, which Archon deliberately
 * keeps empty (per-call secrets ride on `requestOptions.env`, never process.env
 * — see the executor's `effectiveEnv` and the per-subprocess bash spawn hook).
 *
 * The fix that closes the seam: write a per-call `models.json` with literal
 * substituted values and pass it as `modelsPath` to `ModelRuntime.create()`.
 * Pi's own `ModelConfig.load` then resolves the literal directly — no
 * `${VAR}` substitution at request time, so the missing-fallback path can't
 * fire. The caller passes the env to substitute from: the Pi provider passes
 * one layered env (request over process over assistant config), so its login
 * check and a turn resolve every reference the same way.
 *
 * The protected-env contract: protected `${VAR}` references are substituted
 * with a structurally-valid but provably-unresolvable placeholder
 * (`${__ARCHON_BLOCKED_${VAR}__}`). The placeholder name is one identifier
 * the SDK's parser recognises, so the SDK attempts to resolve it at request
 * time and fails — the failure mode is host-environment-independent (no
 * `process.env` fallback can ever produce a value), and the per-call file
 * never carries the literal protected value. The placeholder prefix
 * (`__ARCHON_BLOCKED_`) is non-empty and content-stripped at module load so
 * it cannot collide with any user-named env var.
 *
 * The file is written with mode 0o600 (and explicit chmod to defeat umask);
 * the containing directory with mode 0o700. The runtime re-reads the file on
 * every `refresh()`, so it must outlive the runtime — see
 * `createRequestModelRuntime`.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expandTilde } from '@archon/paths';
// Type-only: erased at compile time, so Pi's config.js never loads here.
import type { CreateModelRuntimeOptions, ModelRuntime } from '@earendil-works/pi-coding-agent';

export interface CustomProviderEnvScope {
  provider: string;
  authoritativeCredential?: boolean;
  /** The values `${VAR}` references are substituted with. */
  env: Readonly<Record<string, string>>;
  protectedEnvKeys: readonly string[] | undefined;
}

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

type TemplatePart = { type: 'literal'; value: string } | { type: 'env'; name: string };

/** A parsed part and the index just past the text it was read from. */
interface ParsedPart {
  part: TemplatePart;
  next: number;
}

function literalAt(value: string, next: number): ParsedPart {
  return { part: { type: 'literal', value }, next };
}

/** The part a `${` at `dollarIndex` opens. An unclosed brace leaves a literal `$`. */
function bracedPartAt(config: string, dollarIndex: number): ParsedPart {
  const endIndex = config.indexOf('}', dollarIndex + 2);
  if (endIndex < 0) return literalAt('$', dollarIndex + 1);
  const name = config.slice(dollarIndex + 2, endIndex);
  if (!ENV_VAR_NAME_RE.test(name)) {
    return literalAt(config.slice(dollarIndex, endIndex + 1), endIndex + 1);
  }
  return { part: { type: 'env', name }, next: endIndex + 1 };
}

/** The part the `$` at `dollarIndex` starts: an escape, a reference, or a literal `$`. */
function dollarPartAt(config: string, dollarIndex: number): ParsedPart {
  const nextChar = config[dollarIndex + 1];
  if (nextChar === '$' || nextChar === '!') return literalAt(nextChar, dollarIndex + 2);
  if (nextChar === '{') return bracedPartAt(config, dollarIndex);
  const match = ENV_VAR_NAME_PREFIX_RE.exec(config.slice(dollarIndex + 1));
  if (!match) return literalAt('$', dollarIndex + 1);
  return { part: { type: 'env', name: match[0] }, next: dollarIndex + 1 + match[0].length };
}

function parseTemplate(config: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let index = 0;
  while (index < config.length) {
    const dollarIndex = config.indexOf('$', index);
    if (dollarIndex < 0) {
      parts.push({ type: 'literal', value: config.slice(index) });
      break;
    }
    if (dollarIndex > index) {
      parts.push({ type: 'literal', value: config.slice(index, dollarIndex) });
    }
    const { part, next } = dollarPartAt(config, dollarIndex);
    parts.push(part);
    index = next;
  }
  return parts;
}

interface SubstitutionResult {
  /** The value after substitution. */
  resolved: string;
  /** True iff at least one `${VAR}` reference was substituted (vs left unchanged). */
  didSubstitute: boolean;
}

/**
 * Resolve a `${VAR}` template against `env`, honoring the protected-keys
 * contract.
 *
 * Mirrors the SDK's `resolveConfigValue` (`@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js`)
 * — same parser, same `${VAR}` / `$$` / `$!` semantics — except:
 *   - never reads `process.env` itself: the caller decides which env applies;
 *   - protected keys are substituted with a structurally-valid placeholder
 *     (`${__ARCHON_BLOCKED_${VAR}__}`) so the SDK's own resolver surfaces a
 *     host-environment-independent "no value for env var" error at request
 *     time. The literal protected value is never written to the per-call
 *     file. The placeholder prefix `__ARCHON_BLOCKED_` cannot collide with
 *     any user-named env var.
 *
 * Returns `undefined` for values that contain no `${VAR}` references at all
 * (nothing to do — caller can pass the original through).
 */
function resolveProviderConfigValue(
  value: string,
  env: Readonly<Record<string, string>>,
  protectedKeys: ReadonlySet<string>
): SubstitutionResult | undefined {
  // Command form (`!cmd`, mirroring the SDK's parseConfigValueReference):
  // the SDK executes these at request time WITHOUT template substitution —
  // rewriting `$VAR` text inside a command string would change what the
  // command runs, so leave command values untouched. (`$!cmd` escapes to a
  // literal `!cmd` value and is still a template.)
  if (value.startsWith('!')) return undefined;
  if (!value.includes('$')) return undefined;
  const parts = parseTemplate(value);

  // Classify the env references up front. The falsy (not presence) check
  // mirrors the SDK's own resolver (`env?.[name] || process.env[name] ||
  // undefined`): an empty-string value falls through exactly like a missing
  // one, so the template survives and the SDK surfaces its actionable
  // "Failed to resolve from environment variable: NAME" error instead of a
  // schema-invalid empty apiKey silently dropping the whole provider.
  const { hasProtected, hasMissing } = classifyReferences(parts, env, protectedKeys);
  if (hasMissing && !hasProtected) {
    // Unresolvable reference and nothing to block: leave the original
    // template unchanged so Pi surfaces its standard error. This is the
    // documented behaviour for credentialless providers whose template
    // references vars not delivered to the run.
    return { resolved: value, didSubstitute: false };
  }

  const substituted = parts.map(part => substitutePart(part, env, protectedKeys));
  if (!substituted.some(part => part.didSubstitute))
    return { resolved: value, didSubstitute: false };
  return { resolved: substituted.map(part => part.resolved).join(''), didSubstitute: true };
}

function classifyReferences(
  parts: readonly TemplatePart[],
  env: Readonly<Record<string, string>>,
  protectedKeys: ReadonlySet<string>
): { hasProtected: boolean; hasMissing: boolean } {
  let hasProtected = false;
  let hasMissing = false;
  for (const part of parts) {
    if (part.type !== 'env') continue;
    if (protectedKeys.has(part.name)) hasProtected = true;
    else if (!env[part.name]) hasMissing = true;
  }
  return { hasProtected, hasMissing };
}

function substitutePart(
  part: TemplatePart,
  env: Readonly<Record<string, string>>,
  protectedKeys: ReadonlySet<string>
): SubstitutionResult {
  if (part.type === 'literal') return { resolved: part.value, didSubstitute: false };
  if (protectedKeys.has(part.name)) {
    // Placeholder is one valid identifier the SDK's parser recognises;
    // the SDK attempts to resolve `__ARCHON_BLOCKED_<VAR>` at request
    // time and fails (the name is provably absent from any context —
    // neither the substitution env nor process.env can supply it). The literal
    // protected value never appears in the per-call file. This
    // substitution is UNCONDITIONAL — a different, merely-missing ref in
    // the same template must never cancel it (the bail-out in
    // resolveProviderConfigValue only fires when no protected ref is present).
    return { resolved: `\${__ARCHON_BLOCKED_${part.name}__}`, didSubstitute: true };
  }
  if (!env[part.name]) {
    // Reachable only alongside a protected ref (see the bail-out in
    // resolveProviderConfigValue): keep the missing ref as template text so the
    // SDK still reports it, while the protected placeholder survives into the per-call file.
    return { resolved: `\${${part.name}}`, didSubstitute: false };
  }
  return { resolved: env[part.name], didSubstitute: true };
}

/**
 * Resolve the user's `models.json` path, mirroring Pi's own `getAgentDir()`:
 * `process.env.PI_CODING_AGENT_DIR/models.json` if set, else
 * `<homedir>/.pi/agent/models.json`. Replicated here (rather than imported
 * from `@earendil-works/pi-coding-agent`) to keep this module's module-load
 * side effects off Pi's `dist/config.js` — that file reads `package.json`
 * next to `process.execPath` at module load, which crashes compiled Archon
 * binaries at startup (v0.3.7 symptom, see provider.ts header note).
 */
export function getUserModelsPath(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
  // expandTilde matches the SDK's own getAgentDir(), which tilde-expands the
  // override. Without it a `PI_CODING_AGENT_DIR=~/...` (dotenv-style loaders
  // don't shell-expand) would make existsSync probe a literal `~/` path,
  // skip substitution, and let the SDK read the REAL models.json via its own
  // tilde-correct resolution — silently reverting to the leak this module
  // exists to close.
  const agentDir =
    envDir && envDir.length > 0 ? expandTilde(envDir) : join(homedir(), '.pi', 'agent');
  return join(agentDir, 'models.json');
}

/**
 * The user's Pi catalog store (`models-store.json`, beside `models.json`).
 * The one place Archon derives it: the per-call runtime reads it, and
 * error remedies name it.
 */
export function getUserModelsStorePath(): string {
  return join(dirname(getUserModelsPath()), 'models-store.json');
}

/**
 * Substitute custom-provider env references, or remove competing native auth for a
 * delivered credential. The returned private file must live until runtime release.
 * Without delivery, unreadable configuration retains the native SDK failure path.
 */
export function buildCustomProviderModelsPath(scope: CustomProviderEnvScope): string | undefined {
  const { provider } = scope;
  const authoritative = scope.authoritativeCredential === true;

  const userModelsPath = getUserModelsPath();
  if (!existsSync(userModelsPath)) return undefined;
  const read = readUserModels(userModelsPath, authoritative);
  if (!read) return undefined;
  const { models } = read;
  const providerEntry = models.providers?.[provider];
  if (!providerEntry || typeof providerEntry !== 'object') return undefined;

  // Clone to avoid mutating the parsed object graph.
  const substituted: Record<string, unknown> = structuredClone(providerEntry);
  if (authoritative) removeCompetingAuth(substituted);
  const anySubstitution = substituteEnvReferences(
    substituted,
    scope.env,
    new Set(scope.protectedEnvKeys ?? [])
  );
  if (!authoritative && !anySubstitution) return undefined;

  return writePrivateModelsFile(provider, {
    providers: { ...(authoritative ? models.providers : {}), [provider]: substituted },
  });
}

interface UserModels {
  providers?: Record<string, Record<string, unknown>>;
}

/** Undefined when the file cannot be read or parsed, unless a delivered credential depends on it. */
function readUserModels(
  userModelsPath: string,
  authoritative: boolean
): { models: UserModels } | undefined {
  try {
    const raw = readFileSync(userModelsPath, 'utf-8');
    return { models: JSON.parse(stripPiJsonComments(raw)) as UserModels };
  } catch (err) {
    if (authoritative) throw err;
    return undefined;
  }
}

// Pi's private stripJsonComments utility is not exported. Mirror its syntax;
// the real-SDK credential-authority test checks native/rewrite conformance.
function stripPiJsonComments(raw: string): string {
  return (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, match => (match[0] === '"' ? match : ''))
    .replace(
      /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
      (match, tail: string | undefined) => tail ?? (match[0] === '"' ? match : '')
    );
}

const AUTH_HEADER_NAMES = ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key'];

/** Strip the entry's own credentials, and its models' and overrides', so the delivered one wins. */
function removeCompetingAuth(providerEntry: Record<string, unknown>): void {
  const { models, modelOverrides } = providerEntry;
  const overrides =
    modelOverrides && typeof modelOverrides === 'object' ? Object.values(modelOverrides) : [];
  for (const entry of [providerEntry, ...(Array.isArray(models) ? models : []), ...overrides]) {
    if (entry && typeof entry === 'object') removeAuth(entry as Record<string, unknown>);
  }
}

function removeAuth(entry: Record<string, unknown>): void {
  delete entry.apiKey;
  if (entry.headers && typeof entry.headers === 'object') {
    entry.headers = Object.fromEntries(
      Object.entries(entry.headers).filter(
        ([name]) => !AUTH_HEADER_NAMES.includes(name.toLowerCase())
      )
    );
  }
}

/** Substitutes the entry's `apiKey` and string headers in place; true when any value changed. */
function substituteEnvReferences(
  providerEntry: Record<string, unknown>,
  env: Readonly<Record<string, string>>,
  protectedSet: ReadonlySet<string>
): boolean {
  let anySubstitution = false;
  const apiKey = substitutedValue(providerEntry.apiKey, env, protectedSet);
  if (apiKey !== undefined) {
    providerEntry.apiKey = apiKey;
    anySubstitution = true;
  }
  const { headers } = providerEntry;
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    const headerValues = headers as Record<string, unknown>;
    for (const [key, value] of Object.entries(headerValues)) {
      const header = substitutedValue(value, env, protectedSet);
      if (header === undefined) continue;
      headerValues[key] = header;
      anySubstitution = true;
    }
  }
  return anySubstitution;
}

function substitutedValue(
  value: unknown,
  env: Readonly<Record<string, string>>,
  protectedSet: ReadonlySet<string>
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const result = resolveProviderConfigValue(value, env, protectedSet);
  return result?.didSubstitute ? result.resolved : undefined;
}

function writePrivateModelsFile(provider: string, models: UserModels): string {
  const dir = join(tmpdir(), 'archon-pi-models');
  // Our filesystem operation: failures (ENOSPC, EACCES on /tmp, ENAMETOOLONG)
  // are surfaced to the caller via throw so the provider can log + return a
  // classified error instead of silently degrading to the unsubstituted user
  // models.json (which would re-open the round-1 leak surface).
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode applies only to directories it actually creates; an
  // existing dir from a prior run keeps its umask-diluted mode. Force
  // 0o700 explicitly so the dir is owner-only on every call.
  chmodSync(dir, 0o700);
  // Per-call, per-process uniqueness: PID + hrtime-style random suffix. The
  // file is owned by the calling process; no cross-run sharing is intended.
  const fileName = `models-${provider}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.json`;
  const filePath = join(dir, fileName);
  const payload = JSON.stringify(models, null, 2);
  // mode is diluted by the process umask; set it explicitly AND chmod after
  // to guarantee 0o600 on disk. Mirrors the token-crypto pattern in
  // `packages/core/src/utils/token-crypto.ts:100-102`. If the chmod (or a
  // partial write) fails AFTER the file exists, remove it before re-throwing:
  // the caller only cleans up paths this function RETURNED, so a throw here
  // must never leave the cleartext secret behind.
  try {
    writeFileSync(filePath, payload, { mode: 0o600 });
    chmodSync(filePath, 0o600);
  } catch (err) {
    rmSync(filePath, { force: true });
    throw err;
  }
  return filePath;
}

export interface RequestModelRuntime {
  runtime: ModelRuntime;
  /** Remove the per-call `models.json`, if one was written. Call once nothing uses `runtime`. */
  release(): void;
}

/**
 * Create the `ModelRuntime` for one call. For a custom provider whose
 * `models.json` entry has `${VAR}` references (`customProvider` set), the
 * runtime reads a per-call file with the values substituted.
 *
 * The file must exist for as long as the runtime is used: `refresh()` re-reads
 * `modelsPath` and treats a missing file as an empty config, and every
 * `registerProvider()` call (an extension registering its provider, for
 * example) ends with a background `refresh()`. Deleting the file earlier drops
 * the custom provider mid-session. The caller owns `release()`.
 *
 * `modelsStorePath` stays the user's catalog store: Pi otherwise derives it
 * from `dirname(modelsPath)` and would read and write a store beside the
 * per-call files.
 */
export async function createRequestModelRuntime(
  create: (options: CreateModelRuntimeOptions) => Promise<ModelRuntime>,
  authPath: string | undefined,
  customProvider: CustomProviderEnvScope | undefined
): Promise<RequestModelRuntime> {
  const modelsPath = customProvider ? buildCustomProviderModelsPath(customProvider) : undefined;
  const release = (): void => {
    if (modelsPath) rmSync(modelsPath, { force: true });
  };
  try {
    const runtime = await create({
      authPath,
      ...(modelsPath ? { modelsPath, modelsStorePath: getUserModelsStorePath() } : {}),
    });
    return { runtime, release };
  } catch (err) {
    release();
    throw err;
  }
}

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
 * fire.
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
  requestEnv: Readonly<Record<string, string>> | undefined;
  protectedEnvKeys: readonly string[] | undefined;
}

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

type TemplatePart = { type: 'literal'; value: string } | { type: 'env'; name: string };

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
    const nextChar = config[dollarIndex + 1];
    if (nextChar === '$' || nextChar === '!') {
      parts.push({ type: 'literal', value: nextChar });
      index = dollarIndex + 2;
      continue;
    }
    if (nextChar === '{') {
      const endIndex = config.indexOf('}', dollarIndex + 2);
      if (endIndex < 0) {
        parts.push({ type: 'literal', value: '$' });
        index = dollarIndex + 1;
        continue;
      }
      const name = config.slice(dollarIndex + 2, endIndex);
      if (ENV_VAR_NAME_RE.test(name)) {
        parts.push({ type: 'env', name });
      } else {
        parts.push({ type: 'literal', value: config.slice(dollarIndex, endIndex + 1) });
      }
      index = endIndex + 1;
      continue;
    }
    const match = ENV_VAR_NAME_PREFIX_RE.exec(config.slice(dollarIndex + 1));
    if (match) {
      parts.push({ type: 'env', name: match[0] });
      index = dollarIndex + 1 + match[0].length;
      continue;
    }
    parts.push({ type: 'literal', value: '$' });
    index = dollarIndex + 1;
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
 *   - never falls back to `process.env` (Archon keeps per-call secrets off
 *     process.env; a fallback would silently expose the host shell's value);
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
  let hasProtected = false;
  let hasMissing = false;
  for (const part of parts) {
    if (part.type !== 'env') continue;
    if (protectedKeys.has(part.name)) hasProtected = true;
    else if (!env[part.name]) hasMissing = true;
  }
  if (hasMissing && !hasProtected) {
    // Unresolvable reference and nothing to block: leave the original
    // template unchanged so Pi surfaces its standard error. This is the
    // documented behaviour for credentialless providers whose template
    // references vars not delivered to the run.
    return { resolved: value, didSubstitute: false };
  }

  const resolvedParts: string[] = [];
  let didSubstitute = false;
  for (const part of parts) {
    if (part.type === 'literal') {
      resolvedParts.push(part.value);
      continue;
    }
    if (protectedKeys.has(part.name)) {
      // Placeholder is one valid identifier the SDK's parser recognises;
      // the SDK attempts to resolve `__ARCHON_BLOCKED_<VAR>` at request
      // time and fails (the name is provably absent from any context —
      // neither requestEnv nor process.env can supply it). The literal
      // protected value never appears in the per-call file. This
      // substitution is UNCONDITIONAL — a different, merely-missing ref in
      // the same template must never cancel it (the bail-out above only
      // fires when no protected ref is present).
      resolvedParts.push(`\${__ARCHON_BLOCKED_${part.name}__}`);
      didSubstitute = true;
      continue;
    }
    if (!env[part.name]) {
      // Reachable only alongside a protected ref (see bail-out above): keep
      // the missing ref as template text so the SDK still reports it, while
      // the protected placeholder above survives into the per-call file.
      resolvedParts.push(`\${${part.name}}`);
      continue;
    }
    resolvedParts.push(env[part.name]);
    didSubstitute = true;
  }
  if (!didSubstitute) return { resolved: value, didSubstitute: false };
  return { resolved: resolvedParts.join(''), didSubstitute: true };
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
 * Build a per-call `models.json` with the targeted custom provider's
 * `${VAR}` references substituted against `requestEnv`. Returns the path to
 * the written file (suitable for `ModelRuntime.create({ modelsPath })`), or
 * `undefined` when no substitution applies and the SDK's default `modelsPath`
 * lookup should be left in place.
 *
 * Returns `undefined` when:
 *   - `requestEnv` is undefined (no per-call env to substitute against);
 *   - the user's `models.json` doesn't exist or isn't valid JSON;
 *   - the targeted provider isn't in `models.json`;
 *   - no `${VAR}` reference in the provider's `apiKey`/`headers` produces a
 *     substitution: the provider has no template values, or every templated
 *     field references only missing/empty (and no protected) keys. A
 *     protected reference ALWAYS produces a substitution (its placeholder),
 *     so a file is written whenever one is present.
 */
export function buildCustomProviderModelsPath(scope: CustomProviderEnvScope): string | undefined {
  const { provider, requestEnv, protectedEnvKeys } = scope;
  if (requestEnv === undefined) return undefined;

  const userModelsPath = getUserModelsPath();
  if (!existsSync(userModelsPath)) return undefined;

  let raw: string;
  try {
    raw = readFileSync(userModelsPath, 'utf-8');
  } catch {
    return undefined;
  }
  let parsed: { providers?: Record<string, Record<string, unknown>> };
  try {
    parsed = JSON.parse(raw) as { providers?: Record<string, Record<string, unknown>> };
  } catch {
    return undefined;
  }
  const providerEntry = parsed.providers?.[provider];
  if (!providerEntry || typeof providerEntry !== 'object') return undefined;

  const protectedSet = new Set(protectedEnvKeys ?? []);
  // Clone to avoid mutating the parsed object graph.
  const substituted: Record<string, unknown> = structuredClone(providerEntry);
  let anySubstitution = false;

  if (typeof substituted.apiKey === 'string') {
    const result = resolveProviderConfigValue(substituted.apiKey, requestEnv, protectedSet);
    if (result?.didSubstitute) {
      substituted.apiKey = result.resolved;
      anySubstitution = true;
    }
  }

  if (
    substituted.headers &&
    typeof substituted.headers === 'object' &&
    !Array.isArray(substituted.headers)
  ) {
    const headers = substituted.headers as Record<string, unknown>;
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string') continue;
      const result = resolveProviderConfigValue(value, requestEnv, protectedSet);
      if (result?.didSubstitute) {
        headers[key] = result.resolved;
        anySubstitution = true;
      }
    }
  }

  if (!anySubstitution) return undefined;

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
  const payload = JSON.stringify({ providers: { [provider]: substituted } }, null, 2);
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
      ...(modelsPath
        ? { modelsPath, modelsStorePath: join(dirname(getUserModelsPath()), 'models-store.json') }
        : {}),
    });
    return { runtime, release };
  } catch (err) {
    release();
    throw err;
  }
}

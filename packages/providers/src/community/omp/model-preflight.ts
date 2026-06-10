import { createLogger } from '@archon/paths';
import { parseOmpModelRef } from './model-ref';
import { isOmpRuntimeDiscoveredProvider } from './model-registry-hints';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.omp.preflight');
  return cachedLog;
}

export interface ModelResolutionResult {
  modelPath: string;
  ok: boolean;
  error?: string;
  latencyMs?: number;
}

/** Options for checkModelResolutionAll. */
export interface ModelResolutionOptions {
  /**
   * When true, run the live prompt probe (sends a real LLM request per model).
   * Default false: cheap registry + credential resolution only.
   */
  live?: boolean;
}

const PREFLIGHT_PROMPT = 'Reply with exactly: OK';
const PREFLIGHT_TIMEOUT_MS = 45_000;

/**
 * Cheap preflight: verify the model path parses, resolves in OMP's model
 * registry (with the same runtime-discovery refresh the provider uses), and
 * that credentials are present for the provider. Sends NO prompt — safe to
 * run on every `archon validate workflows` without token cost or latency.
 */
export async function checkModelRegistryResolution(
  modelPath: string,
  env?: Record<string, string>
): Promise<ModelResolutionResult> {
  const parsed = parseOmpModelRef(modelPath);
  if (!parsed) {
    return { modelPath, ok: false, error: `Invalid model path: ${modelPath}` };
  }

  const start = Date.now();
  try {
    const omp = await import('@oh-my-pi/pi-coding-agent');
    const authStorage = await omp.discoverAuthStorage();
    const modelRegistry = new omp.ModelRegistry(authStorage);
    await modelRegistry.refresh();

    let model = modelRegistry.find(parsed.provider, parsed.modelId);
    if (!model && isOmpRuntimeDiscoveredProvider(parsed.provider)) {
      await modelRegistry.refreshProvider(parsed.provider, 'online');
      model = modelRegistry.find(parsed.provider, parsed.modelId);
    }
    if (!model) {
      return {
        modelPath,
        ok: false,
        error: `Model '${parsed.modelId}' not found in registry for provider '${parsed.provider}'`,
        latencyMs: Date.now() - start,
      };
    }

    // Credential presence: mirror provider.ts — env override (request env →
    // process.env) wins over stored credentials.
    const { OMP_PROVIDER_ENV_VARS } = await import('./provider');
    const envVarName = OMP_PROVIDER_ENV_VARS[parsed.provider];
    const envOverride = envVarName ? (env?.[envVarName] ?? process.env[envVarName]) : undefined;
    if (envOverride) {
      authStorage.setRuntimeApiKey(parsed.provider, envOverride);
    }
    const resolvedKey = await authStorage.getApiKey(parsed.provider);
    if (!resolvedKey && envVarName) {
      return {
        modelPath,
        ok: false,
        error: `No credentials for provider '${parsed.provider}'. Set ${envVarName} or run \`omp auth\`.`,
        latencyMs: Date.now() - start,
      };
    }

    return { modelPath, ok: true, latencyMs: Date.now() - start };
  } catch (err: unknown) {
    const e = err as Error;
    getLog().warn({ modelPath, err: e }, 'omp.model_registry_check_failed');
    return {
      modelPath,
      ok: false,
      error: e.message,
      latencyMs: Date.now() - start,
    };
  }
}

export async function checkModelResolution(
  modelPath: string,
  cwd: string,
  env?: Record<string, string>
): Promise<ModelResolutionResult> {
  const parsed = parseOmpModelRef(modelPath);
  if (!parsed) {
    return { modelPath, ok: false, error: `Invalid model path: ${modelPath}` };
  }

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, PREFLIGHT_TIMEOUT_MS);

  try {
    const { OmpProvider: ompProviderClass } = await import('./provider');
    const provider = new ompProviderClass();
    let sawAssistant = false;
    for await (const chunk of provider.sendQuery(PREFLIGHT_PROMPT, cwd, undefined, {
      model: modelPath,
      abortSignal: controller.signal,
      env,
    })) {
      if (chunk.type === 'assistant' && chunk.content.trim().length > 0) {
        sawAssistant = true;
        break;
      }
    }
    const latencyMs = Date.now() - start;
    if (!sawAssistant) {
      return {
        modelPath,
        ok: false,
        error: 'No assistant response (empty stream)',
        latencyMs,
      };
    }
    return { modelPath, ok: true, latencyMs };
  } catch (err: unknown) {
    const e = err as Error;
    getLog().warn({ modelPath, err: e }, 'omp.model_preflight_failed');
    return {
      modelPath,
      ok: false,
      error: e.message,
      latencyMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check a set of model paths. Default: cheap registry/credential resolution
 * (no prompt). With `{ live: true }`: real prompt probes. Either way, checks
 * run concurrently — one slow provider doesn't serialize the rest.
 */
export async function checkModelResolutionAll(
  modelPaths: readonly string[],
  cwd: string,
  env?: Record<string, string>,
  options?: ModelResolutionOptions
): Promise<ModelResolutionResult[]> {
  const unique = [...new Set(modelPaths.filter(p => p.trim().length > 0))];
  return Promise.all(
    unique.map(modelPath =>
      options?.live === true
        ? checkModelResolution(modelPath, cwd, env)
        : checkModelRegistryResolution(modelPath, env)
    )
  );
}

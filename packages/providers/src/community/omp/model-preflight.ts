import { createLogger } from '@archon/paths';
import { parseOmpModelRef } from './model-ref';

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

const PREFLIGHT_PROMPT = 'Reply with exactly: OK';
const PREFLIGHT_TIMEOUT_MS = 45_000;

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

export async function checkModelResolutionAll(
  modelPaths: readonly string[],
  cwd: string,
  env?: Record<string, string>
): Promise<ModelResolutionResult[]> {
  const unique = [...new Set(modelPaths.filter(p => p.trim().length > 0))];
  const results: ModelResolutionResult[] = [];
  for (const modelPath of unique) {
    results.push(await checkModelResolution(modelPath, cwd, env));
  }
  return results;
}

/** Parsed Oh My Pi model reference. */
export interface OmpModelRef {
  /** OMP provider id, e.g. 'anthropic', 'openai', 'llama.cpp'. */
  provider: string;
  /** Model id; may contain additional slashes for routed providers. */
  modelId: string;
}

/**
 * Parse '<omp-provider-id>/<model-id>' refs, splitting on the first slash so
 * nested model ids such as 'openrouter/qwen/qwen3-coder' remain intact.
 */
export function parseOmpModelRef(raw: string): OmpModelRef | undefined {
  const idx = raw.indexOf('/');
  if (idx <= 0 || idx === raw.length - 1) return undefined;

  const provider = raw.slice(0, idx);
  const modelId = raw.slice(idx + 1);

  if (!/^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/.test(provider)) return undefined;
  if (modelId.length === 0) return undefined;

  return { provider, modelId };
}

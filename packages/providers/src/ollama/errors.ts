/**
 * Ollama direct-provider error classes.
 *
 * Ollama is a simple HTTP shim against `${OLLAMA_BASE_URL}/api/chat` — error
 * surface is intentionally narrow: `UnknownOllamaModelError` covers any non-2xx
 * response (model not pulled, malformed name, upstream failure). The provider
 * itself catches network errors and re-throws via the same class for caller
 * uniformity.
 */

export class UnknownOllamaModelError extends Error {
  constructor(
    public readonly model: string,
    public readonly bodySnippet?: string
  ) {
    super(`Ollama model not found or call failed: '${model}'`);
    this.name = 'UnknownOllamaModelError';
  }
}

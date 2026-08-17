/**
 * Public barrel for the built-in Ollama provider.
 */
export { OLLAMA_CAPABILITIES } from './capabilities';
export { OllamaClient, resolveOllamaBaseUrl, type FetchFn, type OllamaChatEvent } from './client';
export { UnknownOllamaModelError } from './errors';
export { OllamaProvider } from './provider';
export { registerOllamaProvider } from './registration';

import type { Codebase } from '../types';
import { loadConfig } from './config-loader';

export async function resolveProjectAssistant(
  codebase: Pick<Codebase, 'ai_assistant_type' | 'default_cwd'>
): Promise<string | undefined> {
  return codebase.ai_assistant_type ?? (await loadConfig(codebase.default_cwd)).assistant;
}

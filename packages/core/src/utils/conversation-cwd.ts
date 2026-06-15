import type { Codebase, Conversation } from '../types';
import * as codebaseDb from '../db/codebases';
import * as isolationEnvDb from '../db/isolation-environments';

export type ConversationCwdSource = 'isolation' | 'conversation' | 'codebase';

export interface ConversationCwdResolution {
  cwd: string;
  source: ConversationCwdSource;
  codebase: Codebase | null;
}

export interface ResolveConversationCwdOptions {
  codebase?: Codebase | null;
  preferIsolation?: boolean;
}

/**
 * Resolve the directory commands should operate in without denormalizing the
 * project default path into conversation state.
 */
export async function resolveConversationCwd(
  conversation: Conversation,
  options: ResolveConversationCwdOptions = {}
): Promise<ConversationCwdResolution | null> {
  let codebase = options.codebase;

  if (options.preferIsolation !== false && conversation.isolation_env_id) {
    const env = await isolationEnvDb.getById(conversation.isolation_env_id);
    if (env?.working_path) {
      return {
        cwd: env.working_path,
        source: 'isolation',
        codebase: codebase ?? null,
      };
    }
  }

  if (conversation.cwd) {
    return {
      cwd: conversation.cwd,
      source: 'conversation',
      codebase: codebase ?? null,
    };
  }

  if (conversation.codebase_id) {
    if (codebase === undefined) {
      codebase = await codebaseDb.getCodebase(conversation.codebase_id);
    }

    if (codebase) {
      return {
        cwd: codebase.default_cwd,
        source: 'codebase',
        codebase,
      };
    }
  }

  return null;
}

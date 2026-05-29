/**
 * Codebase commands — list, get, register, delete, env vars, environments.
 *
 * Reads (list/get/env list/environments) hit the database directly and work
 * without a running server. Mutations (register/delete/env set/env delete) go
 * through the REST API so they inherit the route handlers' validation and
 * resource cleanup.
 */
import { resolve } from 'path';
import * as codebaseDb from '@archon/core/db/codebases';
import * as isolationEnvDb from '@archon/core/db/isolation-environments';
import * as envVarsDb from '@archon/core/db/env-vars';
import type { Codebase } from '@archon/core';
import { createApiClient } from '../api-client';
import { confirmOrAbort } from '../prompt';

function formatDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Resolve a codebase by exact UUID first, then case-insensitive name match.
 * Throws on no match or on an ambiguous name (multiple codebases share it).
 */
export async function resolveCodebase(idOrName: string): Promise<Codebase> {
  const byId = await codebaseDb.getCodebase(idOrName);
  if (byId) return byId;

  const all = await codebaseDb.listCodebases();
  const matches = all.filter(c => c.name.toLowerCase() === idOrName.toLowerCase());
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous codebase "${idOrName}" — ${String(matches.length)} codebases share this name. ` +
        'Use the id instead:\n' +
        matches.map(c => `  ${c.id}  (${c.name})`).join('\n')
    );
  }
  throw new Error(`Codebase not found: ${idOrName}`);
}

export async function codebaseListCommand(json?: boolean): Promise<void> {
  const codebases = await codebaseDb.listCodebases();

  if (json) {
    console.log(JSON.stringify({ codebases }, null, 2));
    return;
  }

  if (codebases.length === 0) {
    console.log('No codebases registered.');
    console.log('Register one with: archon codebase register <path|url>');
    return;
  }

  for (const cb of codebases) {
    console.log(`\n${cb.name}`);
    console.log(`  ID:        ${cb.id}`);
    console.log(`  Source:    ${cb.repository_url ?? cb.default_cwd}`);
    console.log(`  Assistant: ${cb.ai_assistant_type}`);
  }
  console.log(`\nTotal: ${String(codebases.length)} codebase(s)`);
}

export async function codebaseGetCommand(idOrName: string, json?: boolean): Promise<void> {
  const cb = await resolveCodebase(idOrName);

  if (json) {
    console.log(JSON.stringify(cb, null, 2));
    return;
  }

  const commandNames = Object.keys(cb.commands ?? {});
  console.log(`Name:      ${cb.name}`);
  console.log(`ID:        ${cb.id}`);
  console.log(`Source:    ${cb.repository_url ?? cb.default_cwd}`);
  console.log(`CWD:       ${cb.default_cwd}`);
  console.log(`Assistant: ${cb.ai_assistant_type}`);
  console.log(`Commands:  ${commandNames.length > 0 ? commandNames.join(', ') : '(none)'}`);
  console.log(`Created:   ${formatDate(cb.created_at)}`);
}

export async function codebaseRegisterCommand(
  pathOrUrl: string,
  serverUrl?: string
): Promise<void> {
  // Remote repo (clone) vs local path (register). Local paths resolve to an
  // absolute path so `archon codebase register .` works from any directory.
  const isRemote = /^(https?:\/\/|git@|ssh:\/\/)/.test(pathOrUrl);
  const body = isRemote ? { url: pathOrUrl } : { path: resolve(pathOrUrl) };

  const api = createApiClient(serverUrl);
  const codebase = await api.post<Codebase>('/api/codebases', body);
  console.log(`Registered codebase: ${codebase.name} (${codebase.id})`);
}

export async function codebaseDeleteCommand(
  idOrName: string,
  force?: boolean,
  serverUrl?: string
): Promise<void> {
  const cb = await resolveCodebase(idOrName);

  const confirmed = await confirmOrAbort(
    `Delete codebase "${cb.name}" (${cb.id})? This removes its worktrees and workspace.`,
    force
  );
  if (!confirmed) {
    console.error('Aborted.');
    return;
  }

  const api = createApiClient(serverUrl);
  await api.del(`/api/codebases/${cb.id}`);
  console.log(`Deleted codebase: ${cb.name} (${cb.id})`);
}

export async function codebaseEnvListCommand(idOrName: string, json?: boolean): Promise<void> {
  const cb = await resolveCodebase(idOrName);
  // Read full map but expose ONLY keys — env var values are secret.
  const keys = Object.keys(await envVarsDb.getCodebaseEnvVars(cb.id)).sort();

  if (json) {
    console.log(JSON.stringify({ keys }, null, 2));
    return;
  }

  if (keys.length === 0) {
    console.log(`No env vars set for codebase "${cb.name}".`);
    return;
  }
  console.log(`Env var keys for "${cb.name}" (values hidden):`);
  for (const key of keys) console.log(`  ${key}`);
}

export async function codebaseEnvSetCommand(
  idOrName: string,
  key: string,
  value: string,
  serverUrl?: string
): Promise<void> {
  const cb = await resolveCodebase(idOrName);
  const api = createApiClient(serverUrl);
  await api.put(`/api/codebases/${cb.id}/env`, { key, value });
  console.log(`Set env var "${key}" for codebase "${cb.name}".`);
}

export async function codebaseEnvDeleteCommand(
  idOrName: string,
  key: string,
  serverUrl?: string
): Promise<void> {
  const cb = await resolveCodebase(idOrName);
  const api = createApiClient(serverUrl);
  await api.del(`/api/codebases/${cb.id}/env/${encodeURIComponent(key)}`);
  console.log(`Deleted env var "${key}" from codebase "${cb.name}".`);
}

export async function codebaseEnvironmentsCommand(idOrName: string, json?: boolean): Promise<void> {
  const cb = await resolveCodebase(idOrName);
  const environments = await isolationEnvDb.listByCodebaseWithAge(cb.id);

  if (json) {
    console.log(JSON.stringify({ environments }, null, 2));
    return;
  }

  if (environments.length === 0) {
    console.log(`No active isolation environments for codebase "${cb.name}".`);
    return;
  }

  console.log(`Isolation environments for "${cb.name}":`);
  for (const env of environments) {
    const age = `${String(Math.floor(env.days_since_activity))}d ago`;
    console.log(`\n  ${env.branch_name ?? env.workflow_id}`);
    console.log(`    Path:          ${env.working_path}`);
    console.log(`    Last activity: ${age}`);
  }
  console.log(`\nTotal: ${String(environments.length)} environment(s)`);
}

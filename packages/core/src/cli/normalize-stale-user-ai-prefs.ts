#!/usr/bin/env bun
/**
 * Normalize stale per-user `remote_agent_user_ai_prefs.tiers` rows that
 * survive the strict AiderDesk agent-profile lookup introduced in
 * `1fac9e3`. Pre-`1fac9e3` `<providerId>/<modelId>` literals (e.g.
 * `"ollama/gemma4:8b-8k"`) were configured as `tiers.small.model`
 * under `provider: "aiderdesk"`. After the split, AiderDesk's `model:`
 * slot is a case-sensitive profile NAME; the stale literal always
 * throws `UnknownAiderDeskAgentProfileError` at title-gen time.
 *
 * The orchestrator's producer-side guard
 * (`resolveTitleModelRequest` / `looksLikeStaleAiderDeskLiteral` in
 * `orchestrator-agent.ts`) already sanitizes the LIVE path; this
 * script is the operator's one-shot to heal persisted DB state so
 * future sessions skip the structural check.
 *
 * Usage:
 *   bun run packages/core/src/cli/normalize-stale-user-ai-prefs.ts                  # dry run (default)
 *   bun run packages/core/src/cli/normalize-stale-user-ai-prefs.ts --apply          # actually rewrite
 *
 * Exit codes:
 *   0  nothing to do, dry run completed, or normalization fully succeeded
 *   1  unexpected error (config load failure, DB scan failure, etc.)
 *   2  refused — operator's `tiers.small` is missing or itself a stale
 *      literal pair; nothing was written
 */
import { loadConfig } from '../config';
import { normalizeAllStaleAiderDeskTiers } from '../db/user-ai-prefs-store';

function parseArgs(argv: readonly string[]): { apply: boolean } {
  let apply = false;
  for (const arg of argv) {
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: bun run packages/core/src/cli/normalize-stale-user-ai-prefs.ts [--apply]'
      );
      process.exit(0);
    }
    console.error(`Unknown argument: '${arg}'.`);
    console.error(
      'Usage: bun run packages/core/src/cli/normalize-stale-user-ai-prefs.ts [--apply]'
    );
    process.exit(1);
  }
  return { apply };
}

async function main(): Promise<void> {
  const { apply } = parseArgs(process.argv.slice(2));
  // Surface the resolution target BEFORE running any DB I/O so the operator
  // can verify the destination matches their `.archon/config.yaml`.
  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error('[normalize-stale-user-ai-prefs] failed to load config:', (err as Error).message);
    process.exit(1);
  }
  const small = config.tiers?.small;
  if (!small?.model) {
    console.error(
      "[normalize-stale-user-ai-prefs] refused: .archon/config.yaml has no 'tiers.small' set.\n" +
        "Configure one before running this script (e.g. provider: aiderdesk, model: 'Power Tools')."
    );
    process.exit(2);
  }
  if (small.model.includes('/')) {
    // The destination preset itself is a stale literal — refusing is the
    // safe response, since substituting another stale preset would silently
    // continue the bug. The operator must fix the YAML first.
    console.error(
      `[normalize-stale-user-ai-prefs] refused: .archon/config.yaml 'tiers.small' model='${small.model}' is itself a <providerId>/<modelId> literal.\nEdit the YAML to a current AiderDesk profile name before running this script.`
    );
    process.exit(2);
  }

  console.log(
    `[normalize-stale-user-ai-prefs] destination preset: provider='${small.provider}' model='${small.model}'`
  );
  console.log(
    `[normalize-stale-user-ai-prefs] mode: ${apply ? '--apply (writes)' : 'dry-run (no writes; pass --apply to commit)'}`
  );

  let results;
  try {
    results = await normalizeAllStaleAiderDeskTiers(
      { provider: small.provider, model: small.model },
      { apply }
    );
  } catch (err) {
    console.error('[normalize-stale-user-ai-prefs] scan failed:', (err as Error).message);
    process.exit(1);
  }

  if (results.length === 0) {
    console.log('[normalize-stale-user-ai-prefs] no remote_agent_user_ai_prefs rows found.');
    return;
  }

  let totalRewritten = 0;
  let totalErrors = 0;
  const rewritten: { userId: string; staleValues: string[] }[] = [];
  for (const r of results) {
    if (r.error) {
      totalErrors += 1;
      console.error(`[normalize-stale-user-ai-prefs] ${r.userId}: ERROR ${r.error}`);
      continue;
    }
    if (r.rewritten > 0) {
      totalRewritten += r.rewritten;
      rewritten.push({ userId: r.userId, staleValues: r.staleValues });
    }
  }

  console.log(
    `[normalize-stale-user-ai-prefs] scanned ${results.length} rows, ${totalRewritten} would be rewritten, ${totalErrors} errors.`
  );
  for (const r of rewritten) {
    console.log(
      `  - ${r.userId}: ${r.staleValues.length} stale model(s) → '${small.provider}/${small.model}' [${apply ? 'WRITTEN' : 'dry-run'}]`
    );
  }

  if (!apply && totalRewritten > 0) {
    console.log('[normalize-stale-user-ai-prefs] re-run with --apply to commit.');
  }
}

void main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('[normalize-stale-user-ai-prefs] unexpected error:', (err as Error).message);
    process.exit(1);
  });

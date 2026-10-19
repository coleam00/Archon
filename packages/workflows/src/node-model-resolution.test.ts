import { describe, expect, test } from 'bun:test';
import { registerBuiltinProviders } from '@archon/providers/in-process';

import { buildAiProfile, type RawAliasesConfig } from './model-validation';
import { resolveNodeModel, resolveWorkflowModelScope } from './node-model-resolution';
import type { DagNode } from './schemas';

registerBuiltinProviders();

const lens = (model: DagNode['model']): DagNode =>
  ({
    id: 'seams',
    kind: 'agent',
    source: { kind: 'command', name: 'review-seams' },
    model,
  }) as DagNode;

const resolveLens = (model: DagNode['model'], aliases: RawAliasesConfig = {}) => {
  const profile = buildAiProfile('claude', { repoAliases: aliases });
  const scope = resolveWorkflowModelScope({}, 'claude', {}, profile);
  return resolveNodeModel(lens(model), scope, {}, profile);
};

// The SDLC pack's review lens chain: lens alias, then the reviewer concern, then a tier.
const chain: DagNode['model'] = ['@review-seams', '@reviewer', 'medium'];

describe('model preference lists resolve through the shared chain', () => {
  test('with nothing configured the node runs on its tier, exactly as `medium` would', () => {
    const viaList = resolveLens(chain);
    const viaTier = resolveLens('medium');
    expect(viaList.provider).toBe(viaTier.provider);
    expect(viaList.model).toBe(viaTier.model);
    expect(viaList.tier).toBe('medium');
  });

  test('a concern alias moves every lens that names it', () => {
    const resolved = resolveLens(chain, {
      '@reviewer': { provider: 'codex', model: 'gpt-5.5' },
    });
    expect(resolved.provider).toBe('codex');
    expect(resolved.model).toBe('gpt-5.5');
    expect(resolved.modelOrigin).toBe('model ref');
    expect(resolved.tier).toBeUndefined();
  });

  test('a lens alias overrides that lens while another lens keeps the reviewer', () => {
    const aliases = {
      '@reviewer': { provider: 'codex', model: 'gpt-5.5' },
      '@review-seams': { provider: 'claude', model: 'opus' },
    };
    expect(resolveLens(chain, aliases).model).toBe('opus');
    expect(resolveLens(['@review-tests', '@reviewer', 'medium'], aliases).model).toBe('gpt-5.5');
  });
});

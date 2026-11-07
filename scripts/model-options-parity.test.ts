import { describe, test, expect } from 'bun:test';
import { DEFAULT_CHAT_MODEL_OPTIONS } from '../packages/cli/src/commands/setup-model-options';
import { curatedOptionsForAgent } from '../packages/web/src/experiments/console/lib/model-options';
import tierDefaults from '../packages/workflows/src/defaults/tier-defaults.json';

// Package boundaries keep these declarations local. Compare ordered model IDs;
// hints belong to each surface's presentation.
describe('setup and console model suggestions agree', () => {
  for (const provider of ['claude', 'codex']) {
    test(provider, () => {
      expect(DEFAULT_CHAT_MODEL_OPTIONS[provider].map(option => option.value)).toEqual(
        curatedOptionsForAgent(provider).map(option => option.value)
      );
    });
  }
});

// The pickers suggest the built-in tier models. Sets, because the pickers order
// large, medium, small.
describe('setup suggestions name the built-in tier models', () => {
  for (const provider of ['claude', 'codex'] as const) {
    test(provider, () => {
      const tierModels = Object.values(tierDefaults[provider]).map(tier => tier.model);
      expect(new Set(DEFAULT_CHAT_MODEL_OPTIONS[provider].map(option => option.value))).toEqual(
        new Set(tierModels)
      );
    });
  }
});

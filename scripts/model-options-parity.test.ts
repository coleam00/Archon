import { describe, test, expect } from 'bun:test';
import { DEFAULT_CHAT_MODEL_OPTIONS } from '../packages/cli/src/commands/setup-model-options';
import { curatedOptionsForAgent } from '../packages/web/src/experiments/console/lib/model-options';

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

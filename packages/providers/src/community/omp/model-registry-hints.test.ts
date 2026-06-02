import { describe, expect, test } from 'bun:test';

import {
  formatOmpAuthInitFailedMessage,
  formatOmpModelConfigLoadHint,
  formatOmpModelNotFoundMessage,
  formatOmpModelRequiredMessage,
  isOmpRuntimeDiscoveredProvider,
} from './model-registry-hints';

describe('model-registry-hints', () => {
  test('formatOmpModelConfigLoadHint references models.yml', () => {
    expect(formatOmpModelConfigLoadHint('bad yaml')).toContain('models.yml');
    expect(formatOmpModelConfigLoadHint(undefined)).toBe('');
  });

  test('formatOmpModelNotFoundMessage references models.yml and models.db', () => {
    const msg = formatOmpModelNotFoundMessage('anthropic', 'claude-opus-4-6');
    expect(msg).toContain('models.yml');
    expect(msg).toContain('models.db');
    expect(msg).toContain('agent.db');
    expect(msg).toContain('models.json is legacy');
  });

  test('formatOmpModelNotFoundMessage adds discovery hint for cursor', () => {
    const msg = formatOmpModelNotFoundMessage('cursor', 'composer-2.5');
    expect(msg).toContain('discovery-based');
    expect(msg).toContain('omp models');
  });

  test('formatOmpAuthInitFailedMessage references agent.db', () => {
    expect(formatOmpAuthInitFailedMessage('ENOENT')).toContain('agent.db');
    expect(formatOmpAuthInitFailedMessage('ENOENT')).not.toContain('auth.json');
  });

  test('isOmpRuntimeDiscoveredProvider identifies discovery providers', () => {
    expect(isOmpRuntimeDiscoveredProvider('cursor')).toBe(true);
    expect(isOmpRuntimeDiscoveredProvider('anthropic')).toBe(false);
  });

  test('formatOmpModelRequiredMessage documents config paths', () => {
    expect(formatOmpModelRequiredMessage()).toContain('assistants.omp.model');
  });
});

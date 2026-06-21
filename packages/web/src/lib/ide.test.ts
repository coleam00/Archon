import { describe, expect, test } from 'bun:test';
import { buildIdeUri } from '@/lib/ide';

describe('buildIdeUri', () => {
  test('requests a new VS Code window for unix paths', () => {
    expect(buildIdeUri('/Users/dale/project')).toBe(
      'vscode://file//Users/dale/project?windowId=_blank'
    );
  });

  test('normalizes windows paths before building the URI', () => {
    expect(buildIdeUri('C:\\repo\\archon')).toBe('vscode://file/C:/repo/archon?windowId=_blank');
  });
});

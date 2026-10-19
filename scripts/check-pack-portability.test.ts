import { describe, expect, test } from 'bun:test';
import { findLeaks } from './check-pack-portability';

describe('pack portability check', () => {
  test('flags an owner, a vendor and a tracker number planted in a pack file', () => {
    const leaks = findLeaks(
      '.archon/workflows/sdlc/plan/commands/plan.md',
      [
        'Ask Wirasm first.',
        'Wait for CodeRabbit.',
        'See #4336 for history.',
        'Implement issue #123 is an example.',
      ].join('\n')
    );
    expect(leaks.map(leak => [leak.line, leak.what])).toEqual([
      [1, "this repository's owner"],
      [2, 'a specific review vendor'],
      [3, 'a tracker issue or PR number'],
    ]);
  });

  test("allows only the forge plugin's install id, in its own file", () => {
    const line = "export const GITHUB_FORGE_PLUGIN = 'coleam00/Archon/plugins/forge-github';";
    expect(findLeaks('.archon/workflows/sdlc/.shared/forge.ts', line)).toEqual([]);
    expect(findLeaks('.archon/workflows/sdlc/.shared/other.ts', line)).toHaveLength(1);
  });
});

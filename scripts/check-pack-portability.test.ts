import { describe, expect, test } from 'bun:test';
import { findLeaks, PACK_ROOT } from './check-pack-portability';

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

  test("allows the forge plugin's install command in the setup guide, and nothing else on that line", () => {
    const readme = `${PACK_ROOT}/README.md`;
    const command = 'archon plugin add coleam00/Archon/plugins/forge-github';
    expect(findLeaks(readme, command)).toEqual([]);
    expect(findLeaks(readme, `${command} # ask Wirasm`)).toHaveLength(1);
    expect(findLeaks(readme, 'See coleam00/Archon for history.')).toHaveLength(1);
    expect(findLeaks('.archon/workflows/sdlc/plan/commands/plan.md', command)).toHaveLength(1);
  });
});

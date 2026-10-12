import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

it('the tier consumers read their supplied policy instead of owning a risk list', () => {
  const pack = resolve(import.meta.dir, '../../workflows/sdlc');
  for (const file of ['review/commands/review-focused.md', 'review/commands/review-synthesize.md']) {
    const command = readFileSync(resolve(pack, file), 'utf8');
    expect(command).toContain('$mode.output.risks');
    expect(command).not.toContain('concurrency over shared state');
  }
});

/**
 * Hand a sub-agent its instructions.
 *
 * A sub-agent's instructions are markdown in this pack (`holdouts/commands/`), so they read and
 * change like every other prompt. An inline agent definition carries only a short prompt and has
 * no way to find a file in the pack, so a script copies the instructions into the run's artifacts
 * directory, and the agent's prompt tells it to read them from there.
 */

import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsDir, emit } from './io.ts';

export function copyBriefs(names: string[]): void {
  const target = join(artifactsDir(), 'agents');
  mkdirSync(target, { recursive: true });
  for (const name of names) {
    copyFileSync(join(import.meta.dir, '..', 'holdouts', 'commands', `${name}.md`), join(target, `${name}.md`));
  }
  emit({ dir: target, agents: names.join(',') });
}

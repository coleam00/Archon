import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { bashScriptArgs } from './bash-script';
import { formatPersistedNodeOutput } from './node-output';
import { shellQuoteOrFile, writeSpillFile } from './shell-quote';

const trackTempRoot = trackTempRoots();
const script = `printf '%s' '${'x'.repeat(40_000)}'`;
const value = 'x'.repeat(40_000);
const hash = createHash('sha256').update(script).digest('hex');

for (const writer of ['script', 'whole', 'field', 'persisted'] as const) {
  for (const component of ['root', 'engine', 'parent', 'leaf'] as const) {
    test.skipIf(process.platform === 'win32')(
      `${writer} does not follow an artifact ${component} symlink`,
      () => {
        const root = trackTempRoot(mkdtempSync(join(tmpdir(), 'archon-engine-file-')));
        const artifacts = join(root, 'artifacts');
        const other = join(root, 'other');
        mkdirSync(other);
        const external = join(other, 'target');
        writeFileSync(external, 'before');
        const relative =
          writer === 'script'
            ? join('bash-scripts', `${hash}.sh`)
            : join('node-output-spills', 'persisted', 'a.nodeoutput');
        const leaf = join(artifacts, '.archon', relative);
        const link =
          component === 'root'
            ? artifacts
            : component === 'engine'
              ? join(artifacts, '.archon')
              : component === 'parent'
                ? join(artifacts, '.archon', relative.split('/')[0])
                : leaf;
        mkdirSync(dirname(link), { recursive: true });
        symlinkSync(component === 'leaf' ? external : other, link);
        if (writer === 'script') {
          if (component === 'leaf') expect(bashScriptArgs(script, artifacts)).toEqual([leaf]);
          else expect(() => bashScriptArgs(script, artifacts)).toThrow('not a directory');
        } else if (writer === 'persisted') {
          const output = formatPersistedNodeOutput(value, artifacts, 'a');
          if (component === 'leaf') expect(output.spillPath).toBe(leaf);
          else expect(output.spillPath).toBeUndefined();
        } else {
          if (component === 'leaf') {
            expect(writeSpillFile(artifacts, relative, value)).toBe(leaf);
            expect(readFileSync(leaf, 'utf8')).toBe(value);
          }
          const expression = shellQuoteOrFile(
            value,
            'a',
            writer === 'whole' ? undefined : 'data',
            artifacts
          );
          if (component !== 'leaf') expect(expression).toBe(`'${value}'`);
        }
        expect(readFileSync(external, 'utf8')).toBe('before');
        expect(readdirSync(other)).toEqual(['target']);
      }
    );
  }
}

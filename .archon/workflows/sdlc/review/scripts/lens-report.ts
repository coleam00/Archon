// Writes one review lens's report, which the lens returned in its output, to
// review/<lens>.md under the run's artifacts directory, where synthesis reads it.
// Inputs: `lens`, the lens's node id; `report`, its report as Markdown.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsDir, emit, input } from 'archon:script';

const lens = input('lens').trim();
const report = input('report');
const dir = join(artifactsDir(), 'review');
mkdirSync(dir, { recursive: true });
const path = join(dir, `${lens}.md`);
writeFileSync(path, report.endsWith('\n') ? report : `${report}\n`);
emit({ lens, path, bytes: Buffer.byteLength(report) });

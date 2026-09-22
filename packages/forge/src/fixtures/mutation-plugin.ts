import { writeFile } from 'node:fs/promises';

const [mode, marker, response] = process.argv.slice(2);
await Bun.stdin.text();
await writeFile(marker, 'write happened');
if (mode === 'timeout') setInterval(Date.now, 1_000);
else if (mode === 'malformed') console.log('{not-json');
else {
  console.log(response);
  process.exitCode = mode === 'failure' ? 1 : 0;
}

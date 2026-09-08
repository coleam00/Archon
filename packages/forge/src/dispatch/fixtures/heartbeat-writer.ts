#!/usr/bin/env bun
// A grandchild that outlives an ordinary child kill unless the whole
// process tree is terminated. Used by hang-plugin.ts's tree-kill test:
// the test polls this file's mtime and asserts it stops advancing once
// the dispatcher's timeout fires.
import { writeFileSync } from 'node:fs';
const file = process.argv[2];
if (!file) process.exit(1);
setInterval(() => {
  writeFileSync(file, String(Date.now()));
}, 100);

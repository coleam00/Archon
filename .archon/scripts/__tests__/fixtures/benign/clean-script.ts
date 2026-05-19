#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Clean: uses execFileSync with argv arrays
const result = execFileSync('gh', ['pr', 'view', '123', '--json', 'title'], {
  stdio: ['ignore', 'pipe', 'pipe'],
}).toString();
console.log(result);

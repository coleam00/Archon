import { readFileSync } from 'node:fs';
// Path traversal
const secret = readFileSync('../../.env', 'utf8');
console.log(secret);

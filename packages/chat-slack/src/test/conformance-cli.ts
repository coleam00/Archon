import { resolve } from 'node:path';
import { conformance } from './conformance';
const binary = process.argv[2];
if (!binary) throw new Error('Usage: conformance-cli.ts <compiled-fixture>');
const violations = await conformance([resolve(binary)]);
if (violations.length) throw new Error(violations.join('\n'));
console.log('Slack compiled conformance passed.');

import { readFileSync } from 'node:fs';
import { invokeForge, parsePrRecord, record } from '../../.shared/forge.ts';
import { emit, refuse, text } from '../../.shared/io.ts';

try {
  const intent = record(JSON.parse(readFileSync(text(process.env.INPUTS_INTENT), 'utf8')));
  if (!intent) throw new Error('body intent must be a JSON object');
  const prior = parsePrRecord(JSON.parse(text(process.env.INPUTS_PR)));
  if (intent.change === false) emit(prior);
  else {
    const value = invokeForge('pr.edit-body', {
      ref: prior, body: readFileSync(String(intent.bodyPath), 'utf8'),
    });
    emit(parsePrRecord(record(value)?.pr));
  }
} catch (error) {
  refuse(`publish-pr-body: ${error instanceof Error ? error.message : String(error)}`);
}

import { readFileSync } from 'node:fs';
import { invokeForge, parseQualifiedPr, record } from '../../.shared/forge.ts';
import { emit, refuse, text } from '../../.shared/io.ts';

try {
  const target = text(process.env.INPUTS_PR);
  const result = {
    ready: JSON.parse(text(process.env.INPUTS_READY)) as boolean,
    action: text(process.env.INPUTS_ACTION),
    findings_summary: text(process.env.INPUTS_SUMMARY),
    report: JSON.parse(text(process.env.INPUTS_REPORT_POINTER)) as unknown,
  };
  if (target === '' || target === '{}') emit(result);
  else {
    const ref = parseQualifiedPr(target);
    const value = invokeForge('comment.upsert', {
      ref, marker: '<!-- archon-review-report -->',
      body: `<!-- archon-review-report -->\n${readFileSync(text(process.env.INPUTS_REPORT), 'utf8')}`,
    });
    const comment = record(value)?.comment;
    if (!record(comment)) throw new Error('forge returned no verified comment');
    emit(result);
  }
} catch (error) {
  refuse(`publish-review: ${error instanceof Error ? error.message : String(error)}`);
}

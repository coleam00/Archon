import { emit, nullableJson, refuse } from '../../.shared/io.ts';

try {
  const question = nullableJson(process.env.INPUTS_QUESTION);
  if (question === null) throw new Error('question is required');
  emit(question);
} catch (error) {
  refuse(`merge question: ${error instanceof Error ? error.message : String(error)}`);
}

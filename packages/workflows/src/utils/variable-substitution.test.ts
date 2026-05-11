import { substituteVariables } from './variable-substitution';

describe('substituteVariables', () => {
  test('replaces positional arguments', () => {
    const result = substituteVariables('Task: $1, Priority: $2', ['Fix bug', 'High']);
    expect(result).toBe('Task: Fix bug, Priority: High');
  });

  test('replaces $ARGUMENTS with all arguments', () => {
    const result = substituteVariables('Plan: $ARGUMENTS', ['Add', 'dark', 'mode']);
    expect(result).toBe('Plan: Add dark mode');
  });

  test('handles missing args gracefully', () => {
    const result = substituteVariables('$1, $2, $3', ['first']);
    expect(result).toBe('first, $2, $3');
  });

  test('handles escaped dollar signs', () => {
    const result = substituteVariables('Price: \\$50, Arg: $1', ['value']);
    expect(result).toBe('Price: $50, Arg: value');
  });

  test('returns unchanged text with no variables', () => {
    const result = substituteVariables('No variables here', []);
    expect(result).toBe('No variables here');
  });

  test('replaces multiple occurrences of same variable', () => {
    const result = substituteVariables('$1 is $1', ['important']);
    expect(result).toBe('important is important');
  });

  test('handles empty arguments array', () => {
    const result = substituteVariables('Command: $1', []);
    expect(result).toBe('Command: $1');
  });

  test('combines positional and $ARGUMENTS in same text', () => {
    const result = substituteVariables('First: $1, All: $ARGUMENTS', ['one', 'two', 'three']);
    expect(result).toBe('First: one, All: one two three');
  });

  test('handles arguments with special characters', () => {
    const result = substituteVariables('Query: $1', ['SELECT * FROM users WHERE id=$1']);
    expect(result).toBe('Query: SELECT * FROM users WHERE id=$1');
  });

  test('handles arguments with quotes', () => {
    const result = substituteVariables('Message: $1', ['"Hello World"']);
    expect(result).toBe('Message: "Hello World"');
  });
});

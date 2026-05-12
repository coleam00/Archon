/**
 * Substitutes variables in command text with provided arguments
 *
 * Supported variables:
 * - $1, $2, $3, ..., $9 - Positional arguments
 * - $ARGUMENTS - All arguments as a single string
 * - \$ - Escaped dollar sign (becomes $)
 *
 * @param text - The command text containing variables
 * @param args - Array of argument values
 * @param _metadata - Optional metadata for future variable expansion (currently unused)
 * @returns Text with variables replaced by their values
 */
export function substituteVariables(
  text: string,
  args: string[],
  _metadata: Record<string, unknown> = {}
): string {
  let result = text;

  // Replace positional args $1-$9
  args.forEach((arg, index) => {
    result = result.replace(new RegExp(`\\$${String(index + 1)}`, 'g'), arg);
  });

  // Replace $ARGUMENTS with all arguments as single string
  result = result.replace(/\$ARGUMENTS/g, args.join(' '));

  // Replace escaped dollar signs
  result = result.replace(/\\\$/g, '$');

  return result;
}

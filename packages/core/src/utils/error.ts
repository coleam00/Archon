export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === 'string') {
    return new Error(error);
  }

  try {
    const serialized = JSON.stringify(error);
    if (serialized !== undefined) {
      return new Error(serialized);
    }
  } catch {
    // Fall through to String() fallback
  }

  return new Error(String(error));
}

import { toError } from '../utils/error';

export async function withRunLiveOwnerCleanup<T>(
  close: () => Promise<void>,
  body: () => Promise<T>
): Promise<T> {
  let result: T;
  try {
    result = await body();
  } catch (error) {
    try {
      await close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        `${toError(error).message} Live owner shutdown failed: ${toError(closeError).message}`
      );
    }
    throw error;
  }
  await close();
  return result;
}

import { describe, expect, test } from 'bun:test';

import { isCursorHttp2TailError } from './bun-http2-guard';

describe('isCursorHttp2TailError', () => {
  test('matches Error message', () => {
    expect(isCursorHttp2TailError(new Error('NGHTTP2_FRAME_SIZE_ERROR'))).toBe(true);
  });

  test('matches ConnectError-style rawMessage', () => {
    expect(
      isCursorHttp2TailError({
        name: 'ConnectError',
        rawMessage: 'Stream closed with error code NGHTTP2_FRAME_SIZE_ERROR',
      })
    ).toBe(true);
  });

  test('rejects unrelated errors', () => {
    expect(isCursorHttp2TailError(new Error('something else'))).toBe(false);
  });
});

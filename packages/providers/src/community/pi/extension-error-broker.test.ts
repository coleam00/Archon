import { afterEach, describe, expect, test } from 'bun:test';

import {
  beginPiExtensionTurn,
  claimPiExtensionProcessError,
  piExtensionFailureEvidence,
  type PiExtensionTurn,
} from './extension-error-broker';

let openTurn: PiExtensionTurn | undefined;

afterEach(() => {
  openTurn?.close();
  openTurn = undefined;
});

describe('Pi extension process-error broker', () => {
  test('claims a stack-attested extension error without replacing it', async () => {
    openTurn = await beginPiExtensionTurn(['/extensions/fake-extension.ts']);
    let received: Error | undefined;
    openTurn.onError(error => {
      received = error;
    });
    const error = new Error('timer exploded');
    error.stack =
      'Error: timer exploded\n    at callback (/extensions/fake-extension.ts:4:2)\n    at timer (bun:1:1)';

    expect(claimPiExtensionProcessError(error)).toBe(true);
    expect(received).toBe(error);
    expect(piExtensionFailureEvidence(error)).toBe(error.stack);
  });

  test('leaves unmatched and unstructured process errors unclaimed', async () => {
    openTurn = await beginPiExtensionTurn(['/extensions/fake-extension.ts']);
    let received = false;
    openTurn.onError(() => {
      received = true;
    });
    const archonError = new Error('engine bug');
    archonError.stack = 'Error: engine bug\n    at execute (/archon/dag-executor.ts:1:1)';

    expect(claimPiExtensionProcessError(archonError)).toBe(false);
    expect(claimPiExtensionProcessError('plain rejection')).toBe(false);
    expect(received).toBe(false);
  });

  test('stops claiming when the turn closes', async () => {
    openTurn = await beginPiExtensionTurn(['/extensions/fake-extension.ts']);
    openTurn.close();
    openTurn = undefined;
    const error = new Error('late timer');
    error.stack = 'Error: late timer\n    at callback (/extensions/fake-extension.ts:4:2)';

    expect(claimPiExtensionProcessError(error)).toBe(false);
  });

  test('stops claiming before a successful terminal result is exposed', async () => {
    openTurn = await beginPiExtensionTurn(['/extensions/fake-extension.ts']);
    openTurn.stopAccepting();
    const error = new Error('late timer');
    error.stack = 'Error: late timer\n    at callback (/extensions/fake-extension.ts:4:2)';

    expect(claimPiExtensionProcessError(error)).toBe(false);
  });

  test('preserves structured Pi extension evidence', async () => {
    openTurn = await beginPiExtensionTurn(['/extensions/fake-extension.ts']);
    let received: Error | undefined;
    openTurn.onError(error => {
      received = error;
    });

    openTurn.reportStructured({
      extensionPath: '/extensions/fake-extension.ts',
      event: 'tool_call',
      error: 'handler exploded',
      stack: 'Error: handler exploded\n    at handler (/extensions/fake-extension.ts:9:3)',
    });

    expect(received?.message).toContain('/extensions/fake-extension.ts');
    expect(received && piExtensionFailureEvidence(received)).toContain(
      'Error: handler exploded\n    at handler (/extensions/fake-extension.ts:9:3)'
    );
  });

  test('serializes extension-enabled turns process-wide', async () => {
    const first = await beginPiExtensionTurn(['/extensions/first.ts']);
    openTurn = first;
    let secondStarted = false;
    const secondPending = beginPiExtensionTurn(['/extensions/second.ts']).then(turn => {
      secondStarted = true;
      return turn;
    });
    // A macrotask drains every pending microtask, so an ungated second turn would have started.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(secondStarted).toBe(false);

    first.close();
    openTurn = await secondPending;
    expect(secondStarted).toBe(true);
  });
});

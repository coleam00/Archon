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
  test('claims a stack-attested extension error without replacing it', () => {
    openTurn = beginPiExtensionTurn(['/extensions/fake-extension.ts']);
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

  test('leaves unmatched and unstructured process errors unclaimed', () => {
    openTurn = beginPiExtensionTurn(['/extensions/fake-extension.ts']);
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

  test('stops claiming when the turn closes', () => {
    openTurn = beginPiExtensionTurn(['/extensions/fake-extension.ts']);
    openTurn.close();
    openTurn = undefined;
    const error = new Error('late timer');
    error.stack = 'Error: late timer\n    at callback (/extensions/fake-extension.ts:4:2)';

    expect(claimPiExtensionProcessError(error)).toBe(false);
  });

  test('stops claiming before a successful terminal result is exposed', () => {
    openTurn = beginPiExtensionTurn(['/extensions/fake-extension.ts']);
    openTurn.stopAccepting();
    const error = new Error('late timer');
    error.stack = 'Error: late timer\n    at callback (/extensions/fake-extension.ts:4:2)';

    expect(claimPiExtensionProcessError(error)).toBe(false);
  });

  test('preserves structured Pi extension evidence', () => {
    openTurn = beginPiExtensionTurn(['/extensions/fake-extension.ts']);
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

  test('routes a detached error to the only active turn that loaded the extension', () => {
    const first = beginPiExtensionTurn(['/extensions/first.ts']);
    const second = beginPiExtensionTurn(['/extensions/second.ts']);
    try {
      const received: string[] = [];
      first.onError(() => received.push('first'));
      second.onError(() => received.push('second'));
      const error = new Error('timer exploded');
      error.stack = 'Error: timer exploded\n    at callback (/extensions/second.ts:4:2)';

      expect(claimPiExtensionProcessError(error)).toBe(true);
      expect(received).toEqual(['second']);
    } finally {
      first.close();
      second.close();
    }
  });

  test('a loaded path that prefixes another file does not claim that file', () => {
    const fileTurn = beginPiExtensionTurn(['/extensions/ext.ts']);
    const dirTurn = beginPiExtensionTurn(['/extensions/bench']);
    try {
      const received: string[] = [];
      fileTurn.onError(() => received.push('file'));
      dirTurn.onError(() => received.push('dir'));
      const unrelated = new Error('other file');
      unrelated.stack =
        'Error: other file\n    at callback (/extensions/ext.tsx:4:2)\n' +
        '    at timer (/extensions/bench-two/index.ts:1:1)';
      expect(claimPiExtensionProcessError(unrelated)).toBe(false);

      // A file inside a directory extension, and a file:// frame, still belong to it.
      const inDir = new Error('dir helper');
      inDir.stack = 'Error: dir helper\n    at helper (file:///extensions/bench/lib/util.ts:2:1)';
      expect(claimPiExtensionProcessError(inDir)).toBe(true);
      expect(received).toEqual(['dir']);
    } finally {
      fileTurn.close();
      dirTurn.close();
    }
  });

  test('fails every candidate turn when concurrent turns loaded the same extension', () => {
    const first = beginPiExtensionTurn(['/extensions/shared.ts']);
    const second = beginPiExtensionTurn(['/extensions/shared.ts']);
    const unrelated = beginPiExtensionTurn(['/extensions/other.ts']);
    try {
      const received: { owner: string; error: Error }[] = [];
      first.onError(error => received.push({ owner: 'first', error }));
      second.onError(error => received.push({ owner: 'second', error }));
      unrelated.onError(error => received.push({ owner: 'unrelated', error }));
      const error = new Error('timer exploded');
      error.stack = 'Error: timer exploded\n    at callback (/extensions/shared.ts:4:2)';

      expect(claimPiExtensionProcessError(error)).toBe(true);
      expect(received.map(r => r.owner)).toEqual(['first', 'second']);
      for (const { error: reported } of received) {
        // Each node is told the failure is ambiguous, not that it owns it.
        expect(reported.message).toContain('2 concurrent Pi turns');
        expect(reported.cause).toBe(error);
        expect(piExtensionFailureEvidence(reported)).toContain(error.stack);
      }
    } finally {
      first.close();
      second.close();
      unrelated.close();
    }
  });
});

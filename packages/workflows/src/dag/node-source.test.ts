import { describe, expect, it } from 'bun:test';
import { ParentStatusReadError } from '../parent-status-read';
import { NodeEventWriteError } from '../node-event-write';
import { TerminalStatusWriteError } from '../terminal-status-write';
import { RunSourceUnreadableError, settledValuesOrThrow } from './node-source';

describe('settled execution errors', () => {
  const statusError = new ParentStatusReadError('run', 'fan', new Error('unknown status'));
  const writeErrors = [
    new TerminalStatusWriteError(new Error('terminal write rejected')),
    new NodeEventWriteError(
      { workflow_run_id: 'run', event_type: 'node_completed', step_name: 'peer', data: {} },
      new Error('node write rejected')
    ),
  ];

  for (const writeError of writeErrors) {
    it(`preserves ${writeError.name} ahead of ${statusError.name} in either order`, () => {
      for (const errors of [
        [statusError, writeError],
        [writeError, statusError],
      ]) {
        expect(() =>
          settledValuesOrThrow(
            errors.map(reason => ({ status: 'rejected', reason })),
            'run'
          )
        ).toThrow(writeError);
      }
    });
  }

  it(`keeps ${statusError.name} ahead of a source release in either order`, () => {
    const sourceError = new RunSourceUnreadableError('peer', new Error('source unavailable'));
    for (const errors of [
      [sourceError, statusError],
      [statusError, sourceError],
    ]) {
      expect(() =>
        settledValuesOrThrow(
          errors.map(reason => ({ status: 'rejected', reason })),
          'run'
        )
      ).toThrow(statusError);
    }
  });
});

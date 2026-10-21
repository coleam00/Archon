import { expect, it, mock } from 'bun:test';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';

function controlledCommand(deliveryError?: Error) {
  const completion = Promise.withResolvers<{ stdout: string; stderr: string }>();
  const chunks: Buffer[] = [];
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback(deliveryError);
    },
  });
  return {
    ...completion,
    chunks,
    stdin,
    pending: Object.assign(completion.promise, { child: { stdin } }),
  };
}

let command: ReturnType<typeof controlledCommand>;
const execute = mock(() => command.pending);
// execFile's promisify hook returns a promise carrying the child's stdin stream.
mock.module('child_process', () => ({
  execFile: Object.assign(() => {}, { [promisify.custom]: execute }),
}));
const { execFileAsync } = await import('./exec');

it.each(['delivered', 'delivery error', 'command error'] as const)(
  'settles controlled stdin delivery before child completion: %s',
  async outcome => {
    const deliveryError =
      outcome === 'delivered'
        ? undefined
        : Object.assign(new Error('stdin failed'), { code: 'EPIPE' });
    command = controlledCommand(deliveryError);
    const delivered = once(command.stdin, deliveryError ? 'error' : 'finish');
    const output = { stdout: 'child output', stderr: 'child diagnostics' };
    const commandError = Object.assign(new Error('command failed'), { code: 7, ...output });
    const input = '€\n';
    const pending = execFileAsync('controlled-command', [], { input });

    const observed = await delivered;
    expect(Buffer.concat(command.chunks).toString('utf8')).toBe(input);
    if (deliveryError) expect(observed[0]).toBe(deliveryError);

    if (outcome === 'command error') {
      command.reject(commandError);
      await expect(pending).rejects.toBe(commandError);
    } else if (deliveryError) {
      command.resolve(output);
      await expect(pending).rejects.toBe(deliveryError);
      expect(deliveryError).toMatchObject(output);
    } else {
      command.resolve(output);
      expect(await pending).toEqual(output);
    }
  }
);

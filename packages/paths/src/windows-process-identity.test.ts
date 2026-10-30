import { expect, mock, test } from 'bun:test';
import { win32 } from 'node:path';
import { readWindowsProcessIdentity } from './windows-process-identity';

const pid = 123;
const creationTicks = '638974102551234567';

test('queries only the target identity with bounded, profile-free PowerShell', async () => {
  const exec = mock(
    async (
      _executable: string,
      _args: string[],
      _options: { windowsHide: true; timeout: number; maxBuffer: number }
    ) => ({
      stdout: JSON.stringify({ pid, status: 'observed', creationTicks, commandLine: 'secret' }),
    })
  );
  const result = await readWindowsProcessIdentity(pid, exec);
  expect(result).toEqual({ pid, status: 'observed', creationTicks });
  expect(exec).toHaveBeenCalledTimes(1);
  const [executable, args, options] = exec.mock.calls[0];
  expect(win32.isAbsolute(executable)).toBe(true);
  expect(executable).toEndWith('powershell.exe');
  expect(options).toEqual({ windowsHide: true, timeout: 5000, maxBuffer: 16384 });
  expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = Buffer.from(args[3], 'base64').toString('utf16le');
  expect(script).toContain('$targetPid = 123');
  expect(script).toContain('GetProcessById($targetPid)');
  expect(script).toContain('StartTime.ToUniversalTime().Ticks.ToString');
  expect(script).toContain('$proc.Dispose()');
  expect(script).not.toMatch(/CommandLine|ProcessName|Get-CimInstance|Get-Process/i);
});

test.each([
  { pid, status: 'absent' },
  { pid, status: 'unavailable', code: 5 },
])('retains structured observation %p', async observation => {
  expect(
    await readWindowsProcessIdentity(pid, async () => ({
      stdout: Buffer.from(JSON.stringify(observation)),
    }))
  ).toEqual(observation);
});

test.each([
  'not JSON',
  'null',
  '{}',
  JSON.stringify({ pid: 124, status: 'absent' }),
  JSON.stringify({ pid, status: 'observed', creationTicks: Number(creationTicks) }),
  JSON.stringify({ pid, status: 'observed', creationTicks: 'secret' }),
  JSON.stringify({ pid, status: 'unavailable', code: 'secret' }),
])('rejects malformed identity output %p', async stdout => {
  expect(await readWindowsProcessIdentity(pid, async () => ({ stdout }))).toEqual({
    pid,
    status: 'unavailable',
    code: 'INVALID_OUTPUT',
  });
});

test.each(['ENOENT', 'ETIMEDOUT', 1, undefined])('retains capture failure code %p', async code => {
  expect(
    await readWindowsProcessIdentity(pid, async () => {
      throw Object.assign(new Error('secret'), { code });
    })
  ).toEqual({ pid, status: 'unavailable', code: code ?? null });
});

test.each([0, -1, 1.5, Number.NaN, 2_147_483_648])(
  'does not interpolate invalid PID %p',
  async pid => {
    const exec = mock(async () => ({ stdout: '' }));
    expect(await readWindowsProcessIdentity(pid, exec)).toEqual({
      pid,
      status: 'unavailable',
      code: 'INVALID_PID',
    });
    expect(exec).not.toHaveBeenCalled();
  }
);

test.skipIf(process.platform !== 'win32')(
  'native query observes the same live incarnation twice',
  async () => {
    const first = await readWindowsProcessIdentity(process.pid);
    expect(first.status).toBe('observed');
    expect(await readWindowsProcessIdentity(process.pid)).toEqual(first);
  }
);

test.skipIf(process.platform !== 'win32')(
  'native query observes a reaped fixture as absent',
  async () => {
    const child = Bun.spawn([process.execPath, '-e', '']);
    await child.exited;
    expect(await readWindowsProcessIdentity(child.pid)).toEqual({
      pid: child.pid,
      status: 'absent',
    });
  }
);

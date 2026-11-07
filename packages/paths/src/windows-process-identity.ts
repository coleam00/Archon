import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type WindowsProcessIdentity =
  | { pid: number; status: 'observed'; creationTicks: string }
  | { pid: number; status: 'absent' }
  | { pid: number; status: 'unavailable'; code: string | number | null };

type IdentityExec = (
  executable: string,
  args: string[],
  options: { windowsHide: true; timeout: number; maxBuffer: number }
) => Promise<{ stdout: string | Buffer }>;

export async function readWindowsProcessIdentity(
  pid: number,
  exec: IdentityExec = execFileAsync
): Promise<WindowsProcessIdentity> {
  const unavailable = (code: string | number | null): WindowsProcessIdentity => ({
    pid,
    status: 'unavailable',
    code,
  });
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2_147_483_647) {
    return unavailable('INVALID_PID');
  }
  const script = `
$ErrorActionPreference = 'Stop'
$targetPid = ${pid}
$proc = $null
$phase = 'lookup'
try {
  $proc = [System.Diagnostics.Process]::GetProcessById($targetPid)
  $phase = 'start_time'
  $ticks = $proc.StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture)
  $result = @{ pid = $targetPid; status = 'observed'; creationTicks = $ticks }
} catch {
  $base = $_.Exception.GetBaseException()
  if ($phase -eq 'lookup' -and $base -is [System.ArgumentException]) {
    $result = @{ pid = $targetPid; status = 'absent' }
  } else {
    $code = $base.HResult
    if ($base -is [System.ComponentModel.Win32Exception]) { $code = $base.NativeErrorCode }
    $result = @{ pid = $targetPid; status = 'unavailable'; code = $code }
  }
} finally {
  if ($null -ne $proc) { $proc.Dispose() }
}
ConvertTo-Json -Compress -InputObject $result
`;
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  let stdout: string | Buffer;
  try {
    ({ stdout } = await exec(
      join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, timeout: 5_000, maxBuffer: 16 * 1024 }
    ));
  } catch (error) {
    return unavailable(
      typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (typeof error.code === 'string' || typeof error.code === 'number')
        ? error.code
        : null
    );
  }
  return decodeIdentity(stdout.toString().trim(), pid);
}

function decodeIdentity(stdout: string, pid: number): WindowsProcessIdentity {
  const unavailable = (): WindowsProcessIdentity => ({
    pid,
    status: 'unavailable',
    code: 'INVALID_OUTPUT',
  });
  try {
    const result: unknown = JSON.parse(stdout);
    if (
      typeof result !== 'object' ||
      result === null ||
      !('pid' in result) ||
      result.pid !== pid ||
      !('status' in result)
    ) {
      return unavailable();
    }
    if (result.status === 'absent') return { pid, status: 'absent' };
    if (
      result.status === 'observed' &&
      'creationTicks' in result &&
      typeof result.creationTicks === 'string' &&
      /^[0-9]+$/.test(result.creationTicks)
    ) {
      return { pid, status: 'observed', creationTicks: result.creationTicks };
    }
    if (
      result.status === 'unavailable' &&
      'code' in result &&
      typeof result.code === 'number' &&
      Number.isInteger(result.code)
    ) {
      return { pid, status: 'unavailable', code: result.code };
    }
    return unavailable();
  } catch {
    return unavailable();
  }
}

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { terminateTree } from '@archon/paths/plugin-process';

const execFileAsync = promisify(execFile);

/** Stop descendants after their app-server has exited, including reparented processes. */
export async function stopAppServerDescendants(
  pid: number,
  startedAt: number,
  exitedAt: number
): Promise<void> {
  if (process.platform !== 'win32') {
    await terminateTree(pid);
    return;
  }
  // taskkill /T cannot find a tree whose root has exited. Windows retains parent IDs;
  // creation times exclude children of a reused root PID. Hold each process handle
  // before checking its identity so PID reuse cannot redirect the eventual kill.
  const script = `
$ErrorActionPreference = 'Stop'
$started = [DateTimeOffset]::FromUnixTimeMilliseconds(${startedAt}).UtcDateTime
$exited = [DateTimeOffset]::FromUnixTimeMilliseconds(${exitedAt}).UtcDateTime
$rows = @(Get-CimInstance Win32_Process)
$owned = [System.Collections.Generic.List[object]]::new()
function Find-Children($parentId, $parentStart, $parentEnd) {
  foreach ($row in $rows) {
    if ($row.ParentProcessId -ne $parentId) { continue }
    $created = $row.CreationDate.ToUniversalTime()
    if ($created -lt $parentStart -or $created -gt $parentEnd) { continue }
    $process = $null
    try {
      $process = [System.Diagnostics.Process]::GetProcessById($row.ProcessId)
      $null = $process.Handle
      $actual = $process.StartTime.ToUniversalTime()
      if ([Math]::Abs(($actual - $created).Ticks) -ge 10) {
        throw "Process identity changed during Codex cleanup: $($row.ProcessId)"
      }
    } catch {
      if (($null -ne $process -and $process.HasExited) -or
          ($null -eq $process -and $_.Exception.InnerException -is [ArgumentException])) {
        if ($null -ne $process) { $process.Dispose() }
        $process = $null
      } else {
        if ($null -ne $process) { $process.Dispose() }
        throw
      }
    }
    if ($null -ne $process) { $owned.Add($process) }
    Find-Children $row.ProcessId $created ([DateTime]::UtcNow)
  }
}
try {
  Find-Children ${pid} $started $exited
  foreach ($process in $owned) {
    try { if (!$process.HasExited) { $process.Kill() } }
    catch { if (!$process.HasExited) { throw } }
  }
  foreach ($process in $owned) {
    if (!$process.WaitForExit(1000)) { throw "Codex descendant did not exit: $($process.Id)" }
  }
} finally {
  foreach ($process in $owned) { $process.Dispose() }
}
`;
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  await execFileAsync(
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { windowsHide: true, timeout: 5000 }
  );
}

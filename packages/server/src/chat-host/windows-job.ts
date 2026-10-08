import { join } from 'node:path';

// taskkill cannot recover a tree after its root exits. A job-owning launcher keeps
// descendants attached even then; its non-inherited handle kills them on exit.
const launcher = String.raw`
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class ChatJob {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations;
    public ulong ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  public static void Run(string executable, string arguments) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    var limits = new ExtendedLimits();
    limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    // Join before launching: every descendant inherits membership without a spawn/assign race.
    if (!AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    var child = Process.Start(new ProcessStartInfo(executable, arguments) { UseShellExecute = false });
    child.WaitForExit();
    // Keep the job handle until process exit; explicitly closing it would kill this launcher too.
    Environment.Exit(child.ExitCode);
  }
}
`;

function quoteArgument(value: string): string {
  // Windows CommandLineToArgvW escaping, including quotes and trailing backslashes.
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

function encodedLiteral(value: string): string {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString('base64')}'))`;
}

export function windowsJobCommand(argv: readonly [string, ...string[]]): [string, ...string[]] {
  const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${launcher}\n'@\n[ChatJob]::Run(${encodedLiteral(argv[0])}, ${encodedLiteral(argv.slice(1).map(quoteArgument).join(' '))})`;
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
  return [
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ];
}

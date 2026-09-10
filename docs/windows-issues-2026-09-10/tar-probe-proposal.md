# Issue 3286 first-tar diagnostic proposal

Status: prepared, not executed. These are throwaway evidence tools, not a proposed production patch.

## Suspected boundary and limits of prior evidence

Source `downloadWebDist` awaits `proc.exited` and stderr EOF concurrently. The issue trace proves neither completion was delivered to JS before Bun's 5s test reaper; it does not establish the OS lifetime or wait stack of tar. The 60s product timer was not due, so its failure to fire is not a timer defect. No source change or skip removal is justified yet.

Bun 1.4.2 source maps `Bun.file(path)` to Stdio::Path, opens it synchronously with uv_fs_open and supplies UV_INHERIT_FD before uv_spawn. There is no parent-pumped byte stdin here. The measured spawn span includes resolveTarBin, file open, stdio setup and process creation. Windows exit delivery arrives via Process::on_exit_uv on Bun's libuv loop before the JS exited promise. Production also has an implicit stdout pipe that is never read; successful nonverbose tar normally emits no stdout, so it is a variable to measure, not a proven deadlock.

Primary source:
- https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/runtime/api/bun/spawn/stdio.rs
- https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/spawn/process.rs
- https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/runtime/api/bun/subprocess.rs
- https://github.com/coleam00/Archon/issues/3286

## One controlled sample

Wait for the root agent's measurement window. No tar fixture generation or warmup first.

Run from PowerShell:

```powershell
& 'C:\Users\Leex279\.archon\workspaces\coleam00\Archon\artifacts\windows-issues-20260910\observe-tar.ps1' -RunLabel baseline
```

The wrapper explicitly launches the supplied Bun 1.4.2 hidden, with its directory first on PATH. It executes one real-production extraction from the CLI package directory. The synthetic fixture is copied from the source test builder and created in memory, so this really is the process's first tar spawn. It preserves the production function, default stdout pipe, Bun.file input, stderr drain, normal 5000ms test budget and 60000ms product timer. The embedded hash path is selected; network responses are local mocks. A spawn spy records argv/options/PID and an extra exited observer. The source function's existing phase logs remain available.

Artifacts are unique `tar-<timestamp>-<label>` directories. `parent.jsonl` records Bun identity, fixture hash/size, spawn duration, 100ms heartbeat and exit delivery. `observer.jsonl` comes from a separate PowerShell process, opens and retains the exact tar Process handle, records its actual image, OS exit time/code, CPU, coarse thread state/wait reason and partial/output-file existence. stdout/stderr are separate logs. No repository source is edited. The wrapper enforces a 15s external bound only on these owned PIDs and preserves all artifacts. It does not change any test timeout.

This observer can miss a healthy tar that exits before the 25ms poll opens its handle; that appears explicitly as `tar_handle_unavailable`. It cannot miss a multi-second tar stall after the PID is published. Coarse thread wait reason is not a native wait stack. Synchronous heartbeat file writes and external polling add observation overhead; sample timings are instrumented measurements, not an uncontaminated throughput benchmark. This probe intentionally retains the issue test's spy wrapper shape, but it omits unrelated checksum/source-server cases and module mocks; a failure is strong boundary evidence, while passes alone do not clear the skip.

## Interpretation

- Tar OS-exit precedes JS exit by seconds, with parent heartbeat advancing: Bun/libuv exit delivery or pipe completion boundary. Capture parent native stack/ETW next.
- Tar OS-exit precedes JS exit, and heartbeat stops: parent event-loop/thread starvation or blocking boundary. Capture parent native stack and scheduler evidence next.
- Tar stays OS-alive with no output file, heartbeat advances: inspect native tar stack to distinguish loader/image activation, stdin ReadFile or filesystem operations. Process Monitor/ETW must start before the next sample to see early loader work.
- Tar stays OS-alive with complete file: inspect tar teardown/pipe/handle wait and stdout/stderr state.
- Both tar CPU and parent heartbeat stop or are delayed together: compare OS scheduler timing and bounded controlled contention; do not label this environmental from green reruns alone.

Only after the baseline identifies a boundary, use fresh processes and alternate one variable at a time: same tar with explicit stdout ignore; same tar reading relative archive filename with cwd set and stdin ignore (avoids drive-letter archive syntax); or Node/native launch with the same descriptors. Compare no mock versus the inherited spy wrapper if the standalone boundary cannot reproduce the actual test. Do not replace the current implementation until a failing observation and the causal change agree.

The local Windows 11 build 26200 / Ryzen 9950X is not the Windows hosted-runner image. An inability to reproduce locally leaves issue 3286 unresolved and does not establish an environmental cause.

# Windows tar investigation results — issue 3286

Recorded 2026-09-10, 14:30–14:33 UTC. No Archon source files changed; the two Windows success-test skips remain. No workflow was launched and nothing was posted to GitHub.

## Result

The historical >=5s first-tar stall did not recur in this finite local experiment. The cause remains unestablished. Green samples do not justify removing the skips or declaring the issue environmental.

20 fresh-process extraction probes passed using the current production `downloadWebDist`, a locally mocked fetch, the source test's 129-byte archive and verified `<html>ok</html>` file contents. Bun was exactly 1.4.2 revision `744846f844374847c902b5e7fd59b4342a51ef99`. Every recorded command resolved `C:\WINDOWS\System32\tar.exe`. Actual OS image observation confirmed that path in the two slowed samples. Fixtures were generated in memory, so each measured extraction was that Bun process's first real tar.

- 11 unrestricted samples: verified at 20.94–29.35ms from probe-module start, spawn 2.98–6.47ms, child/JS completion wait 5.44–7.29ms.
- One four-logical-CPU affinity control: verified at 23.28ms, spawn 3.58ms, child/JS wait 5.92ms.
- A bounded ten-second load used eight Bun Worker threads on those same four logical CPUs. Eight fresh probes were launched sequentially; only the first two extractions actually overlapped the load. They passed at 2035.57ms and 2073.66ms test duration. Their spawn calls still took 3.52/3.54ms, and child/JS waits 321.15/274.61ms. Startup and pre-tar work account for most of the delay, unlike the historical 3ms staging plus 266ms spawn trace.
- The third load-labelled probe was delayed at process startup but began its extraction after the load stopped; the remaining six extractions took ~22ms. They are not eight loaded extraction samples.

## Boundary observation

For load samples 1 and 2, the external observer obtained the exact tar process handle. Before output creation, tar was OS-alive, reported zero accumulated CPU, and had a thread in coarse `Wait/Executive` state. That state does not identify a native wait stack or prove loader, filesystem or stdin ownership.

The observer reported OS exit code 0 at 14:33:16.902Z / 14:33:20.992Z. Bun delivered `proc.exited` to JS at 14:33:16.998Z / 14:33:21.054Z. Thus OS exit was observed at least approximately 96/62ms before JS completion under this artificial scheduling load. Heartbeats continued with delayed cadence. This demonstrates that JS completion time alone is not the tar OS lifetime; it is not a reproduction of the issue's multi-second stall.

The .NET `Process.ExitTime` property returned a zero FILETIME (1601-01-01) for those two observations. That field is discarded as invalid in the summary. The times above are the external observer's UTC event times, not claimed exact kernel exit timestamps.

## Instrument limitations and fixes

Two unrestricted runs had observer-only errors after their tar tests passed: a default file-sharing mode collided with the parent appending its log, and an optional `Process.ExitTime` was absent after a very fast child exit. The diagnostic observer was corrected to use ReadWrite/Delete sharing and tolerate missing exit time. Those runs retain passing parent/test evidence but incomplete OS-observer evidence. The JSON summary flags `observerCompleted=false` for them. Healthy children often exit before the 25ms observer poll opens a handle; this is recorded explicitly rather than interpreted as a hang.

The probe uses the current production function and the issue test's spawn-spy shape, but omits unrelated cases and module mocks. The external observer and parent heartbeat create measurement overhead. The local Windows 11 build 26200 / Ryzen 9950X host differs from Windows CI. All own diagnostic processes and the bounded load exited; no wall-bound kill was required.

## Established source facts and next discriminating step

Pinned Bun source establishes that `Bun.file(path)` becomes a path stdio entry, synchronously opened with `uv_fs_open` and handed to the child as an inherited descriptor. The existing measured spawn span also includes tar resolution, opening that archive and stdio setup; it is not a pure CreateProcess duration. Windows child exit is delivered through `Process::on_exit_uv` on Bun's libuv loop and only then the JS promise. A stderr EOF promise supplies completion evidence, not an observation of whether tar wrote any bytes before exit.

The first decisive next artifact is a native stack/ETW or Process Monitor capture of an actual slow first tar, correlated with exact PID OS liveness, parent heartbeat, file creation and both JS completions. If tar stays alive, inspect its wait stack; if the OS child has exited while JS waits, inspect Bun's parent loop/pipe/exit path. Only then compare one relevant variable (stdout sink, direct archive path, runtime launch API) at a time. Current evidence does not justify a timeout increase, additional workaround or skip removal.

The newer CI corrupt-archive sample reported by the sibling CI investigation exits normally before the timeout is reported (spawn ~2022ms, child/stderr ~3795ms). It should be recorded separately from the historical SIGTERM/reaper trace. Moving the first tar exposure to a corrupt archive supports measuring process startup/completion boundaries, but does not by itself establish a common cause.

## Evidence files

- `tar-probe-results.json`: all 20 runs and observation-completeness flags.
- `tar-20260910-163021-446-baseline/`: first untouched local sample.
- `tar-20260910-163312-558-affinity4-control/`: affinity-only control.
- `tar-20260910-163313-209-affinity4-load-1/` and `tar-20260910-163317-263-affinity4-load-2/`: slowed overlapping samples, each with parent/observer JSONL and process stdout/stderr.
- `tar-load.stdout.jsonl`: bounded load start/end, own PID 44216 and deadline.
- `tar-first.test.ts`, `observe-tar.ps1`, `bounded-cpu-load.ts`: exact throwaway instruments.
- `tar-probe-proposal.md`: original reasoning and interpretation plan (its prepared/not-executed status describes the pre-measurement checkpoint).

Primary Bun sources:
- https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/runtime/api/bun/spawn/stdio.rs
- https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/spawn/process.rs
- https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/runtime/api/bun/subprocess.rs

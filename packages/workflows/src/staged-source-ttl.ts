/**
 * How long an unadopted staging directory survives before it is reclaimed.
 *
 * Generous on purpose: it must comfortably exceed the gap between capturing and adopting,
 * which spans discovery, isolation, and — for `--detach` — a child process starting. Not a
 * timeout on anything; adoption MOVES the capture out of staging, so anything still here
 * after this long belongs to no run.
 *
 * Its own module so run-file cleanup can share the margin without importing `run-source`,
 * which many tests mock whole.
 */
export const STAGED_SOURCE_TTL_MS = 6 * 60 * 60 * 1000;

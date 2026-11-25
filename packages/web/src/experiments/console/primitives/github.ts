/** The poll loop's next action: stop (connected), keep polling, or fail with a message. */
export type PollStep =
  | { kind: 'connected' }
  | { kind: 'retry'; nextInterval: number }
  | { kind: 'failed'; message: string };

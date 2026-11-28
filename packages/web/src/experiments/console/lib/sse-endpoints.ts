export const DASHBOARD_SSE_PATH = '/api/stream/__dashboard__';
/**
 * `protocol` sends every line, each with what it `needs`, and `ready` once the open set has been
 * sent; `quiet` would drop `ready`, and the console needs it to tell the replay from changes.
 */
export const ATTENTION_SSE_PATH = '/api/runs/attention/stream?level=protocol';

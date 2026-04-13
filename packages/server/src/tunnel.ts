/**
 * Cloudflare Quick Tunnel service.
 * Spawns `cloudflared tunnel --url http://localhost:<port>` and parses the
 * public trycloudflare.com URL from its output.
 *
 * Compatible with cloudflared v2025+ which outputs the URL inside an ASCII box
 * on stderr, prefixed with ANSI color codes and a timestamp log prefix.
 */
import { spawn, type ChildProcess } from 'child_process';

interface TunnelState {
  process: ChildProcess | null;
  url: string | null;
  status: 'inactive' | 'starting' | 'active' | 'error';
}

const state: TunnelState = { process: null, url: null, status: 'inactive' };

/** Strip ANSI escape codes from a string */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[mGKHF]/g, '');
}

/** Multiple URL patterns to handle different cloudflared output formats */
const URL_PATTERNS: RegExp[] = [
  // Direct URL anywhere in the line (all versions)
  /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
  // "Visit it at: <url>" format (v2025+)
  /Visit it at[^:]*:\s*(https:\/\/\S+trycloudflare\.com)/i,
  // JSON log format: {"url":"https://..."}
  /"url"\s*:\s*"(https:\/\/[^"]+trycloudflare\.com)"/,
];

/** Extract a trycloudflare.com URL from a chunk of text (after stripping ANSI) */
function extractUrl(raw: string): string | null {
  const text = stripAnsi(raw);
  for (const pattern of URL_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      // If the pattern has a capture group, use group 1; otherwise use the full match
      return match[1] ?? match[0];
    }
  }
  return null;
}

export function getTunnelState(): { url: string | null; status: TunnelState['status'] } {
  return { url: state.url, status: state.status };
}

export async function startTunnel(port = 5173): Promise<void> {
  if (state.process) return;
  state.status = 'starting';
  state.url = null;

  const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  state.process = proc;

  // Accumulate output to handle multi-chunk delivery
  let stdoutBuffer = '';
  let stderrBuffer = '';

  const handleChunk = (buffer: string, chunk: Buffer): string => {
    buffer += chunk.toString();
    if (!state.url) {
      const url = extractUrl(buffer);
      if (url) {
        state.url = url;
        state.status = 'active';
      }
    }
    return buffer;
  };

  proc.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuffer = handleChunk(stdoutBuffer, chunk);
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuffer = handleChunk(stderrBuffer, chunk);
  });

  proc.on('exit', () => {
    state.process = null;
    state.url = null;
    state.status = 'inactive';
  });

  proc.on('error', () => {
    state.process = null;
    state.url = null;
    state.status = 'error';
  });
}

export function stopTunnel(): void {
  state.process?.kill();
  state.process = null;
  state.url = null;
  state.status = 'inactive';
}

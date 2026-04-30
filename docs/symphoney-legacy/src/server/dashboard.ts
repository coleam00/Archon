import type { OrchestratorSnapshot } from "../orchestrator/orchestrator.js";

const escape = (s: string) =>
  s.replace(/[&<>'"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c] ?? c,
  );

export function renderDashboard(snap: OrchestratorSnapshot): string {
  const runningRows = snap.running
    .map(
      (r) => `<tr>
  <td>${escape(r.issue_identifier)}</td>
  <td>${escape(r.state)}</td>
  <td>${r.turn_count}</td>
  <td>${escape(r.last_event ?? "—")}</td>
  <td>${escape(r.session_id ?? "—")}</td>
  <td>${escape(r.started_at)}</td>
  <td>${r.tokens.input_tokens}/${r.tokens.output_tokens}/${r.tokens.total_tokens}</td>
</tr>`,
    )
    .join("\n");

  const retryRows = snap.retrying
    .map(
      (r) => `<tr>
  <td>${escape(r.issue_identifier)}</td>
  <td>${r.attempt}</td>
  <td>${escape(r.due_at)}</td>
  <td>${escape(r.error ?? "—")}</td>
</tr>`,
    )
    .join("\n");

  const totals = snap.codex_totals;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Symphony</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 1.2em; max-width: 1100px; color: #222; }
  h1 { font-size: 1.4em; margin: 0 0 .6em; }
  h2 { font-size: 1.1em; margin: 1.4em 0 .4em; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .35em .6em; border-bottom: 1px solid #eee; vertical-align: top; }
  th { background: #f7f7f9; }
  .muted { color: #666; }
  code { font-family: ui-monospace, Menlo, monospace; background: #f3f4f6; padding: 1px 4px; border-radius: 3px; }
  .totals { display: flex; gap: 1.5em; flex-wrap: wrap; }
  .totals div { background: #f7f7f9; padding: .6em 1em; border-radius: 6px; }
</style>
</head>
<body>
<h1>Symphony</h1>
<p class="muted">Generated ${escape(snap.generated_at)} · Running: ${snap.counts.running} · Retrying: ${snap.counts.retrying}</p>

<div class="totals">
  <div><strong>Tokens</strong><br>in ${totals.input_tokens} · out ${totals.output_tokens} · total ${totals.total_tokens}</div>
  <div><strong>Runtime (s)</strong><br>${totals.seconds_running.toFixed(1)}</div>
  <div><strong>Rate limits</strong><br>${snap.rate_limits ? "<code>see /api/v1/state</code>" : "<span class='muted'>none</span>"}</div>
</div>

<h2>Running</h2>
${
  snap.running.length
    ? `<table><thead><tr><th>Issue</th><th>State</th><th>Turn</th><th>Last event</th><th>Session</th><th>Started</th><th>Tokens i/o/total</th></tr></thead><tbody>${runningRows}</tbody></table>`
    : '<p class="muted">No active sessions.</p>'
}

<h2>Retrying</h2>
${
  snap.retrying.length
    ? `<table><thead><tr><th>Issue</th><th>Attempt</th><th>Due</th><th>Error</th></tr></thead><tbody>${retryRows}</tbody></table>`
    : '<p class="muted">No retries scheduled.</p>'
}

<p class="muted">JSON: <code>GET /api/v1/state</code> · <code>GET /api/v1/&lt;identifier&gt;</code> · <code>POST /api/v1/refresh</code></p>
</body>
</html>`;
}

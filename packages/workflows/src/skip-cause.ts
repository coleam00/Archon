import type { SkipCause } from './schemas/node-state';

export function formatIncludeBoundaryId(includeId: string): string {
  return includeId
    .split(/(__|[./])/)
    .map(component => {
      const authored = decodeURIComponent(component);
      return authored === component ? authored : `[${JSON.stringify(authored)}]`;
    })
    .join('');
}

export function formatSkipCause(cause: SkipCause): string {
  const detail = formatCauseDetail(cause);
  return cause.boundary
    ? `${detail} [include '${formatIncludeBoundaryId(cause.boundary.includeId)}', workflow '${cause.boundary.workflow}']`
    : detail;
}

function formatCauseDetail(cause: SkipCause): string {
  switch (cause.kind) {
    case 'condition':
      return `condition: ${cause.expr}`;
    case 'condition_parse_error':
      return `${cause.boundary ? 'condition evaluation error' : 'condition parse error'}: ${cause.expr}`;
    case 'timeout':
      return 'timeout';
    case 'upstream_failed':
      return `upstream failed: ${cause.origin}`;
    case 'upstream_skipped':
      return `upstream skipped: ${cause.origin}`;
  }
}

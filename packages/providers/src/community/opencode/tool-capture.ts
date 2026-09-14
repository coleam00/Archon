import type { ToolResultCapture } from '../../types';
import { captureToolResult } from '../../shared/tool-capture';

export function captureOpencodeResult(
  state: Record<string, unknown> | undefined
): ToolResultCapture {
  const capture = captureToolResult(state?.status === 'error' ? state.error : state?.output);
  const metadata = state?.metadata;
  if (Array.isArray(state?.attachments) && state.attachments.length > 0) {
    // OpenCode FilePart URLs can reference remote or private runtime files. The
    // event boundary cannot retain those bytes without broadening its authority.
    return { ...capture, completeness: 'unavailable' };
  }
  if (
    metadata !== null &&
    typeof metadata === 'object' &&
    'truncated' in metadata &&
    metadata.truncated === true
  ) {
    return { ...capture, completeness: 'truncated' };
  }
  return capture;
}

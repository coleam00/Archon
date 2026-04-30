export type TrackerErrorCode =
  | "unsupported_tracker_kind"
  | "missing_tracker_api_key"
  | "missing_tracker_project_slug"
  | "missing_title"
  | "missing_issue_id"
  | "missing_comment_body"
  | "linear_api_request"
  | "linear_api_status"
  | "linear_graphql_errors"
  | "linear_unknown_payload"
  | "linear_missing_end_cursor"
  | "linear_issue_create_failed"
  | "linear_comment_create_failed"
  | "linear_project_not_found"
  | "linear_project_no_team";

export class TrackerError extends Error {
  constructor(
    public readonly code: TrackerErrorCode,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TrackerError";
  }
}

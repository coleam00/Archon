/**
 * Sprint Types for Sprint War Room
 * Matches backend sprint models
 */

/** All valid sprint lifecycle status values — maps to the SCRUM lifecycle: PLANNING → PO APPROVAL → EXECUTION → REVIEW */
export type SprintStatus =
  | "planning"           // Sprint being planned, tasks not yet assigned
  | "ready_for_kickoff"  // PO approval gate — "Approve & Start Sprint" visible
  | "active"             // Sprint in execution
  | "review"             // Sprint in review phase
  | "completed"          // Sprint done
  | "cancelled";         // Sprint cancelled before completion

/** Represents a sprint. Matches backend Sprint model */
export interface Sprint {
  /** UUID primary key */
  id: string;
  /** UUID of the parent project */
  project_id: string;
  /** Display name of the sprint, e.g. "Sprint War Room" */
  name: string;
  /** Sprint goal text — nullable when no goal has been set */
  goal?: string | null;
  /** Current lifecycle status */
  status: SprintStatus;
  /** ISO 8601 date string — sprint start date, null when not yet scheduled */
  start_date?: string | null;
  /** ISO 8601 date string — sprint end date, null when not yet scheduled */
  end_date?: string | null;
  /** ISO 8601 timestamp — record creation */
  created_at: string;
  /** ISO 8601 timestamp — last update */
  updated_at: string;
}

/** Request body for POST /api/projects/{id}/sprints. Matches backend CreateSprintRequest model */
export interface CreateSprintRequest {
  /** UUID of the parent project */
  project_id: string;
  /** Display name of the sprint */
  name: string;
  /** Sprint goal text */
  goal?: string;
  /** Initial lifecycle status (defaults server-side to "planning" if omitted) */
  status?: SprintStatus;
  /** ISO 8601 date string — sprint start date */
  start_date?: string;
  /** ISO 8601 date string — sprint end date */
  end_date?: string;
}

/** Request body for PATCH /api/projects/{id}/sprints/{sprint_id}. Matches backend UpdateSprintRequest model */
export interface UpdateSprintRequest {
  /** Display name of the sprint */
  name?: string;
  /** Sprint goal text */
  goal?: string;
  /** Lifecycle status to transition to */
  status?: SprintStatus;
  /** ISO 8601 date string — sprint start date */
  start_date?: string;
  /** ISO 8601 date string — sprint end date */
  end_date?: string;
  /** Identifies who approved the PO gate transition (required when moving from ready_for_kickoff → active) */
  requested_by?: string;
}

/**
 * Repository types for Agent Work Orders
 *
 * Mirrors backend models from python/src/agent_work_orders/models_db.py
 */

export interface GitHubRepository {
	id: string; // UUID from backend
	repository_url: string;
	repository_name: string; // "owner/repo"
	repository_owner: string; // "owner"
	repository_display_name: string | null;
	pinned: boolean;
	metadata: Record<string, unknown>;
	created_at: string;
	updated_at: string;
	_optimistic?: boolean; // For optimistic updates
	_localId?: string; // For optimistic ID replacement
}

export interface CreateRepositoryRequest {
	repository_url: string;
	repository_display_name?: string | null;
}

export interface UpdateRepositoryRequest {
	repository_display_name?: string;
	pinned?: boolean;
}

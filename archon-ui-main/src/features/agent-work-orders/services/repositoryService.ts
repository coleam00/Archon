/**
 * Repository API Service
 *
 * Handles all repository CRUD operations.
 * Mirrors pattern from features/projects/services/projectService.ts
 */

import { callAPIWithETag } from "@/features/shared/api/apiClient";
import type {
	CreateRepositoryRequest,
	GitHubRepository,
	UpdateRepositoryRequest,
} from "../types/repository";
import type { AgentWorkOrder } from "../types";

const BASE_URL = "/api/repositories";

export const repositoryService = {
	async createRepository(
		request: CreateRepositoryRequest,
	): Promise<GitHubRepository> {
		return await callAPIWithETag<GitHubRepository>(`${BASE_URL}/`, {
			method: "POST",
			body: JSON.stringify(request),
		});
	},

	async listRepositories(): Promise<GitHubRepository[]> {
		const response = await callAPIWithETag<{
			repositories: GitHubRepository[];
			count: number;
		}>(`${BASE_URL}/`);
		return response.repositories;
	},

	async getRepository(id: string): Promise<GitHubRepository> {
		return await callAPIWithETag<GitHubRepository>(`${BASE_URL}/${id}`);
	},

	async updateRepository(
		id: string,
		updates: UpdateRepositoryRequest,
	): Promise<GitHubRepository> {
		return await callAPIWithETag<GitHubRepository>(`${BASE_URL}/${id}`, {
			method: "PUT",
			body: JSON.stringify(updates),
		});
	},

	async deleteRepository(id: string): Promise<void> {
		await callAPIWithETag<void>(`${BASE_URL}/${id}`, {
			method: "DELETE",
		});
	},

	async getRepositoryWorkOrders(
		id: string,
		status?: string,
	): Promise<AgentWorkOrder[]> {
		const params = status ? `?status=${status}` : "";
		const response = await callAPIWithETag<{
			work_orders: AgentWorkOrder[];
			count: number;
		}>(`${BASE_URL}/${id}/work-orders${params}`);
		return response.work_orders;
	},
};

/**
 * Coding Standard Service
 *
 * API client for coding standards CRUD operations.
 */

import { callAPIWithETag } from "@/features/shared/api/apiClient";
import type { CodingStandard, CreateCodingStandardRequest, UpdateCodingStandardRequest } from "../types";

/**
 * List all coding standards with optional filtering
 */
async function listCodingStandards(params?: {
	language?: string;
	is_active?: boolean;
}): Promise<CodingStandard[]> {
	const queryParams = new URLSearchParams();
	if (params?.language) {
		queryParams.append("language", params.language);
	}
	if (params?.is_active !== undefined) {
		queryParams.append("is_active", params.is_active.toString());
	}

	const url = `/api/coding-standards/${queryParams.toString() ? `?${queryParams.toString()}` : ""}`;
	return callAPIWithETag<CodingStandard[]>(url);
}

/**
 * Get coding standard by slug
 */
async function getCodingStandard(slug: string): Promise<CodingStandard> {
	return callAPIWithETag<CodingStandard>(`/api/coding-standards/${slug}`);
}

/**
 * Create new coding standard
 */
async function createCodingStandard(data: CreateCodingStandardRequest): Promise<CodingStandard> {
	return callAPIWithETag<CodingStandard>("/api/coding-standards/", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(data),
	});
}

/**
 * Update existing coding standard
 */
async function updateCodingStandard(slug: string, updates: UpdateCodingStandardRequest): Promise<CodingStandard> {
	return callAPIWithETag<CodingStandard>(`/api/coding-standards/${slug}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(updates),
	});
}

/**
 * Delete coding standard (soft delete)
 */
async function deleteCodingStandard(slug: string): Promise<void> {
	return callAPIWithETag<void>(`/api/coding-standards/${slug}`, {
		method: "DELETE",
	});
}

/**
 * Coding standard service object
 */
export const codingStandardService = {
	listCodingStandards,
	getCodingStandard,
	createCodingStandard,
	updateCodingStandard,
	deleteCodingStandard,
};

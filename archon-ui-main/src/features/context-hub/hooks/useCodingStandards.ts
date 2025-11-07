/**
 * Coding Standards Query Hooks
 *
 * TanStack Query hooks for coding standards with query key factories.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { STALE_TIMES, DISABLED_QUERY_KEY } from "@/features/shared/config/queryPatterns";
import { codingStandardService } from "../services";
import type { CreateCodingStandardRequest, UpdateCodingStandardRequest } from "../types";

/**
 * Query key factory for coding standards
 */
export const codingStandardKeys = {
	all: ["context-hub", "coding-standards"] as const,
	lists: () => [...codingStandardKeys.all, "list"] as const,
	list: (filters?: { language?: string; is_active?: boolean }) =>
		[...codingStandardKeys.lists(), filters] as const,
	detail: (slug: string) => [...codingStandardKeys.all, "detail", slug] as const,
};

/**
 * List all coding standards with optional filtering
 */
export function useCodingStandards(filters?: { language?: string; is_active?: boolean }) {
	return useQuery({
		queryKey: codingStandardKeys.list(filters),
		queryFn: () => codingStandardService.listCodingStandards(filters),
		staleTime: STALE_TIMES.normal,
	});
}

/**
 * Get single coding standard by slug
 */
export function useCodingStandard(slug: string | undefined) {
	return useQuery({
		queryKey: slug ? codingStandardKeys.detail(slug) : DISABLED_QUERY_KEY,
		queryFn: () => (slug ? codingStandardService.getCodingStandard(slug) : Promise.reject("No slug provided")),
		enabled: !!slug,
		staleTime: STALE_TIMES.normal,
	});
}

/**
 * Create new coding standard
 */
export function useCreateCodingStandard() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (data: CreateCodingStandardRequest) => codingStandardService.createCodingStandard(data),
		onSuccess: () => {
			// Invalidate all lists to refetch
			queryClient.invalidateQueries({ queryKey: codingStandardKeys.lists() });
		},
	});
}

/**
 * Update existing coding standard
 */
export function useUpdateCodingStandard() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ slug, updates }: { slug: string; updates: UpdateCodingStandardRequest }) =>
			codingStandardService.updateCodingStandard(slug, updates),
		onSuccess: (data) => {
			// Invalidate detail and lists
			queryClient.invalidateQueries({ queryKey: codingStandardKeys.detail(data.slug) });
			queryClient.invalidateQueries({ queryKey: codingStandardKeys.lists() });
		},
	});
}

/**
 * Delete coding standard
 */
export function useDeleteCodingStandard() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (slug: string) => codingStandardService.deleteCodingStandard(slug),
		onSuccess: () => {
			// Invalidate all lists to refetch
			queryClient.invalidateQueries({ queryKey: codingStandardKeys.lists() });
		},
	});
}

/**
 * Repository TanStack Query Hooks
 *
 * Mirrors pattern from features/projects/hooks/useProjectQueries.ts
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/features/shared/hooks/useToast";
import { STALE_TIMES, DISABLED_QUERY_KEY } from "@/features/shared/config/queryPatterns";
import {
	createOptimisticEntity,
	replaceOptimisticEntity,
} from "@/features/shared/utils/optimistic";
import { repositoryService } from "../services/repositoryService";
import type {
	CreateRepositoryRequest,
	GitHubRepository,
	UpdateRepositoryRequest,
} from "../types/repository";

export const repositoryKeys = {
	all: ["agent-work-order-repositories"] as const,
	lists: () => [...repositoryKeys.all, "list"] as const,
	detail: (id: string) => [...repositoryKeys.all, "detail", id] as const,
	workOrders: (id: string) =>
		[...repositoryKeys.all, id, "work-orders"] as const,
};

export function useRepositories() {
	return useQuery({
		queryKey: repositoryKeys.lists(),
		queryFn: () => repositoryService.listRepositories(),
		staleTime: STALE_TIMES.normal,
	});
}

export function useRepository(id: string | undefined) {
	return useQuery({
		queryKey: id ? repositoryKeys.detail(id) : DISABLED_QUERY_KEY,
		queryFn: () =>
			id
				? repositoryService.getRepository(id)
				: Promise.reject("No ID provided"),
		enabled: !!id,
		staleTime: STALE_TIMES.normal,
	});
}

export function useCreateRepository() {
	const queryClient = useQueryClient();
	const { showToast } = useToast();

	return useMutation({
		mutationFn: repositoryService.createRepository,
		onMutate: async (newRepo) => {
			await queryClient.cancelQueries({ queryKey: repositoryKeys.lists() });
			const previous = queryClient.getQueryData(repositoryKeys.lists());

			const optimistic = createOptimisticEntity(newRepo);
			queryClient.setQueryData(
				repositoryKeys.lists(),
				(old: GitHubRepository[] = []) => [...old, optimistic],
			);

			return { previous, localId: optimistic._localId };
		},
		onError: (err, variables, context) => {
			if (context?.previous) {
				queryClient.setQueryData(repositoryKeys.lists(), context.previous);
			}
			showToast("Failed to add repository", "error");
		},
		onSuccess: (data, variables, context) => {
			queryClient.setQueryData(
				repositoryKeys.lists(),
				(old: GitHubRepository[] = []) =>
					replaceOptimisticEntity(old, context?.localId, data),
			);
			showToast("Repository added successfully", "success");
		},
	});
}

export function useUpdateRepository() {
	const queryClient = useQueryClient();
	const { showToast } = useToast();

	return useMutation({
		mutationFn: ({
			id,
			updates,
		}: { id: string; updates: UpdateRepositoryRequest }) =>
			repositoryService.updateRepository(id, updates),
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: repositoryKeys.lists() });
			queryClient.setQueryData(repositoryKeys.detail(data.id), data);
			showToast("Repository updated", "success");
		},
		onError: () => {
			showToast("Failed to update repository", "error");
		},
	});
}

export function useDeleteRepository() {
	const queryClient = useQueryClient();
	const { showToast } = useToast();

	return useMutation({
		mutationFn: (id: string) => repositoryService.deleteRepository(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: repositoryKeys.lists() });
			showToast("Repository deleted", "success");
		},
		onError: () => {
			showToast("Failed to delete repository", "error");
		},
	});
}

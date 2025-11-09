/**
 * Repository Query Hooks
 *
 * TanStack Query hooks for repository management.
 * Follows patterns from QUERY_PATTERNS.md with query key factories and optimistic updates.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DISABLED_QUERY_KEY, STALE_TIMES } from "@/features/shared/config/queryPatterns";
import { useToast } from "@/features/shared/hooks/useToast";
import { createOptimisticEntity, replaceOptimisticEntity } from "@/features/shared/utils/optimistic";
import { repositoryService } from "../services/repositoryService";
import type { ConfiguredRepository, CreateRepositoryRequest, UpdateRepositoryRequest } from "../types/repository";

/**
 * Query key factory for repositories
 * Follows the pattern: domain > scope > identifier
 */
export const repositoryKeys = {
  all: ["repositories"] as const,
  lists: () => [...repositoryKeys.all, "list"] as const,
  detail: (id: string) => [...repositoryKeys.all, "detail", id] as const,
};

/**
 * List all configured repositories
 * @returns Query result with array of repositories
 */
export function useRepositories() {
  return useQuery<ConfiguredRepository[]>({
    queryKey: repositoryKeys.lists(),
    queryFn: () => repositoryService.listRepositories(),
    staleTime: STALE_TIMES.normal, // 30 seconds
    refetchOnWindowFocus: true, // Refetch when tab gains focus (ETag makes this cheap)
  });
}

/**
 * Get single repository by ID
 * @param id - Repository ID to fetch
 * @returns Query result with repository detail
 */
export function useRepository(id: string | undefined) {
  return useQuery<ConfiguredRepository>({
    queryKey: id ? repositoryKeys.detail(id) : DISABLED_QUERY_KEY,
    queryFn: () => {
      if (!id) return Promise.reject("No repository ID provided");
      // Note: Backend doesn't have a get-by-id endpoint yet, so we fetch from list
      return repositoryService.listRepositories().then((repos) => {
        const repo = repos.find((r) => r.id === id);
        if (!repo) throw new Error("Repository not found");
        return repo;
      });
    },
    enabled: !!id,
    staleTime: STALE_TIMES.normal,
  });
}

/**
 * Create a new configured repository with optimistic updates
 * @returns Mutation result for creating repository
 */
export function useCreateRepository() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation<
    ConfiguredRepository,
    Error,
    CreateRepositoryRequest,
    { previousRepositories?: ConfiguredRepository[]; optimisticId: string }
  >({
    mutationFn: (request: CreateRepositoryRequest) => repositoryService.createRepository(request),
    onMutate: async (newRepositoryData) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: repositoryKeys.lists() });

      // Snapshot the previous value
      const previousRepositories = queryClient.getQueryData<ConfiguredRepository[]>(repositoryKeys.lists());

      // Create optimistic repository with stable ID
      const optimisticRepository = createOptimisticEntity<ConfiguredRepository>({
        repository_url: newRepositoryData.repository_url,
        display_name: null,
        owner: null,
        default_branch: null,
        is_verified: false,
        last_verified_at: null,
        default_sandbox_type: "git_worktree",
        default_commands: ["create-branch", "planning", "execute", "commit", "create-pr"],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Optimistically add the new repository
      queryClient.setQueryData<ConfiguredRepository[]>(repositoryKeys.lists(), (old) => {
        if (!old) return [optimisticRepository];
        // Add new repository at the beginning of the list
        return [optimisticRepository, ...old];
      });

      return { previousRepositories, optimisticId: optimisticRepository._localId };
    },
    onError: (error, variables, context) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Failed to create repository:", error, { variables });

      // Rollback on error
      if (context?.previousRepositories) {
        queryClient.setQueryData(repositoryKeys.lists(), context.previousRepositories);
      }

      showToast(`Failed to create repository: ${errorMessage}`, "error");
    },
    onSuccess: (response, _variables, context) => {
      // Replace optimistic entity with real response
      queryClient.setQueryData<ConfiguredRepository[]>(repositoryKeys.lists(), (old) => {
        if (!old) return [response];
        return replaceOptimisticEntity(old, context?.optimisticId, response);
      });

      showToast("Repository created successfully", "success");
    },
  });
}

/**
 * Update an existing repository with optimistic updates
 * @returns Mutation result for updating repository
 */
export function useUpdateRepository() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation<
    ConfiguredRepository,
    Error,
    { id: string; request: UpdateRepositoryRequest },
    { previousRepositories?: ConfiguredRepository[] }
  >({
    mutationFn: ({ id, request }) => repositoryService.updateRepository(id, request),
    onMutate: async ({ id, request }) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: repositoryKeys.lists() });

      // Snapshot the previous value
      const previousRepositories = queryClient.getQueryData<ConfiguredRepository[]>(repositoryKeys.lists());

      // Optimistically update the repository
      queryClient.setQueryData<ConfiguredRepository[]>(repositoryKeys.lists(), (old) => {
        if (!old) return old;
        return old.map((repo) =>
          repo.id === id
            ? {
                ...repo,
                ...request,
                updated_at: new Date().toISOString(),
              }
            : repo,
        );
      });

      return { previousRepositories };
    },
    onError: (error, variables, context) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Failed to update repository:", error, { variables });

      // Rollback on error
      if (context?.previousRepositories) {
        queryClient.setQueryData(repositoryKeys.lists(), context.previousRepositories);
      }

      showToast(`Failed to update repository: ${errorMessage}`, "error");
    },
    onSuccess: (response) => {
      // Replace with server response
      queryClient.setQueryData<ConfiguredRepository[]>(repositoryKeys.lists(), (old) => {
        if (!old) return [response];
        return old.map((repo) => (repo.id === response.id ? response : repo));
      });

      showToast("Repository updated successfully", "success");
    },
  });
}

/**
 * Delete a repository with optimistic removal
 * @returns Mutation result for deleting repository
 */
export function useDeleteRepository() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation<void, Error, string, { previousRepositories?: ConfiguredRepository[] }>({
    mutationFn: (id: string) => repositoryService.deleteRepository(id),
    onMutate: async (id) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: repositoryKeys.lists() });

      // Snapshot the previous value
      const previousRepositories = queryClient.getQueryData<ConfiguredRepository[]>(repositoryKeys.lists());

      // Optimistically remove the repository
      queryClient.setQueryData<ConfiguredRepository[]>(repositoryKeys.lists(), (old) => {
        if (!old) return old;
        return old.filter((repo) => repo.id !== id);
      });

      return { previousRepositories };
    },
    onError: (error, variables, context) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Failed to delete repository:", error, { variables });

      // Rollback on error
      if (context?.previousRepositories) {
        queryClient.setQueryData(repositoryKeys.lists(), context.previousRepositories);
      }

      showToast(`Failed to delete repository: ${errorMessage}`, "error");
    },
    onSuccess: () => {
      showToast("Repository deleted successfully", "success");
    },
  });
}

/**
 * Verify repository access and update metadata
 * @returns Mutation result for verifying repository
 */
export function useVerifyRepository() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation<
    { is_accessible: boolean; repository_id: string },
    Error,
    string,
    { previousRepositories?: ConfiguredRepository[] }
  >({
    mutationFn: (id: string) => repositoryService.verifyRepositoryAccess(id),
    onMutate: async (_id) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: repositoryKeys.lists() });

      // Snapshot the previous value
      const previousRepositories = queryClient.getQueryData<ConfiguredRepository[]>(repositoryKeys.lists());

      return { previousRepositories };
    },
    onError: (error, variables, context) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("Failed to verify repository:", error, { variables });

      // Rollback on error
      if (context?.previousRepositories) {
        queryClient.setQueryData(repositoryKeys.lists(), context.previousRepositories);
      }

      showToast(`Failed to verify repository: ${errorMessage}`, "error");
    },
    onSuccess: (response) => {
      // Invalidate queries to refetch updated metadata from server
      queryClient.invalidateQueries({ queryKey: repositoryKeys.lists() });

      if (response.is_accessible) {
        showToast("Repository verified successfully", "success");
      } else {
        showToast("Repository is not accessible", "warning");
      }
    },
  });
}

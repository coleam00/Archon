/**
 * Retry Knowledge Source Hook
 * Allows retrying failed crawl operations with original parameters
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { progressKeys } from "../../progress/hooks/useProgressQueries";
import type { FailedOperation } from "../../progress/types";
import { useToast } from "../../shared/hooks/useToast";
import { knowledgeService } from "../services";

export function useRetryKnowledgeSource() {
	const queryClient = useQueryClient();
	const { showToast } = useToast();

	return useMutation({
		mutationFn: async (failedOp: FailedOperation) => {
			if (!failedOp.original_request?.url) {
				throw new Error("Cannot retry: Original request data missing");
			}

			// Retry by calling crawl endpoint with original parameters
			return knowledgeService.crawlUrl({
				url: failedOp.original_request.url,
				max_depth: failedOp.original_request.max_depth,
				tags: failedOp.original_request.tags,
			});
		},

		onSuccess: (_data, failedOp) => {
			showToast(
				`Crawl restarted for ${failedOp.original_request?.url}`,
				"success",
			);

			// Remove the failed operation from failed list
			queryClient.removeQueries({
				queryKey: progressKeys.detail(failedOp.progressId),
				exact: true,
			});

			// Refresh both failed and active operations
			queryClient.invalidateQueries({ queryKey: progressKeys.failed() });
			queryClient.invalidateQueries({ queryKey: progressKeys.active() });
		},

		onError: (error) => {
			showToast(
				error instanceof Error ? error.message : "Could not restart crawl",
				"error",
			);
		},
	});
}

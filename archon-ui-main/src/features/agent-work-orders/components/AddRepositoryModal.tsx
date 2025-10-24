import { Github, Loader2 } from "lucide-react";
import type React from "react";
import { useId, useState, useMemo } from "react";
import { Button } from "../../ui/primitives/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../../ui/primitives/dialog";
import { Input } from "../../ui/primitives/input";
import { cn } from "../../ui/primitives/styles";
import { useCreateRepository } from "../hooks/useRepositoryQueries";
import type { CreateRepositoryRequest } from "../types/repository";

interface AddRepositoryModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSuccess?: () => void;
}

/**
 * Extract owner and repo name from GitHub URL
 * Returns null if invalid format
 */
function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
	const trimmedUrl = url.trim();
	const githubRegex = /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/?$/;
	const match = trimmedUrl.match(githubRegex);

	if (!match) return null;

	return {
		owner: match[1],
		repo: match[2],
	};
}

export const AddRepositoryModal: React.FC<AddRepositoryModalProps> = ({ open, onOpenChange, onSuccess }) => {
	const repositoryUrlId = useId();
	const displayNameId = useId();

	const [formData, setFormData] = useState<CreateRepositoryRequest>({
		repository_url: "",
		repository_display_name: "",
	});

	const createRepositoryMutation = useCreateRepository();

	// Parse and preview extracted repository name
	const extractedInfo = useMemo(() => parseGitHubUrl(formData.repository_url), [formData.repository_url]);

	const isValidUrl = useMemo(() => {
		if (!formData.repository_url.trim()) return true; // Empty is valid (not submitted yet)
		return extractedInfo !== null;
	}, [formData.repository_url, extractedInfo]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!formData.repository_url.trim() || !extractedInfo) return;

		createRepositoryMutation.mutate(
			{
				repository_url: formData.repository_url,
				repository_display_name: formData.repository_display_name || null,
			},
			{
				onSuccess: () => {
					setFormData({ repository_url: "", repository_display_name: "" });
					onOpenChange(false);
					onSuccess?.();
				},
			},
		);
	};

	const handleClose = () => {
		if (!createRepositoryMutation.isPending) {
			setFormData({ repository_url: "", repository_display_name: "" });
			onOpenChange(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={handleClose}>
			<DialogContent className="sm:max-w-md">
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle className="text-xl font-bold bg-gradient-to-r from-blue-400 to-cyan-500 text-transparent bg-clip-text">
							Add GitHub Repository
						</DialogTitle>
						<DialogDescription>Add a GitHub repository to track agent work orders.</DialogDescription>
					</DialogHeader>

					<div className="space-y-4 my-6">
						{/* Repository URL */}
						<div>
							<label
								htmlFor={repositoryUrlId}
								className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
							>
								Repository URL <span className="text-red-500">*</span>
							</label>
							<Input
								id={repositoryUrlId}
								type="text"
								placeholder="https://github.com/owner/repo"
								value={formData.repository_url}
								onChange={(e) => setFormData((prev) => ({ ...prev, repository_url: e.target.value }))}
								disabled={createRepositoryMutation.isPending}
								className={cn(
									"w-full",
									"focus:border-blue-400 focus:shadow-[0_0_10px_rgba(59,130,246,0.2)]",
									!isValidUrl && "border-red-400 focus:border-red-400",
								)}
								autoFocus
							/>
							{!isValidUrl && formData.repository_url.trim() && (
								<p className="text-xs text-red-500 mt-1">
									URL must start with https://github.com/ and include owner/repo
								</p>
							)}
						</div>

						{/* Extracted Name Preview */}
						{extractedInfo && (
							<div className="flex items-center gap-2 p-3 bg-blue-50/50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded-md">
								<Github className="w-4 h-4 text-blue-600 dark:text-blue-400" />
								<div className="flex-1">
									<p className="text-xs text-gray-600 dark:text-gray-400">Extracted repository:</p>
									<p className="text-sm font-mono text-blue-700 dark:text-blue-300">
										{extractedInfo.owner}/{extractedInfo.repo}
									</p>
								</div>
							</div>
						)}

						{/* Display Name (Optional) */}
						<div>
							<label
								htmlFor={displayNameId}
								className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
							>
								Display Name <span className="text-gray-400 text-xs">(optional)</span>
							</label>
							<Input
								id={displayNameId}
								type="text"
								placeholder="Custom name for this repository"
								value={formData.repository_display_name || ""}
								onChange={(e) =>
									setFormData((prev) => ({
										...prev,
										repository_display_name: e.target.value,
									}))
								}
								disabled={createRepositoryMutation.isPending}
								className={cn("w-full", "focus:border-blue-400 focus:shadow-[0_0_10px_rgba(59,130,246,0.2)]")}
							/>
							<p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
								If empty, will use: {extractedInfo ? `${extractedInfo.owner}/${extractedInfo.repo}` : "..."}
							</p>
						</div>
					</div>

					<DialogFooter>
						<Button type="button" variant="ghost" onClick={handleClose} disabled={createRepositoryMutation.isPending}>
							Cancel
						</Button>
						<Button
							type="submit"
							variant="default"
							disabled={createRepositoryMutation.isPending || !extractedInfo}
							className="shadow-lg shadow-blue-500/20"
						>
							{createRepositoryMutation.isPending ? (
								<>
									<Loader2 className="w-4 h-4 mr-2 animate-spin" />
									Adding...
								</>
							) : (
								<>
									<Github className="w-4 h-4 mr-2" />
									Add Repository
								</>
							)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
};

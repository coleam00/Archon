import { Loader2 } from "lucide-react";
import type React from "react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/features/ui/primitives/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/features/ui/primitives/dialog";
import { Input } from "@/features/ui/primitives/input";
import { Label } from "@/features/ui/primitives/label";
import { Textarea } from "@/features/ui/primitives/textarea";
import { useCodingStandard, useUpdateCodingStandard } from "../hooks/useCodingStandards";
import type { UpdateCodingStandardRequest } from "../types";

interface EditCodingStandardModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	slug: string | null;
}

export const EditCodingStandardModal: React.FC<EditCodingStandardModalProps> = ({ open, onOpenChange, slug }) => {
	const nameId = useId();
	const descriptionId = useId();
	const standardsId = useId();

	const { data: standard, isLoading, error } = useCodingStandard(slug || undefined);
	const updateMutation = useUpdateCodingStandard();

	const [formData, setFormData] = useState<UpdateCodingStandardRequest>({});
	const [standardsJson, setStandardsJson] = useState("");
	const [jsonError, setJsonError] = useState<string | null>(null);

	useEffect(() => {
		if (standard) {
			setFormData({
				name: standard.name,
				description: standard.description,
				language: standard.language,
			});
			setStandardsJson(JSON.stringify(standard.standards, null, 2));
		}
	}, [standard]);

	const handleStandardsChange = (value: string) => {
		setStandardsJson(value);
		try {
			const parsed = JSON.parse(value);
			setFormData((prev) => ({ ...prev, standards: parsed }));
			setJsonError(null);
		} catch (_e) {
			setJsonError("Invalid JSON");
		}
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!slug || jsonError) return;

		updateMutation.mutate(
			{ slug, updates: formData },
			{
				onSuccess: () => {
					onOpenChange(false);
				},
			},
		);
	};

	const handleClose = () => {
		if (!updateMutation.isPending) {
			setFormData({});
			setStandardsJson("");
			setJsonError(null);
			onOpenChange(false);
		}
	};

	if (isLoading) {
		return (
			<Dialog open={open} onOpenChange={handleClose}>
				<DialogContent className="sm:max-w-2xl">
					<div className="flex items-center justify-center py-12">
						<div className="text-center">
							<Loader2 className="h-8 w-8 animate-spin text-yellow-600 mx-auto mb-2" />
							<p className="text-sm text-gray-600 dark:text-gray-400">Loading coding standard...</p>
						</div>
					</div>
				</DialogContent>
			</Dialog>
		);
	}

	if (error) {
		return (
			<Dialog open={open} onOpenChange={handleClose}>
				<DialogContent className="sm:max-w-2xl">
					<div className="flex items-center justify-center py-12">
						<p className="text-red-600 dark:text-red-400">Error loading standard: {String(error)}</p>
					</div>
				</DialogContent>
			</Dialog>
		);
	}

	if (!standard) return null;

	return (
		<Dialog open={open} onOpenChange={handleClose}>
			<DialogContent className="sm:max-w-5xl max-h-[85vh] overflow-y-auto">
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle className="text-xl font-bold bg-gradient-to-r from-yellow-400 to-orange-500 text-transparent bg-clip-text">
							Edit Coding Standard
						</DialogTitle>
						<DialogDescription>Update coding standard configuration and rules.</DialogDescription>
					</DialogHeader>

					<div className="grid grid-cols-1 lg:grid-cols-2 gap-6 my-6">
						{/* Left Column: Basic Info */}
						<div className="space-y-4">
							<div className="grid grid-cols-2 gap-4">
								<div>
									<Label htmlFor={nameId}>Standard Name</Label>
									<Input
										id={nameId}
										type="text"
										value={formData.name || ""}
										onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
										disabled={updateMutation.isPending}
									/>
								</div>

								<div>
									<Label>Language</Label>
									<Input value={standard.language} disabled className="bg-gray-50 dark:bg-gray-800" />
									<p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Language cannot be changed</p>
								</div>
							</div>

							<div>
								<Label htmlFor={descriptionId}>Description</Label>
								<Input
									id={descriptionId}
									type="text"
									value={formData.description || ""}
									onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
									disabled={updateMutation.isPending}
								/>
							</div>

							<div className="p-4 rounded-lg bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-500/30">
								<p className="text-sm text-gray-700 dark:text-gray-300">
									<strong>Slug:</strong> {standard.slug}
								</p>
								<p className="text-sm text-gray-700 dark:text-gray-300 mt-1">
									<strong>Language:</strong> {standard.language}
								</p>
								<p className="text-sm text-gray-700 dark:text-gray-300 mt-1">
									<strong>Created:</strong> {new Date(standard.created_at).toLocaleDateString()}
								</p>
							</div>
						</div>

						{/* Right Column: Standards Configuration (JSON) */}
						<div>
							<Label htmlFor={standardsId}>Standards Configuration (JSON)</Label>
							<Textarea
								id={standardsId}
								value={standardsJson}
								onChange={(e) => handleStandardsChange(e.target.value)}
								className="font-mono text-sm min-h-[400px]"
								disabled={updateMutation.isPending}
							/>
							{jsonError && <p className="text-sm text-red-600 dark:text-red-400 mt-1">{jsonError}</p>}
							<p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
								Define linter/formatter rules in JSON format
							</p>
						</div>
					</div>

					<DialogFooter>
						<Button type="button" variant="ghost" onClick={handleClose} disabled={updateMutation.isPending}>
							Cancel
						</Button>
						<Button type="submit" variant="knowledge" disabled={updateMutation.isPending || !!jsonError}>
							{updateMutation.isPending ? (
								<>
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
									Updating...
								</>
							) : (
								"Update Standard"
							)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
};

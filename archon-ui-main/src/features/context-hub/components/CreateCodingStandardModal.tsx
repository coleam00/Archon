import { Loader2 } from "lucide-react";
import type React from "react";
import { useId, useState } from "react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/features/ui/primitives/select";
import { Textarea } from "@/features/ui/primitives/textarea";
import { useCreateCodingStandard } from "../hooks/useCodingStandards";
import type { CreateCodingStandardRequest } from "../types";

interface CreateCodingStandardModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

const COMMON_LANGUAGES = [
	"typescript",
	"javascript",
	"python",
	"rust",
	"go",
	"java",
	"csharp",
	"ruby",
	"php",
	"swift",
	"kotlin",
];

export const CreateCodingStandardModal: React.FC<CreateCodingStandardModalProps> = ({ open, onOpenChange }) => {
	const nameId = useId();
	const slugId = useId();
	const languageId = useId();
	const descriptionId = useId();
	const standardsId = useId();

	const createMutation = useCreateCodingStandard();

	const [formData, setFormData] = useState<CreateCodingStandardRequest>({
		name: "",
		slug: "",
		language: "typescript",
		description: "",
		standards: {},
		metadata: {},
	});

	const [standardsJson, setStandardsJson] = useState("{}");
	const [jsonError, setJsonError] = useState<string | null>(null);

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

		if (jsonError) {
			return;
		}

		createMutation.mutate(formData, {
			onSuccess: () => {
				setFormData({
					name: "",
					slug: "",
					language: "typescript",
					description: "",
					standards: {},
					metadata: {},
				});
				setStandardsJson("{}");
				onOpenChange(false);
			},
		});
	};

	const handleClose = () => {
		if (!createMutation.isPending) {
			setFormData({
				name: "",
				slug: "",
				language: "typescript",
				description: "",
				standards: {},
				metadata: {},
			});
			setStandardsJson("{}");
			setJsonError(null);
			onOpenChange(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={handleClose}>
			<DialogContent className="sm:max-w-5xl max-h-[85vh] overflow-y-auto">
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle className="text-xl font-bold bg-gradient-to-r from-yellow-400 to-orange-500 text-transparent bg-clip-text">
							Create Coding Standard
						</DialogTitle>
						<DialogDescription>Define a new coding standard with linter/formatter rules.</DialogDescription>
					</DialogHeader>

					<div className="grid grid-cols-1 lg:grid-cols-2 gap-6 my-6">
						{/* Left Column: Basic Info */}
						<div className="space-y-4">
							<div className="grid grid-cols-2 gap-4">
								<div>
									<Label htmlFor={nameId}>Standard Name*</Label>
									<Input
										id={nameId}
										type="text"
										value={formData.name}
										onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
										placeholder="TypeScript Strict Mode"
										required
										disabled={createMutation.isPending}
									/>
								</div>

								<div>
									<Label htmlFor={slugId}>Slug*</Label>
									<Input
										id={slugId}
										type="text"
										value={formData.slug}
										onChange={(e) => setFormData((prev) => ({ ...prev, slug: e.target.value }))}
										placeholder="typescript-strict"
										required
										disabled={createMutation.isPending}
									/>
								</div>
							</div>

							<div>
								<Label htmlFor={languageId}>Programming Language*</Label>
								<Select
									value={formData.language}
									onValueChange={(value) => setFormData((prev) => ({ ...prev, language: value }))}
									disabled={createMutation.isPending}
								>
									<SelectTrigger id={languageId}>
										<SelectValue placeholder="Select language" />
									</SelectTrigger>
									<SelectContent>
										{COMMON_LANGUAGES.map((lang) => (
											<SelectItem key={lang} value={lang}>
												{lang.charAt(0).toUpperCase() + lang.slice(1)}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>

							<div>
								<Label htmlFor={descriptionId}>Description</Label>
								<Input
									id={descriptionId}
									type="text"
									value={formData.description || ""}
									onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
									placeholder="Strict TypeScript configuration with no implicit any"
									disabled={createMutation.isPending}
								/>
							</div>
						</div>

						{/* Right Column: Standards Configuration (JSON) */}
						<div>
							<Label htmlFor={standardsId}>Standards Configuration (JSON)*</Label>
							<Textarea
								id={standardsId}
								value={standardsJson}
								onChange={(e) => handleStandardsChange(e.target.value)}
								placeholder='{"extends": ["eslint:recommended"], "rules": {"no-console": "warn"}}'
								className="font-mono text-sm min-h-[400px]"
								disabled={createMutation.isPending}
							/>
							{jsonError && <p className="text-sm text-red-600 dark:text-red-400 mt-1">{jsonError}</p>}
							<p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
								Define linter/formatter rules in JSON format
							</p>
						</div>
					</div>

					<DialogFooter>
						<Button type="button" variant="ghost" onClick={handleClose} disabled={createMutation.isPending}>
							Cancel
						</Button>
						<Button type="submit" variant="knowledge" disabled={createMutation.isPending || !!jsonError}>
							{createMutation.isPending ? (
								<>
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
									Creating...
								</>
							) : (
								"Create Standard"
							)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
};

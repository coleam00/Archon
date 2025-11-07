import { Code, Loader2, Plus, Search } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { Button } from "@/features/ui/primitives/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/features/ui/primitives/select";
import { useCodingStandards } from "../hooks/useCodingStandards";
import { CodingStandardCard } from "../components/CodingStandardCard";
import { CreateCodingStandardModal } from "../components/CreateCodingStandardModal";
import { EditCodingStandardModal } from "../components/EditCodingStandardModal";

const COMMON_LANGUAGES = [
	{ value: "all", label: "All Languages" },
	{ value: "typescript", label: "TypeScript" },
	{ value: "javascript", label: "JavaScript" },
	{ value: "python", label: "Python" },
	{ value: "rust", label: "Rust" },
	{ value: "go", label: "Go" },
	{ value: "java", label: "Java" },
	{ value: "csharp", label: "C#" },
	{ value: "ruby", label: "Ruby" },
	{ value: "php", label: "PHP" },
];

export const CodingStandardsView: React.FC = () => {
	const [searchQuery, setSearchQuery] = useState("");
	const [languageFilter, setLanguageFilter] = useState<string>("all");
	const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
	const [editingSlug, setEditingSlug] = useState<string | null>(null);

	const { data: standards, isLoading, error } = useCodingStandards(
		languageFilter !== "all" ? { language: languageFilter } : undefined,
	);

	// Group standards by language
	const groupedStandards = standards?.reduce(
		(acc, standard) => {
			const lang = standard.language;
			if (!acc[lang]) {
				acc[lang] = [];
			}
			acc[lang].push(standard);
			return acc;
		},
		{} as Record<string, typeof standards>,
	);

	// Apply search filter
	const filteredStandards = standards?.filter((s) =>
		searchQuery && searchQuery.trim()
			? s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
			  s.description?.toLowerCase().includes(searchQuery.toLowerCase())
			: true,
	) || [];

	return (
		<div className="space-y-6">
			{/* Header with Search and Create */}
			<div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
				<h2 className="text-xl font-semibold text-gray-900 dark:text-white">
					Coding Standards ({filteredStandards.length})
				</h2>

				<div className="flex items-center gap-3 w-full sm:w-auto">
					<div className="relative flex-1 sm:flex-initial sm:w-64">
						<Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
						<input
							type="text"
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							placeholder="Search standards..."
							className="w-full pl-9 pr-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-yellow-500"
						/>
					</div>
					<Button
						onClick={() => setIsCreateModalOpen(true)}
						size="sm"
						className="gap-2 bg-gradient-to-r from-yellow-500/20 to-orange-500/20 border border-yellow-500/30 hover:from-yellow-500/30 hover:to-orange-500/30 text-yellow-700 dark:text-yellow-300"
					>
						<Plus className="w-4 h-4" />
						Create
					</Button>
				</div>
			</div>

			{/* Language Filter */}
			<div className="flex items-center gap-4">
				<div className="flex items-center gap-2">
					<label htmlFor="language-filter" className="text-sm font-medium text-gray-700 dark:text-gray-300">
						Language:
					</label>
					<Select value={languageFilter} onValueChange={setLanguageFilter}>
						<SelectTrigger id="language-filter" className="w-48">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{COMMON_LANGUAGES.map((lang) => (
								<SelectItem key={lang.value} value={lang.value}>
									{lang.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>

			{/* Loading State */}
			{isLoading && (
				<div className="flex items-center justify-center py-12">
					<div className="text-center">
						<Loader2 className="h-8 w-8 animate-spin text-yellow-600 mx-auto mb-2" />
						<p className="text-sm text-gray-600 dark:text-gray-400">Loading coding standards...</p>
					</div>
				</div>
			)}

			{/* Error State */}
			{error && (
				<div className="flex items-center justify-center py-12">
					<div className="text-center">
						<p className="text-red-600 dark:text-red-400">Error loading standards: {String(error)}</p>
					</div>
				</div>
			)}

			{/* Empty State */}
			{!isLoading && !error && filteredStandards.length === 0 && (
				<div className="flex flex-col items-center justify-center py-12 border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl">
					<Code className="w-12 h-12 text-gray-400 mb-4" />
					<p className="text-gray-600 dark:text-gray-400 mb-4">
						{searchQuery
							? `No standards matching "${searchQuery}"`
							: languageFilter !== "all"
								? `No coding standards found for ${languageFilter}`
								: "No coding standards created yet"}
					</p>
					<Button
						onClick={() => setIsCreateModalOpen(true)}
						size="sm"
						className="gap-2 bg-gradient-to-r from-yellow-500/20 to-orange-500/20 border border-yellow-500/30 hover:from-yellow-500/30 hover:to-orange-500/30 text-yellow-700 dark:text-yellow-300"
					>
						<Plus className="w-4 h-4" />
						Create First Standard
					</Button>
				</div>
			)}

			{/* Standards List - Grouped by Language or Filtered */}
			{!isLoading && !error && filteredStandards.length > 0 && (
				<div className="space-y-8">
					{languageFilter === "all" && !searchQuery ? (
						// Show grouped by language (no search active)
						Object.entries(
							filteredStandards.reduce(
								(acc, standard) => {
									const lang = standard.language;
									if (!acc[lang]) acc[lang] = [];
									acc[lang].push(standard);
									return acc;
								},
								{} as Record<string, typeof filteredStandards>,
							),
						)
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([language, langStandards]) => (
								<div key={language}>
									<h3 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-4 capitalize flex items-center gap-2">
										<span className="inline-flex items-center px-2 py-1 rounded text-sm font-medium bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-300 border border-yellow-200 dark:border-yellow-800">
											{language}
										</span>
										<span className="text-sm font-normal text-gray-500">
											({langStandards.length} {langStandards.length === 1 ? "standard" : "standards"})
										</span>
									</h3>
									<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
										{langStandards.map((standard) => (
											<CodingStandardCard
												key={standard.id}
												standard={standard}
												onEdit={() => setEditingSlug(standard.slug)}
											/>
										))}
									</div>
								</div>
							))
					) : (
						// Show flat filtered results (search or language filter active)
						<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
							{filteredStandards.map((standard) => (
								<CodingStandardCard
									key={standard.id}
									standard={standard}
									onEdit={() => setEditingSlug(standard.slug)}
								/>
							))}
						</div>
					)}
				</div>
			)}

			{/* Modals */}
			<CreateCodingStandardModal open={isCreateModalOpen} onOpenChange={setIsCreateModalOpen} />
			<EditCodingStandardModal
				open={!!editingSlug}
				onOpenChange={(open) => !open && setEditingSlug(null)}
				slug={editingSlug}
			/>
		</div>
	);
};

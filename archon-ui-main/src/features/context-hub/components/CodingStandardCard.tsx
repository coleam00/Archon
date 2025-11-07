import { Code, Edit2 } from "lucide-react";
import type React from "react";
import { Button } from "@/features/ui/primitives/button";
import type { CodingStandard } from "../types";

interface CodingStandardCardProps {
	standard: CodingStandard;
	onEdit: () => void;
}

export const CodingStandardCard: React.FC<CodingStandardCardProps> = ({ standard, onEdit }) => {
	return (
		<div className="group relative rounded-xl border border-gray-200 dark:border-gray-700 bg-white/50 dark:bg-gray-800/50 backdrop-blur-sm p-6 hover:border-yellow-500/50 hover:shadow-lg hover:shadow-yellow-500/20 transition-all duration-200">
			<div className="flex items-start justify-between gap-4">
				<div className="flex items-start gap-4 flex-1 min-w-0">
					<div className="flex-shrink-0 w-12 h-12 rounded-lg bg-gradient-to-br from-yellow-500/20 to-orange-500/20 flex items-center justify-center border border-yellow-500/30">
						<Code className="w-6 h-6 text-yellow-600 dark:text-yellow-400" />
					</div>

					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-2 mb-1">
							<h3 className="font-semibold text-gray-900 dark:text-white truncate">{standard.name}</h3>
							<span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-300 border border-yellow-200 dark:border-yellow-800">
								{standard.language}
							</span>
						</div>

						{standard.description && (
							<p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-2 mb-2">{standard.description}</p>
						)}

						<div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
							<span>Slug: {standard.slug}</span>
							<span>Rules: {Object.keys(standard.standards).length}</span>
						</div>
					</div>
				</div>

				<Button
					size="sm"
					variant="ghost"
					onClick={onEdit}
					className="opacity-0 group-hover:opacity-100 transition-opacity"
				>
					<Edit2 className="w-4 h-4" />
				</Button>
			</div>
		</div>
	);
};

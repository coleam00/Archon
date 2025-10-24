/**
 * Utility functions and constants for work order styling
 */

export const ItemTypes = {
	WORK_ORDER: "work_order",
} as const;

/**
 * Get column glow color based on status
 */
export function getColumnGlow(status: string): string {
	switch (status) {
		case "todo":
			return "bg-gradient-to-r from-transparent via-gray-500 to-transparent";
		case "in_progress":
			return "bg-gradient-to-r from-transparent via-blue-500 to-transparent";
		case "review":
			return "bg-gradient-to-r from-transparent via-yellow-500 to-transparent";
		case "done":
			return "bg-gradient-to-r from-transparent via-green-500 to-transparent";
		default:
			return "bg-gradient-to-r from-transparent via-gray-500 to-transparent";
	}
}

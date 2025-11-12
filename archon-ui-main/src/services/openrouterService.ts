/**
 * OpenRouter Service Client
 *
 * Provides frontend API client for OpenRouter model discovery.
 */

import { getApiUrl } from "../config/api";

// Type definitions for OpenRouter API responses
export interface OpenRouterEmbeddingModel {
	id: string;
	provider: string;
	name: string;
	dimensions: number;
	context_length: number;
	pricing_per_1m_tokens: number;
	supports_dimension_reduction: boolean;
}

export interface OpenRouterModelListResponse {
	embedding_models: OpenRouterEmbeddingModel[];
	total_count: number;
}

class OpenRouterService {
	private getBaseUrl = () => getApiUrl();
	private cacheKey = "openrouter_models_cache";
	private cacheTTL = 5 * 60 * 1000; // 5 minutes

	private handleApiError(error: unknown, context: string): Error {
		const errorMessage = error instanceof Error ? error.message : String(error);

		// Check for network errors
		if (
			errorMessage.toLowerCase().includes("network") ||
			errorMessage.includes("fetch") ||
			errorMessage.includes("Failed to fetch")
		) {
			return new Error(
				`Network error while ${context.toLowerCase()}: ${errorMessage}. ` +
					"Please check your connection.",
			);
		}

		// Check for timeout errors
		if (errorMessage.includes("timeout") || errorMessage.includes("AbortError")) {
			return new Error(
				`Timeout error while ${context.toLowerCase()}: The server may be slow to respond.`,
			);
		}

		// Return original error with context
		return new Error(`${context} failed: ${errorMessage}`);
	}

	/**
	 * Type guard to validate cache entry structure
	 */
	private isCacheEntry(
		value: unknown,
	): value is { data: OpenRouterModelListResponse; timestamp: number } {
		if (typeof value !== "object" || value === null) {
			return false;
		}

		const obj = value as Record<string, unknown>;

		// Validate timestamp is a number
		if (typeof obj.timestamp !== "number") {
			return false;
		}

		// Validate data property exists and is an object
		if (typeof obj.data !== "object" || obj.data === null) {
			return false;
		}

		const data = obj.data as Record<string, unknown>;

		// Validate OpenRouterModelListResponse structure
		if (!Array.isArray(data.embedding_models)) {
			return false;
		}

		if (typeof data.total_count !== "number") {
			return false;
		}

		// Validate each model in the array has required fields
		for (const model of data.embedding_models) {
			if (typeof model !== "object" || model === null) {
				return false;
			}
			const m = model as Record<string, unknown>;
			if (
				typeof m.id !== "string" ||
				typeof m.provider !== "string" ||
				typeof m.name !== "string" ||
				typeof m.dimensions !== "number" ||
				typeof m.context_length !== "number" ||
				typeof m.pricing_per_1m_tokens !== "number" ||
				typeof m.supports_dimension_reduction !== "boolean"
			) {
				return false;
			}
		}

		return true;
	}

	/**
	 * Get cached models if available and not expired
	 */
	private getCachedModels(): OpenRouterModelListResponse | null {
		try {
			const cached = sessionStorage.getItem(this.cacheKey);
			if (!cached) return null;

			const parsed: unknown = JSON.parse(cached);

			// Validate cache structure
			if (!this.isCacheEntry(parsed)) {
				// Cache is corrupted, remove it to avoid repeated failures
				sessionStorage.removeItem(this.cacheKey);
				return null;
			}

			const now = Date.now();

			// Check expiration
			if (now - parsed.timestamp > this.cacheTTL) {
				sessionStorage.removeItem(this.cacheKey);
				return null;
			}

			return parsed.data;
		} catch {
			// JSON parsing failed or other error, clear cache
			sessionStorage.removeItem(this.cacheKey);
			return null;
		}
	}

	/**
	 * Cache models for the TTL duration
	 */
	private cacheModels(data: OpenRouterModelListResponse): void {
		try {
			const cacheData = {
				data,
				timestamp: Date.now(),
			};
			sessionStorage.setItem(this.cacheKey, JSON.stringify(cacheData));
		} catch {
			// Ignore cache errors
		}
	}

	/**
	 * Discover available OpenRouter embedding models
	 */
	async discoverModels(): Promise<OpenRouterModelListResponse> {
		try {
			// Check cache first
			const cached = this.getCachedModels();
			if (cached) {
				return cached;
			}

			const response = await fetch(`${this.getBaseUrl()}/api/openrouter/models`, {
				method: "GET",
				headers: {
					"Content-Type": "application/json",
				},
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`HTTP ${response.status}: ${errorText}`);
			}

			const data = await response.json();

			// Validate response structure
			if (!data.embedding_models || !Array.isArray(data.embedding_models)) {
				throw new Error("Invalid response structure: missing or invalid embedding_models array");
			}

			if (typeof data.total_count !== "number" || data.total_count < 0) {
				throw new Error("Invalid response structure: total_count must be a non-negative number");
			}

			if (data.total_count !== data.embedding_models.length) {
				throw new Error(
					`Response structure mismatch: total_count (${data.total_count}) does not match embedding_models length (${data.embedding_models.length})`,
				);
			}

			// Validate at least one model has required fields
			if (data.embedding_models.length > 0) {
				const firstModel = data.embedding_models[0];
				if (
					!firstModel.id ||
					typeof firstModel.id !== "string" ||
					!firstModel.provider ||
					typeof firstModel.provider !== "string" ||
					typeof firstModel.dimensions !== "number" ||
					firstModel.dimensions <= 0
				) {
					throw new Error(
						"Invalid model structure: models must have id (string), provider (string), and positive dimensions",
					);
				}

				// Validate provider name is from expected set
				const validProviders = ["openai", "google", "qwen", "mistralai"];
				if (!validProviders.includes(firstModel.provider)) {
					throw new Error(`Invalid provider name: ${firstModel.provider}`);
				}
			}

			// Cache the successful response
			this.cacheModels(data);

			return data;
		} catch (error) {
			throw this.handleApiError(error, "Model discovery");
		}
	}

	/**
	 * Clear the models cache
	 */
	clearCache(): void {
		try {
			sessionStorage.removeItem(this.cacheKey);
		} catch {
			// Ignore cache clearing errors
		}
	}
}

// Export singleton instance
export const openrouterService = new OpenRouterService();

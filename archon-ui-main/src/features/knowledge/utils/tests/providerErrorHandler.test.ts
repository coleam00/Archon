import { describe, expect, it } from "vitest";
import { getProviderErrorMessage, type ProviderError, parseProviderError } from "../providerErrorHandler";

describe("providerErrorHandler", () => {
  describe("parseProviderError", () => {
    it("should handle basic Error objects", () => {
      const error = new Error("Basic error message");
      const result = parseProviderError(error);

      expect(result.message).toBe("Basic error message");
      expect(result.isProviderError).toBeUndefined();
    });

    it("should handle errors with statusCode property", () => {
      const error = { statusCode: 401, message: "Unauthorized" };
      const result = parseProviderError(error);

      expect(result.statusCode).toBe(401);
      expect(result.message).toBe("Unauthorized");
    });

    it("should handle errors with status property", () => {
      const error = { status: 429, message: "Rate limited" };
      const result = parseProviderError(error);

      expect(result.statusCode).toBe(429);
      expect(result.message).toBe("Rate limited");
    });

    it("should prioritize statusCode over status when both are present", () => {
      const error = { statusCode: 401, status: 429, message: "Auth error" };
      const result = parseProviderError(error);

      expect(result.statusCode).toBe(401);
    });

    it("should parse structured provider errors from backend", () => {
      const error = {
        message: JSON.stringify({
          detail: {
            error_type: "authentication_failed",
            provider: "OpenAI",
            message: "Invalid API key",
          },
        }),
      };

      const result = parseProviderError(error);

      expect(result.isProviderError).toBe(true);
      expect(result.provider).toBe("OpenAI");
      expect(result.errorType).toBe("authentication_failed");
      expect(result.message).toBe("Invalid API key");
    });

    it("should handle malformed JSON in message gracefully", () => {
      const error = {
        message: "invalid json { detail",
      };

      const result = parseProviderError(error);

      expect(result.isProviderError).toBeUndefined();
      expect(result.message).toBe("invalid json { detail");
    });

    it("should handle null and undefined inputs safely", () => {
      expect(() => parseProviderError(null)).not.toThrow();
      expect(() => parseProviderError(undefined)).not.toThrow();

      const nullResult = parseProviderError(null);
      const undefinedResult = parseProviderError(undefined);

      expect(nullResult).toBeDefined();
      expect(undefinedResult).toBeDefined();
    });

    it("should handle empty objects", () => {
      const result = parseProviderError({});

      expect(result).toBeDefined();
      expect(result.statusCode).toBeUndefined();
      expect(result.isProviderError).toBeUndefined();
    });

    it("should handle primitive values", () => {
      expect(() => parseProviderError("string error")).not.toThrow();
      expect(() => parseProviderError(42)).not.toThrow();
      expect(() => parseProviderError(true)).not.toThrow();
    });

    it("should handle structured errors without provider field", () => {
      const error = {
        message: JSON.stringify({
          detail: {
            error_type: "quota_exhausted",
            message: "Usage limit exceeded",
          },
        }),
      };

      const result = parseProviderError(error);

      expect(result.isProviderError).toBe(true);
      expect(result.provider).toBe("LLM"); // Default fallback
      expect(result.errorType).toBe("quota_exhausted");
      expect(result.message).toBe("Usage limit exceeded");
    });

    it("should handle partial structured errors", () => {
      const error = {
        message: JSON.stringify({
          detail: {
            error_type: "rate_limit",
            // Missing message field
          },
        }),
      };

      const result = parseProviderError(error);

      expect(result.isProviderError).toBe(true);
      expect(result.errorType).toBe("rate_limit");
      expect(result.message).toBe(error.message); // Falls back to original message
    });
  });

  describe("getProviderErrorMessage", () => {
    it("should return user-friendly message for authentication_failed", () => {
      const error: ProviderError = {
        name: "Error",
        message: "Auth failed",
        isProviderError: true,
        provider: "OpenAI",
        errorType: "authentication_failed",
      };

      const result = getProviderErrorMessage(error);
      expect(result).toBe("Please verify your OpenAI API key in Settings.");
    });

    it("should return user-friendly message for quota_exhausted", () => {
      const error: ProviderError = {
        name: "Error",
        message: "Quota exceeded",
        isProviderError: true,
        provider: "Google AI",
        errorType: "quota_exhausted",
      };

      const result = getProviderErrorMessage(error);
      expect(result).toBe("Google AI quota exhausted. Please check your billing settings.");
    });

    it("should return user-friendly message for rate_limit", () => {
      const error: ProviderError = {
        name: "Error",
        message: "Rate limited",
        isProviderError: true,
        provider: "Anthropic",
        errorType: "rate_limit",
      };

      const result = getProviderErrorMessage(error);
      expect(result).toBe("Anthropic rate limit exceeded. Please wait and try again.");
    });

    it("should return generic provider message for unknown error types", () => {
      const error: ProviderError = {
        name: "Error",
        message: "Unknown error",
        isProviderError: true,
        provider: "OpenAI",
        errorType: "unknown_error",
      };

      const result = getProviderErrorMessage(error);
      expect(result).toBe("OpenAI API error. Please check your configuration.");
    });

    it("should use default provider when provider is missing", () => {
      const error: ProviderError = {
        name: "Error",
        message: "Auth failed",
        isProviderError: true,
        errorType: "authentication_failed",
      };

      const result = getProviderErrorMessage(error);
      expect(result).toBe("Please verify your LLM API key in Settings.");
    });

    it("should handle 401 status code for non-provider errors", () => {
      const error = { statusCode: 401, message: "Unauthorized" };

      const result = getProviderErrorMessage(error);
      expect(result).toBe("Please verify your API key in Settings.");
    });

    it("should return original message for non-provider errors", () => {
      const error = new Error("Network connection failed");

      const result = getProviderErrorMessage(error);
      expect(result).toBe("Network connection failed");
    });

    it("should return default message when no message is available", () => {
      const error = {};

      const result = getProviderErrorMessage(error);
      expect(result).toBe("An error occurred.");
    });

    it("should handle complex error objects with structured backend response", () => {
      const backendError = {
        statusCode: 400,
        message: JSON.stringify({
          detail: {
            error_type: "authentication_failed",
            provider: "OpenAI",
            message: "API key invalid or expired",
          },
        }),
      };

      const result = getProviderErrorMessage(backendError);
      expect(result).toBe("Please verify your OpenAI API key in Settings.");
    });

    it('should handle edge case: message contains "detail" but is not JSON', () => {
      const error = {
        message: "Error detail: something went wrong",
      };

      const result = getProviderErrorMessage(error);
      expect(result).toBe("Error detail: something went wrong");
    });

    it("should handle null and undefined gracefully", () => {
      expect(getProviderErrorMessage(null)).toBe("An error occurred.");
      expect(getProviderErrorMessage(undefined)).toBe("An error occurred.");
    });
  });

  describe("TypeScript strict mode compliance", () => {
    it("should handle type-safe property access", () => {
      // Test that our type guards work properly
      const errorWithStatus = { statusCode: 500 };
      const errorWithMessage = { message: "test" };
      const errorWithBoth = { statusCode: 401, message: "unauthorized" };

      // These should not throw TypeScript errors and should work correctly
      expect(() => parseProviderError(errorWithStatus)).not.toThrow();
      expect(() => parseProviderError(errorWithMessage)).not.toThrow();
      expect(() => parseProviderError(errorWithBoth)).not.toThrow();

      const result1 = parseProviderError(errorWithStatus);
      const result2 = parseProviderError(errorWithMessage);
      const result3 = parseProviderError(errorWithBoth);

      expect(result1.statusCode).toBe(500);
      expect(result2.message).toBe("test");
      expect(result3.statusCode).toBe(401);
      expect(result3.message).toBe("unauthorized");
    });

    it("should handle objects without expected properties safely", () => {
      const objectWithoutStatus = { someOtherProperty: "value" };
      const objectWithoutMessage = { anotherProperty: 42 };

      expect(() => parseProviderError(objectWithoutStatus)).not.toThrow();
      expect(() => parseProviderError(objectWithoutMessage)).not.toThrow();

      const result1 = parseProviderError(objectWithoutStatus);
      const result2 = parseProviderError(objectWithoutMessage);

      expect(result1.statusCode).toBeUndefined();
      expect(result2.message).toBeUndefined();
    });
  });
});

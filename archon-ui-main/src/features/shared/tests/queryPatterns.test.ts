import { describe, expect, it } from "vitest";
import { createRetryLogic } from "../queryPatterns";

describe("createRetryLogic", () => {
  describe("should retry network and server errors", () => {
    it("should retry network errors", () => {
      const retryLogic = createRetryLogic(3);

      const networkError = new Error("Network error");

      expect(retryLogic(0, networkError)).toBe(true); // First retry
      expect(retryLogic(1, networkError)).toBe(true); // Second retry
      expect(retryLogic(2, networkError)).toBe(true); // Third retry
      expect(retryLogic(3, networkError)).toBe(false); // Exhausted retries
    });

    it("should retry 5xx server errors", () => {
      const retryLogic = createRetryLogic(3);

      const serverError = { statusCode: 500, message: "Internal Server Error" };

      expect(retryLogic(0, serverError)).toBe(true); // Should retry 500
      expect(retryLogic(1, serverError)).toBe(true);
      expect(retryLogic(2, serverError)).toBe(true);
      expect(retryLogic(3, serverError)).toBe(false); // Max retries reached
    });

    it("should retry 502 bad gateway errors", () => {
      const retryLogic = createRetryLogic(2);

      const badGatewayError = { status: 502 };

      expect(retryLogic(0, badGatewayError)).toBe(true);
      expect(retryLogic(1, badGatewayError)).toBe(true);
      expect(retryLogic(2, badGatewayError)).toBe(false);
    });
  });

  describe("should NOT retry client errors", () => {
    it("should NOT retry 400 bad request", () => {
      const retryLogic = createRetryLogic(3);

      const badRequestError = { statusCode: 400, message: "Bad Request" };

      expect(retryLogic(0, badRequestError)).toBe(false);
      expect(retryLogic(1, badRequestError)).toBe(false);
    });

    it("should NOT retry 401 unauthorized", () => {
      const retryLogic = createRetryLogic(3);

      const unauthorizedError = { status: 401 };

      expect(retryLogic(0, unauthorizedError)).toBe(false);
    });

    it("should NOT retry 404 not found", () => {
      const retryLogic = createRetryLogic(3);

      const notFoundError = { statusCode: 404, message: "Not Found" };

      expect(retryLogic(0, notFoundError)).toBe(false);
    });

    it("should NOT retry 422 validation errors", () => {
      const retryLogic = createRetryLogic(3);

      const validationError = { status: 422 };

      expect(retryLogic(0, validationError)).toBe(false);
    });

    it("should NOT retry 429 rate limit (4xx range)", () => {
      const retryLogic = createRetryLogic(3);

      const rateLimitError = { statusCode: 429 };

      expect(retryLogic(0, rateLimitError)).toBe(false);
    });
  });

  describe("should NOT retry abort errors", () => {
    it("should NOT retry AbortError by name", () => {
      const retryLogic = createRetryLogic(3);

      const abortError = { name: "AbortError", message: "Request aborted" };

      expect(retryLogic(0, abortError)).toBe(false);
      expect(retryLogic(1, abortError)).toBe(false);
    });

    it("should NOT retry ERR_CANCELED by code", () => {
      const retryLogic = createRetryLogic(3);

      const cancelError = { code: "ERR_CANCELED", message: "Request canceled" };

      expect(retryLogic(0, cancelError)).toBe(false);
    });

    it("should NOT retry axios cancel token", () => {
      const retryLogic = createRetryLogic(3);

      const axiosCancelError = {
        name: "AbortError",
        code: "ERR_CANCELED",
        message: "Request canceled"
      };

      expect(retryLogic(0, axiosCancelError)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should handle null/undefined errors", () => {
      const retryLogic = createRetryLogic(2);

      expect(retryLogic(0, null)).toBe(true); // No status, so retry
      expect(retryLogic(0, undefined)).toBe(true);
      expect(retryLogic(0, "string error")).toBe(true);
    });

    it("should respect maxRetries parameter", () => {
      const retryLogic1 = createRetryLogic(1);
      const retryLogic5 = createRetryLogic(5);

      const networkError = new Error("Network timeout");

      // MaxRetries = 1
      expect(retryLogic1(0, networkError)).toBe(true);
      expect(retryLogic1(1, networkError)).toBe(false);

      // MaxRetries = 5
      expect(retryLogic5(0, networkError)).toBe(true);
      expect(retryLogic5(4, networkError)).toBe(true);
      expect(retryLogic5(5, networkError)).toBe(false);
    });

    it("should default to 2 retries when no maxRetries specified", () => {
      const retryLogic = createRetryLogic(); // No parameter

      const error = new Error("Some error");

      expect(retryLogic(0, error)).toBe(true);
      expect(retryLogic(1, error)).toBe(true);
      expect(retryLogic(2, error)).toBe(false); // Default max is 2
    });

    it("should handle errors with multiple status properties", () => {
      const retryLogic = createRetryLogic(3);

      // Object with both status and statusCode (statusCode takes precedence)
      const mixedError = {
        status: 500,
        statusCode: 404,
        message: "Conflict"
      };

      expect(retryLogic(0, mixedError)).toBe(false); // 404 (statusCode) = no retry
    });
  });

  describe("integration with ollamaService patterns", () => {
    it("should handle ollama-specific error scenarios", () => {
      const retryLogic = createRetryLogic(3);

      // Model not found (404) - don't retry
      const modelNotFoundError = {
        statusCode: 404,
        message: "Model 'llama2' not found"
      };
      expect(retryLogic(0, modelNotFoundError)).toBe(false);

      // Connection timeout - retry
      const timeoutError = new Error("Connection timeout");
      expect(retryLogic(0, timeoutError)).toBe(true);

      // Server overloaded (503) - retry
      const overloadedError = { status: 503, message: "Service unavailable" };
      expect(retryLogic(0, overloadedError)).toBe(true);
    });
  });
});
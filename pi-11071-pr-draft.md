# Draft PR — `earendil-works/pi`

**Target:** `earendil-works/pi`, base `main`
**Closes / refs:** #11071 (`ai: preserve structured provider failure metadata through AssistantMessage`) — this is the `openai-completions` slice of it, not the shared contract that issue asks for.
**Gate:** `CONTRIBUTING.md` says *"Do not open a PR unless you have already been approved by a maintainer using `lgtm`"*, and `lgtm` must appear in a maintainer reply on an issue. #11071 is open and has no `lgtm` yet, so this stays a draft until that reply exists.
**Preflight:** `npm run check` and `./test.sh` must both pass. `CHANGELOG.md` is not edited by contributors.

**Branch:** `ai/openai-completions-failure-status`
**Commit:** `fix(ai): keep an openai-completions failure's HTTP status in diagnostics`

---

## Patch

`packages/ai/src/api/openai-completions.ts`

```diff
@@ -38,7 +38,8 @@
 import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
+import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
@@ -721,7 +722,17 @@
 			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
-			output.errorMessage = formatProviderError(normalizeProviderError(error));
+			const normalized = normalizeProviderError(error);
+			output.errorMessage = formatProviderError(normalized);
+			// The status is the one failure fact a caller cannot recover once only the text
+			// is kept: a 429 retries, a 401 does not. `errorMessage` stays byte-identical,
+			// because `isRetryableAssistantError` matches against it.
+			if (normalized.status !== undefined) {
+				appendAssistantMessageDiagnostic(output, {
+					type: "openai_completions_response_failure",
+					timestamp: Date.now(),
+					details: { status: normalized.status },
+				});
+			}
 			// Some providers via OpenRouter give additional information in this field.
```

The shape is bedrock's (`api/bedrock-converse-stream.ts:497`, `bedrock_response_failure` with `details.status`), and the type name follows the existing per-adapter convention (`anthropic_thread_fallback`, `bedrock_response_failure`, `openai_input_transformations`, `pi_messages_rewrite`).

## Test

`packages/ai/test/openai-completions-failure-diagnostic.test.ts` — the harness is copied from `openai-completions-retry.test.ts` (its `withResponse()` rejects with an `Error` carrying `status`); only the mock error and the assertions differ.

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const mockState = vi.hoisted(() => ({ errors: [] as unknown[] }));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const stream = { async *[Symbol.asyncIterator]() {} };
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<never>;
					};
					promise.withResponse = async () => {
						throw mockState.errors.shift();
					};
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "opencode-go",
	baseUrl: "https://opencode.ai/zen/go/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const context = normalizeContext({
	systemPrompt: "",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
	tools: [],
});

async function consume() {
	const stream = streamOpenAICompletions(model, context, { apiKey: "test" });
	for await (const _event of stream) {
		void _event;
	}
	return stream.result();
}

const failure = (status: number, message: string) =>
	Object.assign(new Error(message), { status, headers: new Headers() });

describe("openai-completions failure diagnostics", () => {
	beforeEach(() => {
		mockState.errors = [];
	});

	it("records the HTTP status of a failed request", async () => {
		mockState.errors = [failure(429, "rate limited")];
		const result = await consume();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("429");
		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				type: "openai_completions_response_failure",
				details: { status: 429 },
			}),
		]);
	});

	it("keeps the error text unchanged when a status went with it", async () => {
		mockState.errors = [failure(401, "revoked key")];
		const result = await consume();

		expect(result.errorMessage).toBe("401: revoked key");
		expect(result.diagnostics?.[0]?.details).toEqual({ status: 401 });
	});

	it("adds no diagnostic when the failure carried no status", async () => {
		mockState.errors = [new Error("Connection error.")];
		const result = await consume();

		expect(result.errorMessage).toBe("Connection error.");
		expect(result.diagnostics).toBeUndefined();
	});
});
```

The second test is the one that matters for regression: `errorMessage` must stay byte-identical, because `isRetryableAssistantError` matches against it.

## PR body

### Problem and outcome

An `openai-completions` request that fails with an HTTP status keeps the status only inside `errorMessage`. `normalizeProviderError()` already computes it as a typed field (`NormalizedProviderError.status`), the catch then folds it into display text, and nothing records it structurally — so a caller that must decide whether to retry (429), stop (401) or wait (503) has only a string, and ends up parsing it to decide control flow.

- **Outcome:** a failed `openai-completions` turn carries `diagnostics[0].details.status` when the request had an HTTP status. The error text is unchanged.
- **Invariant:** `errorMessage` stays byte-identical, because `isRetryableAssistantError` matches against it. No diagnostic is added when there was no status.
- **Scope boundary:** this is the `openai-completions` slice only. The shared contract #11071 asks for — provider error code, `Retry-After`, explicit retryability, and the same treatment for the Azure and Responses catches — is deliberately not attempted here.

### Evidence

Bedrock's adapter already does exactly this (`details.status` in a `bedrock_response_failure` diagnostic), so the mechanism, the helper and the shape all exist; only this adapter is missing from the list. `appendAssistantMessageDiagnostic` is called today by `anthropic-messages`, `bedrock-converse-stream`, `openai-codex-responses`, `openai-responses-shared` and `pi-messages`.

### Validation

- `packages/ai/test/openai-completions-failure-diagnostic.test.ts` — the three cases above, SDK-mocked, no network.
- `npm run check` and `./test.sh` — to be run before submission; neither has been run for this draft.

### Known limits

- When the provider-requested delay exceeds `maxRetryDelayMs`, `provider-retry.ts` replaces the SDK error with its own, and the structured facts go with it — the same gap `LuisQin01` listed on #11071. Not addressed here.
- `Sensirex` has a Responses-path patch and `LuisQin01` a broader five-gap candidate on the same issue. This draft overlaps the first gap in that list, so it should land only if a maintainer prefers it shaped this way, or be reduced to whatever slice is still missing.

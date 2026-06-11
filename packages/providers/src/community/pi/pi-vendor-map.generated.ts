/**
 * AUTO-GENERATED — DO NOT EDIT.
 *
 * Regenerate with: bun run generate:pi-vendor-map
 * Verify up-to-date: bun run check:pi-vendor-map
 *
 * Source of truth: the installed @earendil-works/pi-ai SDK
 * (dist/env-api-keys.js + dist/models.generated.js).
 *
 * Single source for (a) the Pi runtime env-var bridge and (b) the
 * connectable-credential specs in the Pi provider registration. A pi-ai
 * upgrade that adds/renames backends fails `bun run validate` until this
 * file is regenerated (and any new backend is classified in the generator).
 */
import type { CredentialSpec } from '../../types';

/**
 * Pi backend vendor id → the env var pi-ai reads for its API key
 * (and the var Archon's per-user delivery sets).
 */
export const PI_PROVIDER_ENV_VARS: Record<string, string> = {
  "ant-ling": "ANT_LING_API_KEY",
  "anthropic": "ANTHROPIC_API_KEY",
  "azure-openai-responses": "AZURE_OPENAI_API_KEY",
  "cerebras": "CEREBRAS_API_KEY",
  "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
  "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
  "deepseek": "DEEPSEEK_API_KEY",
  "fireworks": "FIREWORKS_API_KEY",
  "github-copilot": "COPILOT_GITHUB_TOKEN",
  "google": "GEMINI_API_KEY",
  "google-vertex": "GOOGLE_CLOUD_API_KEY",
  "groq": "GROQ_API_KEY",
  "huggingface": "HF_TOKEN",
  "kimi-coding": "KIMI_API_KEY",
  "minimax": "MINIMAX_API_KEY",
  "minimax-cn": "MINIMAX_CN_API_KEY",
  "mistral": "MISTRAL_API_KEY",
  "moonshotai": "MOONSHOT_API_KEY",
  "moonshotai-cn": "MOONSHOT_API_KEY",
  "nvidia": "NVIDIA_API_KEY",
  "openai": "OPENAI_API_KEY",
  "opencode": "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  "openrouter": "OPENROUTER_API_KEY",
  "together": "TOGETHER_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  "xai": "XAI_API_KEY",
  "xiaomi": "XIAOMI_API_KEY",
  "xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "zai": "ZAI_API_KEY",
  "zai-coding-cn": "ZAI_CODING_CN_API_KEY",
};

/** Vendors authenticated via ambient cloud credential chains (status-only). */
export const PI_AMBIENT_VENDORS: readonly string[] = ["amazon-bedrock","google-vertex"];

/** Credential specs for the Pi provider registration (consumption matrix). */
export const PI_CREDENTIAL_SPECS: CredentialSpec[] = [
  { vendor: "amazon-bedrock", displayName: "Amazon Bedrock", kinds: ["ambient"] },
  { vendor: "ant-ling", displayName: "Ant Ling", kinds: ["api_key"] },
  { vendor: "anthropic", displayName: "Anthropic", kinds: ["api_key", "subscription"] },
  { vendor: "azure-openai-responses", displayName: "Azure OpenAI", kinds: ["api_key"] },
  { vendor: "cerebras", displayName: "Cerebras", kinds: ["api_key"] },
  { vendor: "cloudflare-ai-gateway", displayName: "Cloudflare AI Gateway", kinds: ["api_key"] },
  { vendor: "cloudflare-workers-ai", displayName: "Cloudflare Workers AI", kinds: ["api_key"] },
  { vendor: "deepseek", displayName: "DeepSeek", kinds: ["api_key"] },
  { vendor: "fireworks", displayName: "Fireworks AI", kinds: ["api_key"] },
  { vendor: "github-copilot", displayName: "GitHub Copilot", kinds: ["api_key", "subscription"] },
  { vendor: "google", displayName: "Google Gemini", kinds: ["api_key"] },
  { vendor: "google-vertex", displayName: "Google Vertex AI", kinds: ["api_key", "ambient"] },
  { vendor: "groq", displayName: "Groq", kinds: ["api_key"] },
  { vendor: "huggingface", displayName: "Hugging Face", kinds: ["api_key"] },
  { vendor: "kimi-coding", displayName: "Kimi Coding", kinds: ["api_key"] },
  { vendor: "minimax", displayName: "MiniMax", kinds: ["api_key"] },
  { vendor: "minimax-cn", displayName: "MiniMax (CN)", kinds: ["api_key"] },
  { vendor: "mistral", displayName: "Mistral", kinds: ["api_key"] },
  { vendor: "moonshotai", displayName: "Moonshot AI", kinds: ["api_key"] },
  { vendor: "moonshotai-cn", displayName: "Moonshot AI (CN)", kinds: ["api_key"] },
  { vendor: "nvidia", displayName: "Nvidia", kinds: ["api_key"] },
  { vendor: "openai", displayName: "OpenAI", kinds: ["api_key", "subscription"] },
  { vendor: "opencode", displayName: "OpenCode Zen", kinds: ["api_key"] },
  { vendor: "opencode-go", displayName: "OpenCode Zen (Go)", kinds: ["api_key"] },
  { vendor: "openrouter", displayName: "OpenRouter", kinds: ["api_key"] },
  { vendor: "together", displayName: "Together AI", kinds: ["api_key"] },
  { vendor: "vercel-ai-gateway", displayName: "Vercel AI Gateway", kinds: ["api_key"] },
  { vendor: "xai", displayName: "xAI", kinds: ["api_key"] },
  { vendor: "xiaomi", displayName: "Xiaomi", kinds: ["api_key"] },
  { vendor: "xiaomi-token-plan-ams", displayName: "Xiaomi Token Plan (AMS)", kinds: ["api_key"] },
  { vendor: "xiaomi-token-plan-cn", displayName: "Xiaomi Token Plan (CN)", kinds: ["api_key"] },
  { vendor: "xiaomi-token-plan-sgp", displayName: "Xiaomi Token Plan (SGP)", kinds: ["api_key"] },
  { vendor: "zai", displayName: "Z.AI", kinds: ["api_key"] },
  { vendor: "zai-coding-cn", displayName: "Zai Coding Cn", kinds: ["api_key"] },
];

import { useState } from "react";
import { Key, ExternalLink, Save, Loader } from "lucide-react";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { useToast } from "../../features/ui/hooks/useToast";
import { credentialsService } from "../../services/credentialsService";

interface ProviderStepProps {
  onSaved: () => void;
  onSkip: () => void;
}

export const ProviderStep = ({ onSaved, onSkip }: ProviderStepProps) => {
  const [provider, setProvider] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  const handleSave = async () => {
    if (!apiKey.trim()) {
      showToast("Please enter an API key", "error");
      return;
    }

    setSaving(true);
    try {
      // Save the API key
      await credentialsService.createCredential({
        key: "OPENAI_API_KEY",
        value: apiKey,
        is_encrypted: true,
        category: "api_keys",
      });

      // Update the provider setting if needed
      await credentialsService.updateCredential({
        key: "LLM_PROVIDER",
        value: "openai",
        is_encrypted: false,
        category: "rag_strategy",
      });

      showToast("API key saved successfully!", "success");
      // Mark onboarding as dismissed when API key is saved
      localStorage.setItem("onboardingDismissed", "true");
      onSaved();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to save API key:", error);

      // Show specific error details to help user resolve the issue
      if (
        errorMessage.includes("duplicate") ||
        errorMessage.includes("already exists")
      ) {
        showToast(
          "API key already exists. Please update it in Settings if you want to change it.",
          "warning",
        );
      } else if (
        errorMessage.includes("network") ||
        errorMessage.includes("fetch")
      ) {
        showToast(
          `Network error while saving API key: ${errorMessage}. Please check your connection.`,
          "error",
        );
      } else {
        // Show the actual error for unknown issues
        showToast(`Failed to save API key: ${errorMessage}`, "error");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSkip = () => {
    showToast("You can configure your provider in Settings", "info");
    // Mark onboarding as dismissed when skipping
    localStorage.setItem("onboardingDismissed", "true");
    onSkip();
  };

  return (
    <div className="space-y-6">
      {/* Provider Selection */}
      <div>
        <Select
          label="Select AI Provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          options={[
            { value: "openai", label: "OpenAI" },
            { value: "google", label: "Google Gemini" },
            { value: "ollama", label: "Ollama (Local)" },
          ]}
          accentColor="green"
        />
        <p className="mt-2 text-sm text-gray-600 dark:text-zinc-400">
          {provider === "openai" &&
            "OpenAI provides powerful models like GPT-4. You'll need an API key from OpenAI."}
          {provider === "google" &&
            "Google Gemini offers advanced AI capabilities. Configure in Settings after setup."}
          {provider === "ollama" &&
            "Ollama runs models locally on your machine. Configure in Settings after setup."}
        </p>
      </div>

      {/* OpenAI API Key Input */}
      {provider === "openai" && (
        <>
          <div>
            <Input
              label="OpenAI API Key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              accentColor="green"
              icon={<Key className="w-4 h-4" />}
            />
            <p className="mt-2 text-sm text-gray-600 dark:text-zinc-400">
              Your API key will be encrypted and stored securely.
            </p>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <a
              href="https://platform.openai.com/api-keys"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 flex items-center gap-1"
            >
              Get an API key from OpenAI
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>

          <div className="flex gap-3 pt-4">
            <Button
              variant="primary"
              size="lg"
              onClick={handleSave}
              disabled={saving || !apiKey.trim()}
              icon={
                saving ? (
                  <Loader className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )
              }
              className="flex-1"
            >
              {saving ? "Saving..." : "Save & Continue"}
            </Button>
            <Button
              variant="outline"
              size="lg"
              onClick={handleSkip}
              disabled={saving}
              className="flex-1"
            >
              Skip for Now
            </Button>
          </div>
        </>
      )}

      {/* Non-OpenAI Provider Message */}
      {provider !== "openai" && (
        <div className="space-y-4">
          <div className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
            <p className="text-sm text-blue-800 dark:text-blue-200">
              {provider === "google" &&
                "Google Gemini configuration will be available in Settings after setup."}
              {provider === "ollama" &&
                "Ollama configuration will be available in Settings after setup. Make sure Ollama is running locally."}
            </p>
          </div>

          <div className="flex gap-3 pt-4">
            <Button
              variant="primary"
              size="lg"
              onClick={async () => {
                // Save the provider selection for non-OpenAI providers
                try {
                  await credentialsService.updateCredential({
                    key: "LLM_PROVIDER",
                    value: provider,
                    is_encrypted: false,
                    category: "rag_strategy",
                  });
                  showToast(
                    `${provider === "google" ? "Google Gemini" : "Ollama"} selected as provider`,
                    "success",
                  );
                  // Mark onboarding as dismissed
                  localStorage.setItem("onboardingDismissed", "true");
                  onSaved();
                } catch (error) {
                  console.error("Failed to save provider selection:", error);
                  showToast("Failed to save provider selection", "error");
                }
              }}
              className="flex-1"
            >
              Continue with {provider === "google" ? "Gemini" : "Ollama"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

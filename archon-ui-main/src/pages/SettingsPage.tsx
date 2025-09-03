import { useState, useEffect } from "react";
import {
  Loader,
  Settings,
  ChevronDown,
  ChevronUp,
  Palette,
  Key,
  Brain,
  Code,
  FileCode,
  Bug,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useToast } from "../contexts/ToastContext";
import { useSettings } from "../contexts/SettingsContext";
import { useStaggeredEntrance } from "../hooks/useStaggeredEntrance";
import { FeaturesSection } from "../components/settings/FeaturesSection";
import { APIKeysSection } from "../components/settings/APIKeysSection";
import { RAGSettings } from "../components/settings/RAGSettings";
import { CodeExtractionSettings } from "../components/settings/CodeExtractionSettings";
import { IDEGlobalRules } from "../components/settings/IDEGlobalRules";
import { ButtonPlayground } from "../components/settings/ButtonPlayground";
import { CollapsibleSettingsCard } from "../components/ui/CollapsibleSettingsCard";
import { BugReportButton } from "../components/bug-report/BugReportButton";
import {
  credentialsService,
  RagSettings,
  CodeExtractionSettings as CodeExtractionSettingsType,
} from "../services/credentialsService";

export const SettingsPage = () => {
  const [ragSettings, setRagSettings] = useState<RagSettings>({
    USE_CONTEXTUAL_EMBEDDINGS: false,
    CONTEXTUAL_EMBEDDINGS_MAX_WORKERS: 3,
    USE_HYBRID_SEARCH: true,
    USE_AGENTIC_RAG: true,
    USE_RERANKING: true,
    MODEL_CHOICE: "gpt-4.1-nano",
  });
  const [codeExtractionSettings, setCodeExtractionSettings] =
    useState<CodeExtractionSettingsType>({
      MIN_CODE_BLOCK_LENGTH: 250,
      MAX_CODE_BLOCK_LENGTH: 5000,
      ENABLE_COMPLETE_BLOCK_DETECTION: true,
      ENABLE_LANGUAGE_SPECIFIC_PATTERNS: true,
      ENABLE_PROSE_FILTERING: true,
      MAX_PROSE_RATIO: 0.15,
      MIN_CODE_INDICATORS: 3,
      ENABLE_DIAGRAM_FILTERING: true,
      ENABLE_CONTEXTUAL_LENGTH: true,
      CODE_EXTRACTION_MAX_WORKERS: 3,
      CONTEXT_WINDOW_SIZE: 1000,
      ENABLE_CODE_SUMMARIES: true,
    });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showButtonPlayground, setShowButtonPlayground] = useState(false);

  const { showToast } = useToast();
  const { projectsEnabled } = useSettings();

  // Use staggered entrance animation
  const { isVisible, containerVariants, itemVariants, titleVariants } =
    useStaggeredEntrance([1, 2, 3, 4], 0.15);

  // Load settings on mount
  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async (isRetry = false) => {
    try {
      setLoading(true);
      setError(null);

      // Load RAG settings
      const ragSettingsData = await credentialsService.getRagSettings();
      setRagSettings(ragSettingsData);

      // Load Code Extraction settings
      const codeExtractionSettingsData =
        await credentialsService.getCodeExtractionSettings();
      setCodeExtractionSettings(codeExtractionSettingsData);
    } catch (err) {
      setError("Failed to load settings");
      console.error(err);
      showToast("Failed to load settings", "error");
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader className="animate-spin text-gray-500" size={32} />
      </div>
    );
  }

  return (
    <motion.div
      initial="hidden"
      animate={isVisible ? "visible" : "hidden"}
      variants={containerVariants}
      className="w-full"
    >
      {/* Header */}
      <motion.div
        className="flex justify-between items-center mb-8"
        variants={itemVariants}
      >
        <motion.h1
          className="text-3xl font-bold text-gray-800 dark:text-white flex items-center gap-3"
          variants={titleVariants}
        >
          <Settings className="w-7 h-7 text-blue-500 filter drop-shadow-[0_0_8px_rgba(59,130,246,0.8)]" />
          Settings
        </motion.h1>
      </motion.div>


      {/* Main content with two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column */}
        <div className="space-y-6">
          <motion.div variants={itemVariants}>
            <CollapsibleSettingsCard
              title="Features"
              icon={Palette}
              accentColor="purple"
              storageKey="features"
              defaultExpanded={true}
            >
              <FeaturesSection />
            </CollapsibleSettingsCard>
          </motion.div>
          {projectsEnabled && (
            <motion.div variants={itemVariants}>
              <CollapsibleSettingsCard
                title="IDE Global Rules"
                icon={FileCode}
                accentColor="pink"
                storageKey="ide-rules"
                defaultExpanded={true}
              >
                <IDEGlobalRules />
              </CollapsibleSettingsCard>
            </motion.div>
          )}
        </div>

        {/* Right Column */}
        <div className="space-y-6">
          <motion.div variants={itemVariants}>
            <CollapsibleSettingsCard
              title="API Keys"
              icon={Key}
              accentColor="pink"
              storageKey="api-keys"
              defaultExpanded={true}
            >
              <APIKeysSection />
            </CollapsibleSettingsCard>
          </motion.div>
          <motion.div variants={itemVariants}>
            <CollapsibleSettingsCard
              title="RAG Settings"
              icon={Brain}
              accentColor="green"
              storageKey="rag-settings"
              defaultExpanded={true}
            >
              <RAGSettings
                ragSettings={ragSettings}
                setRagSettings={setRagSettings}
              />
            </CollapsibleSettingsCard>
          </motion.div>
          <motion.div variants={itemVariants}>
            <CollapsibleSettingsCard
              title="Code Extraction"
              icon={Code}
              accentColor="orange"
              storageKey="code-extraction"
              defaultExpanded={true}
            >
              <CodeExtractionSettings
                codeExtractionSettings={codeExtractionSettings}
                setCodeExtractionSettings={setCodeExtractionSettings}
              />
            </CollapsibleSettingsCard>
          </motion.div>

          {/* Bug Report Section */}
          <motion.div variants={itemVariants}>
            <CollapsibleSettingsCard
              title="Bug Reporting"
              icon={Bug}
              iconColor="text-red-500"
              borderColor="border-red-200 dark:border-red-800"
              defaultExpanded={false}
            >
              <div className="space-y-4">
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Found a bug or issue? Report it to help improve Archon V2
                  Alpha.
                </p>
                <div className="flex justify-start">
                  <BugReportButton variant="secondary" size="md">
                    Report Bug
                  </BugReportButton>
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
                  <p>• Bug reports are sent directly to GitHub Issues</p>
                  <p>• System context is automatically collected</p>
                  <p>• Your privacy is protected - no personal data is sent</p>
                </div>
              </div>
            </CollapsibleSettingsCard>
          </motion.div>
        </div>
      </div>

      {/* Button Playground Toggle - Subtle blue circle */}
      <motion.div variants={itemVariants} className="mt-12 flex justify-center">
        <button
          onClick={() => setShowButtonPlayground(!showButtonPlayground)}
          className="relative w-8 h-8 rounded-full border border-blue-400/30 bg-blue-500/5 hover:bg-blue-500/10 transition-all duration-200 flex items-center justify-center group"
          title="Toggle Button Playground"
        >
          <div className="absolute inset-0 rounded-full bg-blue-500/20 blur-sm opacity-0 group-hover:opacity-100 transition-opacity" />
          <motion.div
            animate={{ rotate: showButtonPlayground ? 180 : 0 }}
            transition={{ duration: 0.2 }}
          >
            <ChevronDown className="w-4 h-4 text-blue-400/50" />
          </motion.div>
        </button>
      </motion.div>

      {/* Button Playground - Collapsible */}
      <AnimatePresence>
        {showButtonPlayground && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3 }}
            className="overflow-hidden"
          >
            <motion.div variants={itemVariants} className="mt-4">
              <ButtonPlayground />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error Display */}
      {error && (
        <motion.div
          variants={itemVariants}
          className="mt-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg"
        >
          <p className="text-red-600 dark:text-red-400">{error}</p>
        </motion.div>
      )}
    </motion.div>
  );
};

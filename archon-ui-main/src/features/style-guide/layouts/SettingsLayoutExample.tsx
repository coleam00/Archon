import { Code, Database, FileText, Flame, Globe, Key, Monitor, Moon, Palette, Settings } from "lucide-react";
import { useId } from "react";
import { CollapsibleSettingsCard } from "@/components/ui/CollapsibleSettingsCard";
import { Card } from "@/features/ui/primitives/card";
import { Input } from "@/features/ui/primitives/input";
import { Label } from "@/features/ui/primitives/label";
import { Switch } from "@/features/ui/primitives/switch";

export const SettingsLayoutExample = () => {
  const openaiKeyId = useId();
  const googleKeyId = useId();
  const dbUrlId = useId();
  const autoBackupId = useId();
  const extractCodeId = useId();
  const maxExamplesId = useId();
  const matchCountId = useId();
  const rerankId = useId();
  const maxDepthId = useId();
  const followLinksId = useId();

  return (
    <div className="space-y-4">
      {/* Explanation Text */}
      <p className="text-sm text-gray-600 dark:text-gray-400">
        <strong>Use this layout for:</strong> Settings pages, dashboard widgets, grouped configuration sections.
        Two-column responsive grid with collapsible cards.
      </p>

      {/* Bento Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Features Section */}
        <CollapsibleSettingsCard title="Features" icon={Palette} accentColor="purple" defaultExpanded={true}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Dark Mode */}
            <div className="flex items-center gap-4 p-4 rounded-xl bg-gradient-to-br from-purple-500/10 to-purple-600/5 backdrop-blur-sm border border-purple-500/20 shadow-lg">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-800 dark:text-white text-sm">Dark Mode</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">Switch between themes</p>
              </div>
              <div className="flex-shrink-0">
                <Switch size="lg" defaultChecked color="purple" iconOn={<Moon className="w-5 h-5" />} />
              </div>
            </div>

            {/* Projects */}
            <div className="flex items-center gap-4 p-4 rounded-xl bg-gradient-to-br from-blue-500/10 to-blue-600/5 backdrop-blur-sm border border-blue-500/20 shadow-lg">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-800 dark:text-white text-sm">Projects</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">Enable Projects functionality</p>
              </div>
              <div className="flex-shrink-0">
                <Switch size="lg" defaultChecked color="blue" icon={<FileText className="w-5 h-5" />} />
              </div>
            </div>

            {/* Style Guide */}
            <div className="flex items-center gap-4 p-4 rounded-xl bg-gradient-to-br from-cyan-500/10 to-cyan-600/5 backdrop-blur-sm border border-cyan-500/20 shadow-lg">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-800 dark:text-white text-sm">Style Guide</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">Show UI components</p>
              </div>
              <div className="flex-shrink-0">
                <Switch size="lg" defaultChecked color="cyan" icon={<Palette className="w-5 h-5" />} />
              </div>
            </div>

            {/* Pydantic Logfire */}
            <div className="flex items-center gap-4 p-4 rounded-xl bg-gradient-to-br from-orange-500/10 to-orange-600/5 backdrop-blur-sm border border-orange-500/20 shadow-lg">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-800 dark:text-white text-sm">Pydantic Logfire</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">Logging platform</p>
              </div>
              <div className="flex-shrink-0">
                <Switch size="lg" color="orange" icon={<Flame className="w-5 h-5" />} />
              </div>
            </div>

            {/* Disconnect Screen */}
            <div className="flex items-center gap-4 p-4 rounded-xl bg-gradient-to-br from-green-500/10 to-green-600/5 backdrop-blur-sm border border-green-500/20 shadow-lg">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-800 dark:text-white text-sm">Disconnect Screen</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">Show when disconnected</p>
              </div>
              <div className="flex-shrink-0">
                <Switch size="lg" defaultChecked color="green" icon={<Monitor className="w-5 h-5" />} />
              </div>
            </div>
          </div>
        </CollapsibleSettingsCard>

        {/* API Keys Section */}
        <CollapsibleSettingsCard title="API Keys" icon={Key} accentColor="pink" defaultExpanded={true}>
          <Card edgePosition="top" edgeColor="pink">
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
              Manage your API keys and credentials for various services used by Archon.
            </p>
            <div className="space-y-4">
              <div>
                <Label htmlFor={openaiKeyId} className="text-xs font-medium text-gray-600 dark:text-gray-400">
                  OPENAI_API_KEY
                </Label>
                <Input
                  id={openaiKeyId}
                  type="password"
                  placeholder="Enter new value (encrypted)"
                  className="mt-2"
                  defaultValue="••••••••••••••••••"
                />
              </div>
              <div>
                <Label htmlFor={googleKeyId} className="text-xs font-medium text-gray-600 dark:text-gray-400">
                  GOOGLE_API_KEY
                </Label>
                <Input
                  id={googleKeyId}
                  type="password"
                  placeholder="Enter new value (encrypted)"
                  className="mt-2"
                  defaultValue="••••••••••••••••"
                />
              </div>
            </div>
          </Card>
        </CollapsibleSettingsCard>

        {/* Database Settings */}
        <CollapsibleSettingsCard title="Database Settings" icon={Database} accentColor="blue" defaultExpanded={false}>
          <Card edgePosition="top" edgeColor="blue">
            <div>
              <Label htmlFor={dbUrlId} className="text-sm font-medium">
                Database URL
              </Label>
              <Input
                id={dbUrlId}
                placeholder="postgresql://..."
                className="mt-2"
                defaultValue="postgresql://localhost:5432/archon"
              />
            </div>
            <div className="flex items-center justify-between mt-4">
              <Label htmlFor={autoBackupId} className="text-sm font-medium">
                Auto Backup
              </Label>
              <Switch id={autoBackupId} />
            </div>
          </Card>
        </CollapsibleSettingsCard>

        {/* Code Extraction */}
        <CollapsibleSettingsCard title="Code Extraction" icon={Code} accentColor="green" defaultExpanded={false}>
          <Card edgePosition="top" edgeColor="green">
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              Configure how code blocks are extracted from crawled documents.
            </p>
            <div className="flex items-center justify-between mb-4">
              <Label htmlFor={extractCodeId} className="text-sm font-medium">
                Extract Code Examples
              </Label>
              <Switch id={extractCodeId} defaultChecked />
            </div>
            <div>
              <Label htmlFor={maxExamplesId} className="text-sm font-medium">
                Max Examples per Source
              </Label>
              <Input id={maxExamplesId} type="number" placeholder="50" className="mt-2" defaultValue="50" />
            </div>
          </Card>
        </CollapsibleSettingsCard>

        {/* RAG Configuration */}
        <CollapsibleSettingsCard title="RAG Configuration" icon={Settings} accentColor="orange" defaultExpanded={true}>
          <Card edgePosition="top" edgeColor="orange">
            <div>
              <Label htmlFor={matchCountId} className="text-sm font-medium">
                Match Count
              </Label>
              <Input id={matchCountId} type="number" placeholder="5" className="mt-2" defaultValue="5" />
            </div>
            <div className="flex items-center justify-between mt-4">
              <Label htmlFor={rerankId} className="text-sm font-medium">
                Enable Reranking
              </Label>
              <Switch id={rerankId} defaultChecked />
            </div>
          </Card>
        </CollapsibleSettingsCard>

        {/* Crawling Settings */}
        <CollapsibleSettingsCard title="Crawling Settings" icon={Globe} accentColor="pink" defaultExpanded={false}>
          <Card edgePosition="top" edgeColor="pink">
            <div>
              <Label htmlFor={maxDepthId} className="text-sm font-medium">
                Max Crawl Depth
              </Label>
              <Input id={maxDepthId} type="number" placeholder="3" className="mt-2" defaultValue="3" />
            </div>
            <div className="flex items-center justify-between mt-4">
              <Label htmlFor={followLinksId} className="text-sm font-medium">
                Follow External Links
              </Label>
              <Switch id={followLinksId} />
            </div>
          </Card>
        </CollapsibleSettingsCard>
      </div>
    </div>
  );
};

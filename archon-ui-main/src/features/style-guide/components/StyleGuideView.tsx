import { Layout, Palette } from "lucide-react";
import { useState } from "react";
import { PillNavigation, type PillNavigationItem } from "@/features/ui/primitives/pill-navigation";
import { ThemeToggle } from "../../../components/ui/ThemeToggle";
import { LayoutsTab } from "../tabs/LayoutsTab";
import { StyleGuideTab } from "../tabs/StyleGuideTab";

export const StyleGuideView = () => {
  const [activeTab, setActiveTab] = useState<"style-guide" | "layouts">("style-guide");

  const navigationItems: PillNavigationItem[] = [
    { id: "style-guide", label: "Style Guide", icon: <Palette className="w-4 h-4" /> },
    { id: "layouts", label: "Layouts", icon: <Layout className="w-4 h-4" /> },
  ];

  return (
    <div className="space-y-12">
      {/* Header */}
      <div className="relative">
        <div className="absolute top-0 right-0">
          <ThemeToggle accentColor="blue" />
        </div>
        <div className="text-center space-y-4">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-4">Archon UI Style Guide</h1>
          <p className="text-gray-600 dark:text-gray-400 text-lg max-w-2xl mx-auto">
            Design system foundations and layout patterns for building consistent interfaces.
          </p>
        </div>
      </div>

      {/* Tab Navigation - Blue Pill Navigation */}
      <div className="flex justify-center">
        <PillNavigation
          items={navigationItems}
          activeSection={activeTab}
          onSectionClick={(id) => setActiveTab(id as typeof activeTab)}
          colorVariant="blue"
          showIcons={true}
          showText={true}
          hasSubmenus={false}
        />
      </div>

      {/* Tab Content */}
      <div>
        {activeTab === "style-guide" && <StyleGuideTab />}
        {activeTab === "layouts" && <LayoutsTab />}
      </div>
    </div>
  );
};

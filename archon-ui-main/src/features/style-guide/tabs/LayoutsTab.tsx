import { Database, FileText, FolderKanban, Navigation, Settings } from "lucide-react";
import { useState } from "react";
import { DocumentBrowserExample } from "../layouts/DocumentBrowserExample";
import { KnowledgeLayoutExample } from "../layouts/KnowledgeLayoutExample";
import { NavigationExplanation } from "../layouts/NavigationExplanation";
import { ProjectsLayoutExample } from "../layouts/ProjectsLayoutExample";
import { SettingsLayoutExample } from "../layouts/SettingsLayoutExample";
import { SideNavigation, type SideNavigationSection } from "../shared/SideNavigation";

export const LayoutsTab = () => {
  const [activeSection, setActiveSection] = useState("navigation");

  const sections: SideNavigationSection[] = [
    { id: "navigation", label: "Navigation", icon: <Navigation className="w-4 h-4" /> },
    { id: "projects", label: "Projects", icon: <FolderKanban className="w-4 h-4" /> },
    { id: "settings", label: "Settings", icon: <Settings className="w-4 h-4" /> },
    { id: "knowledge", label: "Knowledge", icon: <Database className="w-4 h-4" /> },
    { id: "document-browser", label: "Document Browser", icon: <FileText className="w-4 h-4" /> },
  ];

  // Render content based on active section
  const renderContent = () => {
    switch (activeSection) {
      case "navigation":
        return (
          <div>
            <h2 className="text-2xl font-bold mb-4 text-gray-900 dark:text-white">Navigation Patterns</h2>
            <NavigationExplanation />
          </div>
        );
      case "projects":
        return (
          <div>
            <h2 className="text-2xl font-bold mb-4 text-gray-900 dark:text-white">Projects Layout</h2>
            <p className="text-gray-600 dark:text-gray-400 mb-4">
              Project selection with Kanban board and table views. Uses orange pill navigation for Docs/Tasks tabs.
            </p>
            <ProjectsLayoutExample />
          </div>
        );
      case "settings":
        return (
          <div>
            <h2 className="text-2xl font-bold mb-4 text-gray-900 dark:text-white">Settings Layout</h2>
            <p className="text-gray-600 dark:text-gray-400 mb-4">
              Bento grid (2-column responsive) with collapsible cards using PowerButton toggles.
            </p>
            <SettingsLayoutExample />
          </div>
        );
      case "knowledge":
        return (
          <div>
            <h2 className="text-2xl font-bold mb-4 text-gray-900 dark:text-white">Knowledge Layout</h2>
            <p className="text-gray-600 dark:text-gray-400 mb-4">
              Switchable views (grid/table) with filters and search. Cards have top glass glow bars.
            </p>
            <KnowledgeLayoutExample />
          </div>
        );
      case "document-browser":
        return (
          <div>
            <h2 className="text-2xl font-bold mb-4 text-gray-900 dark:text-white">Document Browser</h2>
            <p className="text-gray-600 dark:text-gray-400 mb-4">
              Modal or embedded display for documents and code with tabs, search, and expandable content.
            </p>
            <DocumentBrowserExample />
          </div>
        );
      default:
        return (
          <div>
            <h2 className="text-2xl font-bold mb-4 text-gray-900 dark:text-white">Navigation Patterns</h2>
            <NavigationExplanation />
          </div>
        );
    }
  };

  return (
    <div className="flex gap-6">
      {/* Side Navigation */}
      <SideNavigation sections={sections} activeSection={activeSection} onSectionClick={setActiveSection} />

      {/* Main Content */}
      <div className="flex-1 min-w-0 max-w-6xl">{renderContent()}</div>
    </div>
  );
};

import {
  Box,
  CreditCard,
  FormInput,
  MousePointer,
  Palette,
  Power,
  Sparkles,
  Table as TableIcon,
  Type,
} from "lucide-react";
import { useState } from "react";
import { SideNavigation, type SideNavigationSection } from "../shared/SideNavigation";
import { StaticButtons } from "../showcases/StaticButtons";
import { StaticCards } from "../showcases/StaticCards";
import { StaticColors } from "../showcases/StaticColors";
import { StaticEffects } from "../showcases/StaticEffects";
import { StaticForms } from "../showcases/StaticForms";
import { StaticSpacing } from "../showcases/StaticSpacing";
import { StaticTables } from "../showcases/StaticTables";
import { StaticToggles } from "../showcases/StaticToggles";
import { StaticTypography } from "../showcases/StaticTypography";

export const StyleGuideTab = () => {
  const [activeSection, setActiveSection] = useState("typography");

  const sections: SideNavigationSection[] = [
    { id: "typography", label: "Typography", icon: <Type className="w-3 h-3" /> },
    { id: "colors", label: "Colors", icon: <Palette className="w-3 h-3" /> },
    { id: "spacing", label: "Spacing", icon: <Box className="w-3 h-3" /> },
    { id: "buttons", label: "Buttons", icon: <MousePointer className="w-3 h-3" /> },
    { id: "cards", label: "Cards", icon: <CreditCard className="w-3 h-3" /> },
    { id: "tables", label: "Tables", icon: <TableIcon className="w-3 h-3" /> },
    { id: "forms", label: "Forms", icon: <FormInput className="w-3 h-3" /> },
    { id: "toggles", label: "Toggles", icon: <Power className="w-3 h-3" /> },
    { id: "effects", label: "Effects", icon: <Sparkles className="w-3 h-3" /> },
  ];

  // Render content based on active section
  const renderContent = () => {
    switch (activeSection) {
      case "typography":
        return <StaticTypography />;
      case "colors":
        return <StaticColors />;
      case "spacing":
        return <StaticSpacing />;
      case "buttons":
        return <StaticButtons />;
      case "cards":
        return <StaticCards />;
      case "tables":
        return <StaticTables />;
      case "forms":
        return <StaticForms />;
      case "toggles":
        return <StaticToggles />;
      case "effects":
        return <StaticEffects />;
      default:
        return <StaticTypography />;
    }
  };

  return (
    <div className="flex gap-6">
      {/* Side Navigation */}
      <SideNavigation sections={sections} activeSection={activeSection} onSectionClick={setActiveSection} />

      {/* Main Content */}
      <div className="flex-1 max-w-5xl">{renderContent()}</div>
    </div>
  );
};

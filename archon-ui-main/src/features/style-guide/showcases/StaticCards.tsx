import { useState } from "react";
import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { Card } from "@/features/ui/primitives/card";
import { DraggableCard } from "@/features/ui/primitives/draggable-card";
import { SelectableCard } from "@/features/ui/primitives/selectable-card";
import { cn } from "@/features/ui/primitives/styles";

// Base Glass Card with transparency tabs
const BaseGlassCardShowcase = () => {
  const [activeTab, setActiveTab] = useState<"light" | "frosted" | "solid">("light");

  return (
    <div>
      <h4 className="text-sm font-semibold mb-3 text-gray-800 dark:text-gray-200">Base Glass Card</h4>

      {/* Tabs */}
      <div className="flex gap-2 mb-3">
        {(["light", "frosted", "solid"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-3 py-1 text-xs rounded-md transition-colors",
              activeTab === tab
                ? "bg-blue-500/20 text-blue-700 dark:text-blue-300 border border-blue-500/50"
                : "bg-gray-200/50 dark:bg-gray-700/50 text-gray-600 dark:text-gray-400 hover:bg-gray-300/50 dark:hover:bg-gray-600/50",
            )}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Card Display */}
      <Card
        size="md"
        transparency={activeTab}
        blur="md"
        className={activeTab === "solid" ? "border-2 border-gray-400 dark:border-gray-600" : ""}
      >
        <h5 className="font-medium text-gray-900 dark:text-white mb-2">Card Title</h5>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {activeTab === "light" && "Light glass - low opacity (8%), see grid through"}
          {activeTab === "frosted" && "Frosted glass - white frosted in light mode, black frosted in dark mode"}
          {activeTab === "solid" && "Solid - high opacity (90%), opaque background"}
        </p>
      </Card>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 font-mono">
        {`<Card transparency="${activeTab}" />`}
      </p>
    </div>
  );
};

// Outer Glow Card with size tabs
const OuterGlowCardShowcase = () => {
  const [activeSize, setActiveSize] = useState<"sm" | "md" | "lg" | "xl">("md");

  return (
    <div>
      <h4 className="text-sm font-semibold mb-3 text-gray-800 dark:text-gray-200">Outer Glow Card</h4>

      {/* Size Tabs */}
      <div className="flex gap-2 mb-3">
        {(["sm", "md", "lg", "xl"] as const).map((size) => (
          <button
            key={size}
            type="button"
            onClick={() => setActiveSize(size)}
            className={cn(
              "px-3 py-1 text-xs rounded-md transition-colors",
              activeSize === size
                ? "bg-cyan-500/20 text-cyan-700 dark:text-cyan-300 border border-cyan-500/50"
                : "bg-gray-200/50 dark:bg-gray-700/50 text-gray-600 dark:text-gray-400 hover:bg-gray-300/50 dark:hover:bg-gray-600/50",
            )}
          >
            {size.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Card Display */}
      <Card glowColor="cyan" glowType="outer" glowSize={activeSize}>
        <h5 className="font-medium text-gray-900 dark:text-white mb-2">Active Card</h5>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Outer glow - {activeSize.toUpperCase()} (hover for brighter, same size)
        </p>
      </Card>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 font-mono">
        {`<Card glowColor="cyan" glowType="outer" glowSize="${activeSize}" />`}
      </p>
    </div>
  );
};

// Inner Glow Card with size tabs
const InnerGlowCardShowcase = () => {
  const [activeSize, setActiveSize] = useState<"sm" | "md" | "lg" | "xl">("md");

  return (
    <div>
      <h4 className="text-sm font-semibold mb-3 text-gray-800 dark:text-gray-200">Inner Glow Card</h4>

      {/* Size Tabs */}
      <div className="flex gap-2 mb-3">
        {(["sm", "md", "lg", "xl"] as const).map((size) => (
          <button
            key={size}
            type="button"
            onClick={() => setActiveSize(size)}
            className={cn(
              "px-3 py-1 text-xs rounded-md transition-colors",
              activeSize === size
                ? "bg-blue-500/20 text-blue-700 dark:text-blue-300 border border-blue-500/50"
                : "bg-gray-200/50 dark:bg-gray-700/50 text-gray-600 dark:text-gray-400 hover:bg-gray-300/50 dark:hover:bg-gray-600/50",
            )}
          >
            {size.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Card Display */}
      <Card glowColor="blue" glowType="inner" glowSize={activeSize}>
        <h5 className="font-medium text-gray-900 dark:text-white mb-2">Featured Card</h5>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Inner glow - {activeSize.toUpperCase()} (hover for brighter, same size)
        </p>
      </Card>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 font-mono">
        {`<Card glowColor="blue" glowType="inner" glowSize="${activeSize}" />`}
      </p>
    </div>
  );
};

// Edge-Lit Card with color tabs
const EdgeLitCardShowcase = () => {
  const [activeColor, setActiveColor] = useState<"cyan" | "purple" | "pink" | "blue">("cyan");

  const colorDescriptions = {
    cyan: "Technical web pages",
    purple: "Uploaded documents",
    pink: "Business content",
    blue: "Information pages",
  };

  // Static color classes (NOT dynamic) - Tailwind requirement
  const tabColorClasses = {
    cyan: "bg-cyan-500/20 text-cyan-700 dark:text-cyan-300 border border-cyan-500/50",
    purple: "bg-purple-500/20 text-purple-700 dark:text-purple-300 border border-purple-500/50",
    pink: "bg-pink-500/20 text-pink-700 dark:text-pink-300 border border-pink-500/50",
    blue: "bg-blue-500/20 text-blue-700 dark:text-blue-300 border border-blue-500/50",
  };

  return (
    <div>
      <h4 className="text-sm font-semibold mb-3 text-gray-800 dark:text-gray-200">Top Edge Glow Card</h4>

      {/* Color Tabs */}
      <div className="flex gap-2 mb-3">
        {(["cyan", "purple", "pink", "blue"] as const).map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => setActiveColor(color)}
            className={cn(
              "px-3 py-1 text-xs rounded-md transition-colors",
              activeColor === color
                ? tabColorClasses[color]
                : "bg-gray-200/50 dark:bg-gray-700/50 text-gray-600 dark:text-gray-400 hover:bg-gray-300/50 dark:hover:bg-gray-600/50",
            )}
          >
            {color.charAt(0).toUpperCase() + color.slice(1)}
          </button>
        ))}
      </div>

      {/* Card Display */}
      <Card edgePosition="top" edgeColor={activeColor}>
        <h5 className="font-medium text-gray-900 dark:text-white mb-2">
          {activeColor.charAt(0).toUpperCase() + activeColor.slice(1)} Edge Light
        </h5>
        <p className="text-sm text-gray-600 dark:text-gray-400">{colorDescriptions[activeColor]}</p>
      </Card>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 font-mono">
        {`<Card edgePosition="top" edgeColor="${activeColor}" />`}
      </p>
    </div>
  );
};

export const StaticCards = () => {
  const [selectedCardId, setSelectedCardId] = useState("card-2");
  const [draggableCards, setDraggableCards] = useState([
    { id: "drag-1", label: "Draggable 1" },
    { id: "drag-2", label: "Draggable 2" },
    { id: "drag-3", label: "Draggable 3" },
  ]);

  const handleCardDrop = (draggedId: string, targetIndex: number) => {
    setDraggableCards((cards) => {
      const currentIndex = cards.findIndex((card) => card.id === draggedId);
      if (currentIndex === -1 || currentIndex === targetIndex) {
        return cards;
      }
      const updated = [...cards];
      const [moved] = updated.splice(currentIndex, 1);
      updated.splice(targetIndex, 0, moved);
      return updated;
    });
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold mb-4 text-gray-900 dark:text-white">Cards</h2>
        <p className="text-gray-600 dark:text-gray-400 mb-6">Glass card variants and advanced card components</p>
      </div>

      {/* Responsive Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Base Glass Card - Transparency Variants */}
        <BaseGlassCardShowcase />

        {/* Outer Glow Card - Size Variants */}
        <OuterGlowCardShowcase />

        {/* Inner Glow Card - Size Variants */}
        <InnerGlowCardShowcase />

        {/* Top Edge Glow Card - Color Variants */}
        <EdgeLitCardShowcase />
      </div>

      {/* Advanced Card Components */}
      <div className="space-y-6 mt-8">
        <div>
          <h3 className="text-xl font-semibold mb-4 text-gray-800 dark:text-gray-200">Advanced Card Components</h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
            Specialized cards that extend the base Card primitive with additional behaviors
          </p>
        </div>

        {/* Selectable Cards */}
        <div>
          <h4 className="text-sm font-semibold mb-3 text-gray-800 dark:text-gray-200">SelectableCard</h4>
          <p className="text-xs text-gray-600 dark:text-gray-400 mb-4">
            Card with selection states, hover effects, and optional aurora glow. Click cards to select.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            {["card-1", "card-2", "card-3"].map((id) => (
              <SelectableCard
                key={id}
                isSelected={selectedCardId === id}
                showAuroraGlow={selectedCardId === id}
                onSelect={() => setSelectedCardId(id)}
                size="sm"
                className="min-h-[120px]"
              >
                <h5 className="font-medium text-gray-900 dark:text-white mb-2">
                  {id === selectedCardId ? "Selected" : "Click to Select"}
                </h5>
                <p className="text-xs text-gray-600 dark:text-gray-400">Card {id.split("-")[1]}</p>
              </SelectableCard>
            ))}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-3 font-mono">
            {"<SelectableCard isSelected={...} showAuroraGlow onSelect={...} />"}
          </p>
        </div>

        {/* Draggable Cards */}
        <div>
          <h4 className="text-sm font-semibold mb-3 text-gray-800 dark:text-gray-200">DraggableCard</h4>
          <p className="text-xs text-gray-600 dark:text-gray-400 mb-4">
            Card with drag-and-drop functionality. Try dragging cards to reorder.
          </p>
          <DndProvider backend={HTML5Backend}>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
              {draggableCards.map((card, index) => (
                <DraggableCard
                  key={card.id}
                  itemType="example-card"
                  itemId={card.id}
                  index={index}
                  onDrop={handleCardDrop}
                  size="sm"
                  className="min-h-[120px] cursor-move"
                >
                  <h5 className="font-medium text-gray-900 dark:text-white mb-2">{card.label}</h5>
                  <p className="text-xs text-gray-600 dark:text-gray-400">Drag me to reorder</p>
                </DraggableCard>
              ))}
            </div>
          </DndProvider>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-3 font-mono">
            {'<DraggableCard itemType="..." itemId="..." index={...} onDrop={...} />'}
          </p>
        </div>
      </div>
    </div>
  );
};

import { Card } from "@/features/ui/primitives/card";
import { cn } from "@/features/ui/primitives/styles";

const GRAY_CLASSES: Record<number, string> = {
  50: "bg-gray-50",
  100: "bg-gray-100",
  200: "bg-gray-200",
  300: "bg-gray-300",
  400: "bg-gray-400",
  500: "bg-gray-500",
  600: "bg-gray-600",
  700: "bg-gray-700",
  800: "bg-gray-800",
  900: "bg-gray-900",
};

export const StaticColors = () => {
  const semanticColors = [
    { name: "Primary", hex: "#3b82f6", tailwind: "blue-500", usage: "Primary actions, links, focus states" },
    { name: "Secondary", hex: "#6b7280", tailwind: "gray-500", usage: "Secondary actions, neutral elements" },
    { name: "Success", hex: "#22c55e", tailwind: "green-500", usage: "Success states, confirmations" },
    { name: "Warning", hex: "#f97316", tailwind: "orange-500", usage: "Warnings, cautions" },
    { name: "Error", hex: "#ef4444", tailwind: "red-500", usage: "Errors, destructive actions" },
  ];

  const accentColors = [
    { name: "Cyan", hex: "#06b6d4", tailwind: "cyan-500", usage: "Active states, highlights" },
    { name: "Purple", hex: "#a855f7", tailwind: "purple-500", usage: "Creative elements, special features" },
    { name: "Pink", hex: "#ec4899", tailwind: "pink-500", usage: "Emphasis, special content" },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold mb-4 text-gray-900 dark:text-white">Colors</h2>
        <p className="text-gray-600 dark:text-gray-400 mb-6">Color palette with semantic and accent colors</p>
      </div>

      {/* Semantic Colors */}
      <div>
        <h3 className="text-lg font-semibold mb-4 text-gray-800 dark:text-gray-200">Semantic Colors</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {semanticColors.map((color) => (
            <Card key={color.name} className="p-4">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-lg border border-white/20" style={{ backgroundColor: color.hex }} />
                <div className="flex-1">
                  <h4 className="font-semibold text-gray-900 dark:text-white">{color.name}</h4>
                  <p className="text-xs text-gray-500 dark:text-gray-400 font-mono mt-1">{color.hex}</p>
                  <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">{color.usage}</p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>

      {/* Accent Colors */}
      <div>
        <h3 className="text-lg font-semibold mb-4 text-gray-800 dark:text-gray-200">Accent Colors</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {accentColors.map((color) => (
            <Card key={color.name} className="p-4">
              <div className="flex flex-col gap-3">
                <div
                  className={cn("w-full h-12 rounded-lg border border-white/20")}
                  style={{ backgroundColor: color.hex }}
                />
                <div>
                  <h4 className="font-semibold text-gray-900 dark:text-white text-sm">{color.name}</h4>
                  <p className="text-xs text-gray-500 dark:text-gray-400 font-mono">{color.hex}</p>
                  <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">{color.usage}</p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>

      {/* Grayscale */}
      <div>
        <h3 className="text-lg font-semibold mb-4 text-gray-800 dark:text-gray-200">Grayscale</h3>
        <div className="flex gap-1">
          {[50, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((weight) => (
            <div key={weight} className="flex-1">
              <div className={cn("h-12 rounded", GRAY_CLASSES[weight])} />
              <p className="text-xs text-center mt-1 text-gray-500 dark:text-gray-400">{weight}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

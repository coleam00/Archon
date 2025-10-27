import { useId, useState } from "react";
import { PowerButton } from "@/components/ui/PowerButton";
import { Card } from "@/features/ui/primitives/card";
import { Label } from "@/features/ui/primitives/label";
import { Switch } from "@/features/ui/primitives/switch";

export const StaticToggles = () => {
  const toggle1Id = useId();
  const toggle2Id = useId();

  const [powerStates, setPowerStates] = useState({
    purple: true,
    cyan: false,
    green: true,
    orange: false,
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold mb-4 text-gray-900 dark:text-white">Toggles</h2>
        <p className="text-gray-600 dark:text-gray-400 mb-6">Toggle controls used in the application</p>
      </div>

      {/* Power Button */}
      <Card className="p-6">
        <h4 className="text-sm font-semibold mb-4 text-gray-900 dark:text-white">Power Button</h4>
        <p className="text-xs text-gray-600 dark:text-gray-400 mb-4">
          Animated toggle with glowing power icon. Used for collapsible settings cards.
        </p>
        <div className="flex gap-6 items-center justify-center py-4">
          <div className="flex flex-col items-center gap-2">
            <PowerButton
              isOn={powerStates.purple}
              onClick={() => setPowerStates((s) => ({ ...s, purple: !s.purple }))}
              color="purple"
              size={40}
            />
            <span className="text-xs text-gray-500">Purple</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <PowerButton
              isOn={powerStates.cyan}
              onClick={() => setPowerStates((s) => ({ ...s, cyan: !s.cyan }))}
              color="cyan"
              size={40}
            />
            <span className="text-xs text-gray-500">Cyan</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <PowerButton
              isOn={powerStates.green}
              onClick={() => setPowerStates((s) => ({ ...s, green: !s.green }))}
              color="green"
              size={40}
            />
            <span className="text-xs text-gray-500">Green</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <PowerButton
              isOn={powerStates.orange}
              onClick={() => setPowerStates((s) => ({ ...s, orange: !s.orange }))}
              color="orange"
              size={40}
            />
            <span className="text-xs text-gray-500">Orange</span>
          </div>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-4 font-mono">{"<PowerButton />"}</p>
      </Card>

      {/* Switch Toggle */}
      <Card className="p-6">
        <h4 className="text-sm font-semibold mb-4 text-gray-900 dark:text-white">Switch</h4>
        <p className="text-xs text-gray-600 dark:text-gray-400 mb-4">
          Standard toggle switch for settings and binary options
        </p>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label htmlFor={toggle1Id}>Enable Feature</Label>
            <Switch id={toggle1Id} defaultChecked />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor={toggle2Id}>Auto Save</Label>
            <Switch id={toggle2Id} />
          </div>
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-4 font-mono">{"<Switch />"}</p>
      </Card>
    </div>
  );
};

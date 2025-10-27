import { Card } from "@/features/ui/primitives/card";

export const StaticSpacing = () => {
  const spacingScale = [
    { value: 1, px: 4, rem: 0.25 },
    { value: 2, px: 8, rem: 0.5 },
    { value: 3, px: 12, rem: 0.75 },
    { value: 4, px: 16, rem: 1 },
    { value: 6, px: 24, rem: 1.5 },
    { value: 8, px: 32, rem: 2 },
    { value: 12, px: 48, rem: 3 },
    { value: 16, px: 64, rem: 4 },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold mb-4 text-gray-900 dark:text-white">Spacing</h2>
        <p className="text-gray-600 dark:text-gray-400 mb-6">Consistent spacing scale based on 4px increments</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {spacingScale.map((space) => (
          <Card key={space.value} className="p-4">
            <div className="mb-3">
              <div className="bg-blue-500 rounded" style={{ height: `${space.px}px` }} />
            </div>
            <div className="text-xs space-y-1">
              <div className="font-mono text-gray-900 dark:text-white">p-{space.value}</div>
              <div className="text-gray-500 dark:text-gray-400">{space.px}px</div>
              <div className="text-gray-500 dark:text-gray-400">{space.rem}rem</div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
};

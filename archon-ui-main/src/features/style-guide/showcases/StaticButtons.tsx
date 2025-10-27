import { Plus } from "lucide-react";
import { Button } from "@/features/ui/primitives/button";
import { Card } from "@/features/ui/primitives/card";

export const StaticButtons = () => {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold mb-4 text-gray-900 dark:text-white">Buttons</h2>
        <p className="text-gray-600 dark:text-gray-400 mb-6">Button types used across the application</p>
      </div>

      <div className="space-y-6">
        {/* Glass Button (Outer Glow) */}
        <Card className="p-6">
          <h4 className="text-sm font-semibold mb-3 text-gray-900 dark:text-white">Glass Button (Outer Glow)</h4>
          <p className="text-xs text-gray-600 dark:text-gray-400 mb-4">
            Primary action button with gradient fill and external glow on hover
          </p>
          <div className="flex gap-3 items-center flex-wrap">
            <Button variant="default" size="sm">
              Small
            </Button>
            <Button variant="default">Default</Button>
            <Button variant="default" size="lg">
              Large
            </Button>
            <Button variant="default">
              <Plus className="w-4 h-4 mr-2" />
              With Icon
            </Button>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-3 font-mono">
            variant="default" • Outer glow on hover
          </p>
        </Card>

        {/* Outline Button (Inner Glow) */}
        <Card className="p-6 shadow-[inset_0_0_15px_rgba(34,211,238,0.1)] dark:shadow-[inset_0_0_20px_rgba(34,211,238,0.15)]">
          <h4 className="text-sm font-semibold mb-3 text-gray-900 dark:text-white">Outline Button (Inner Glow)</h4>
          <p className="text-xs text-gray-600 dark:text-gray-400 mb-4">
            Transparent button with border and internal glow on hover
          </p>
          <div className="flex gap-3 items-center flex-wrap">
            <Button variant="outline" size="sm">
              Small
            </Button>
            <Button variant="outline">Default</Button>
            <Button variant="outline" size="lg">
              Large
            </Button>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-3 font-mono">
            variant="outline" • Inner glow effect
          </p>
        </Card>

        {/* Ghost Button */}
        <Card className="p-6">
          <h4 className="text-sm font-semibold mb-3 text-gray-900 dark:text-white">Ghost Button</h4>
          <p className="text-xs text-gray-600 dark:text-gray-400 mb-4">Minimal button with hover background only</p>
          <div className="flex gap-3 items-center flex-wrap">
            <Button variant="ghost" size="sm">
              Small
            </Button>
            <Button variant="ghost">Default</Button>
            <Button variant="ghost" size="lg">
              Large
            </Button>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-3 font-mono">variant="ghost"</p>
        </Card>

        {/* Icon Button */}
        <Card className="p-6">
          <h4 className="text-sm font-semibold mb-3 text-gray-900 dark:text-white">Icon Only</h4>
          <p className="text-xs text-gray-600 dark:text-gray-400 mb-4">Square button for icon-only actions</p>
          <div className="flex gap-3 items-center flex-wrap">
            <Button variant="outline" size="icon">
              <Plus className="w-4 h-4" />
            </Button>
            <Button variant="default" size="icon">
              <Plus className="w-4 h-4" />
            </Button>
            <Button variant="ghost" size="icon">
              <Plus className="w-4 h-4" />
            </Button>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-3 font-mono">size="icon"</p>
        </Card>

        {/* Destructive */}
        <Card className="p-6">
          <h4 className="text-sm font-semibold mb-3 text-gray-900 dark:text-white">Destructive</h4>
          <p className="text-xs text-gray-600 dark:text-gray-400 mb-4">
            For dangerous or destructive actions (delete, remove, etc.)
          </p>
          <div className="flex gap-3 items-center flex-wrap">
            <Button variant="destructive" size="sm">
              Delete
            </Button>
            <Button variant="destructive">Remove</Button>
            <Button variant="destructive" size="lg">
              Destroy
            </Button>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-3 font-mono">variant="destructive"</p>
        </Card>
      </div>
    </div>
  );
};

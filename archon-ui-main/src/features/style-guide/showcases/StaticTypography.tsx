import { Card } from "@/features/ui/primitives/card";

export const StaticTypography = () => {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold mb-4 text-gray-900 dark:text-white">Typography</h2>
        <p className="text-gray-600 dark:text-gray-400 mb-6">Typography scale used across the application</p>
      </div>

      <Card className="p-6 space-y-6">
        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-2 font-mono">H1 • text-4xl font-bold</div>
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white">Heading 1</h1>
        </div>

        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-2 font-mono">H2 • text-3xl font-bold</div>
          <h2 className="text-3xl font-bold text-gray-900 dark:text-white">Heading 2</h2>
        </div>

        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-2 font-mono">H3 • text-2xl font-semibold</div>
          <h3 className="text-2xl font-semibold text-gray-900 dark:text-white">Heading 3</h3>
        </div>

        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-2 font-mono">H4 • text-xl font-semibold</div>
          <h4 className="text-xl font-semibold text-gray-900 dark:text-white">Heading 4</h4>
        </div>

        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-2 font-mono">Body • text-base</div>
          <p className="text-base text-gray-700 dark:text-gray-300">
            Body text for paragraphs and general content. This is the default text style used throughout the
            application.
          </p>
        </div>

        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-2 font-mono">Small • text-sm</div>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Small text for secondary information and descriptions
          </p>
        </div>

        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-2 font-mono">Caption • text-xs</div>
          <p className="text-xs text-gray-500 dark:text-gray-500">Caption text for labels, timestamps, and metadata</p>
        </div>

        <div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mb-2 font-mono">Code • font-mono</div>
          <code className="font-mono text-sm bg-black/20 px-2 py-1 rounded text-cyan-400">
            const example = "code text";
          </code>
        </div>
      </Card>
    </div>
  );
};

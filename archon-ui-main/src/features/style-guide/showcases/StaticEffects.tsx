import { motion } from "framer-motion";
import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/features/ui/primitives/button";
import { Card } from "@/features/ui/primitives/card";

export const StaticEffects = () => {
  const [animationKey, setAnimationKey] = useState(0);

  const replayAnimation = () => {
    setAnimationKey((prev) => prev + 1);
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold mb-4 text-gray-900 dark:text-white">Effects & Animations</h2>
        <p className="text-gray-600 dark:text-gray-400 mb-6">Visual effects and animations used in the application</p>
      </div>

      {/* Hover Effects */}
      <div>
        <h3 className="text-lg font-semibold mb-4 text-gray-800 dark:text-gray-200">Hover Effects</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="p-6 hover:shadow-[0_0_20px_rgba(34,211,238,0.6)] transition-all duration-300 cursor-pointer">
            <h4 className="text-sm font-semibold mb-2 text-gray-900 dark:text-white">Glow Hover</h4>
            <p className="text-xs text-gray-600 dark:text-gray-400">Hover to see cyan glow</p>
          </Card>

          <Card className="p-6 hover:scale-105 transition-transform duration-200 cursor-pointer">
            <h4 className="text-sm font-semibold mb-2 text-gray-900 dark:text-white">Scale Hover</h4>
            <p className="text-xs text-gray-600 dark:text-gray-400">Hover to scale up</p>
          </Card>

          <Card className="p-6 hover:border-purple-500 hover:shadow-[0_0_15px_rgba(168,85,247,0.5)] transition-all duration-300 cursor-pointer">
            <h4 className="text-sm font-semibold mb-2 text-gray-900 dark:text-white">Border Glow</h4>
            <p className="text-xs text-gray-600 dark:text-gray-400">Hover for purple border glow</p>
          </Card>
        </div>
      </div>

      {/* Loading States */}
      <div>
        <h3 className="text-lg font-semibold mb-4 text-gray-800 dark:text-gray-200">Loading States</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="p-6">
            <h4 className="text-sm font-semibold mb-3 text-gray-900 dark:text-white">Spinner</h4>
            <div className="flex justify-center py-4">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-500" />
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 font-mono text-center">animate-spin</p>
          </Card>

          <Card className="p-6">
            <h4 className="text-sm font-semibold mb-3 text-gray-900 dark:text-white">Pulse</h4>
            <div className="flex justify-center py-4">
              <div className="w-8 h-8 bg-blue-500 rounded-full animate-pulse" />
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 font-mono text-center">animate-pulse</p>
          </Card>

          <Card className="p-6">
            <h4 className="text-sm font-semibold mb-3 text-gray-900 dark:text-white">Progress Bar</h4>
            <div className="py-4">
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
                <motion.div
                  className="h-full bg-gradient-to-r from-cyan-500 to-blue-500"
                  initial={{ width: "0%" }}
                  animate={{ width: "70%" }}
                  transition={{ duration: 1.5, repeat: Number.POSITIVE_INFINITY, repeatDelay: 0.5 }}
                />
              </div>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 font-mono text-center">Framer Motion</p>
          </Card>
        </div>
      </div>

      {/* Entrance Animations */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-200">Stagger Entrance</h3>
          <Button size="sm" variant="outline" onClick={replayAnimation} className="flex items-center gap-2">
            <RotateCcw className="w-4 h-4" />
            Replay
          </Button>
        </div>
        <div className="space-y-2" key={animationKey}>
          {[1, 2, 3, 4].map((i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4, delay: i * 0.1 }}
            >
              <Card className="p-4">
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  Staggered item {i} - Fades in from left with delay
                </p>
              </Card>
            </motion.div>
          ))}
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-4 font-mono">
          Used for project cards, task lists, knowledge items
        </p>
      </div>
    </div>
  );
};

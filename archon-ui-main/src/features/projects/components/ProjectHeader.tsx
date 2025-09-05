import { motion } from "framer-motion";
import { Plus } from "lucide-react";
import type React from "react";
import { Button } from "../../ui/primitives/button";

interface ProjectHeaderProps {
  onNewProject: () => void;
}

const titleVariants = {
  hidden: { opacity: 0, scale: 0.9 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: { duration: 0.5, ease: [0.23, 1, 0.32, 1] },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, ease: [0.23, 1, 0.32, 1] },
  },
};

export const ProjectHeader: React.FC<ProjectHeaderProps> = ({ onNewProject }) => {
  return (
    <motion.div
      className="flex items-center justify-between mb-8"
      variants={itemVariants}
      initial="hidden"
      animate="visible"
    >
      <motion.h1
        className="text-3xl font-bold text-gray-800 dark:text-white flex items-center gap-3"
        variants={titleVariants}
      >
        <img
          src="/logo-neon.png"
          alt="Projects"
          className="w-7 h-7 filter drop-shadow-[0_0_8px_rgba(59,130,246,0.8)]"
        />
        Projects
      </motion.h1>
      <Button onClick={onNewProject} variant="cyan" className="shadow-lg shadow-cyan-500/20">
        <Plus className="w-4 h-4 mr-2" />
        New Project
      </Button>
    </motion.div>
  );
};

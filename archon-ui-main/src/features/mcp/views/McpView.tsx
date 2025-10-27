import { motion } from "framer-motion";
import { Loader, Server } from "lucide-react";
import type React from "react";
import { useStaggeredEntrance } from "../../../hooks/useStaggeredEntrance";
import { McpClientList, McpConfigSection, McpStatusBar } from "../components";
import { useMcpClients, useMcpConfig, useMcpSessionInfo, useMcpStatus } from "../hooks";

export const McpView: React.FC = () => {
  const { data: status, isLoading: statusLoading } = useMcpStatus();
  const { data: config } = useMcpConfig();
  const { data: clients = [] } = useMcpClients();
  const { data: sessionInfo } = useMcpSessionInfo();

  // Staggered entrance animation
  const isVisible = useStaggeredEntrance([1, 2, 3, 4], 0.15);

  // Animation variants
  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.15,
      },
    },
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: {
      opacity: 1,
      y: 0,
      transition: {
        duration: 0.5,
        ease: "easeOut",
      },
    },
  };

  const titleVariants = {
    hidden: { opacity: 0, x: -20 },
    visible: {
      opacity: 1,
      x: 0,
      transition: {
        duration: 0.6,
        ease: "easeOut",
      },
    },
  };

  if (statusLoading || !status) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader className="animate-spin text-gray-500" size={32} />
      </div>
    );
  }

  return (
    <motion.div
      initial="hidden"
      animate={isVisible ? "visible" : "hidden"}
      variants={containerVariants}
      className="space-y-6"
    >
      {/* Title with MCP icon */}
      <motion.h1
        className="text-3xl font-bold text-gray-800 dark:text-white mb-8 flex items-center gap-3"
        variants={titleVariants}
      >
        <svg
          fill="currentColor"
          fillRule="evenodd"
          height="28"
          width="28"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
          className="text-pink-500 filter drop-shadow-[0_0_8px_rgba(236,72,153,0.8)]"
          aria-label="MCP icon"
        >
          <title>MCP icon</title>
          <path d="M15.688 2.343a2.588 2.588 0 00-3.61 0l-9.626 9.44a.863.863 0 01-1.203 0 .823.823 0 010-1.18l9.626-9.44a4.313 4.313 0 016.016 0 4.116 4.116 0 011.204 3.54 4.3 4.3 0 013.609 1.18l.05.05a4.115 4.115 0 010 5.9l-8.706 8.537a.274.274 0 000 .393l1.788 1.754a.823.823 0 010 1.18.863.863 0 01-1.203 0l-1.788-1.753a1.92 1.92 0 010-2.754l8.706-8.538a2.47 2.47 0 000-3.54l-.05-.049a2.588 2.588 0 00-3.607-.003l-7.172 7.034-.002.002-.098.097a.863.863 0 01-1.204 0 .823.823 0 010-1.18l7.273-7.133a2.47 2.47 0 00-.003-3.537z" />
          <path d="M14.485 4.703a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a4.115 4.115 0 000 5.9 4.314 4.314 0 006.016 0l7.12-6.982a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a2.588 2.588 0 01-3.61 0 2.47 2.47 0 010-3.54l7.12-6.982z" />
        </svg>
        MCP Status Dashboard
      </motion.h1>

      {/* Status Bar */}
      <motion.div variants={itemVariants}>
        <McpStatusBar status={status} sessionInfo={sessionInfo} config={config} />
      </motion.div>

      {/* Connected Clients */}
      <motion.div variants={itemVariants}>
        <h2 className="text-xl font-semibold mb-4 text-gray-800 dark:text-white flex items-center gap-2">
          <Server className="w-5 h-5 text-cyan-500" />
          Connected Clients
        </h2>
        <McpClientList clients={clients} />
      </motion.div>

      {/* IDE Configuration */}
      <motion.div variants={itemVariants}>
        <h2 className="text-xl font-semibold mb-4 text-gray-800 dark:text-white">IDE Configuration</h2>
        <McpConfigSection config={config} status={status} />
      </motion.div>
    </motion.div>
  );
};

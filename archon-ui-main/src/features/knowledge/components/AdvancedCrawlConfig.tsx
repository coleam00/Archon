/**
 * Advanced Crawl Configuration Component
 * Provides UI for configuring domain filtering and URL patterns
 */

import { ChevronDown, Info, Plus, X } from "lucide-react";
import React, { useEffect, useState } from "react";
import type { CrawlConfig } from "../types";

interface Props {
  config: CrawlConfig;
  onChange: (config: CrawlConfig) => void;
}

export const AdvancedCrawlConfig: React.FC<Props> = ({ config, onChange }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const [newPattern, setNewPattern] = useState("");
  const [activeTab, setActiveTab] = useState<"allowed" | "excluded">("allowed");
  const [patternTab, setPatternTab] = useState<"include" | "exclude">("include");

  const handleAddDomain = (type: "allowed" | "excluded") => {
    if (!newDomain.trim()) return;

    const domain = newDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
    const key = `${type}_domains` as keyof CrawlConfig;
    const current = config[key] || [];

    if (!current.includes(domain)) {
      onChange({
        ...config,
        [key]: [...current, domain],
      });
    }

    setNewDomain("");
  };

  const handleRemoveDomain = (type: "allowed" | "excluded", domain: string) => {
    const key = `${type}_domains` as keyof CrawlConfig;
    onChange({
      ...config,
      [key]: (config[key] || []).filter(d => d !== domain),
    });
  };

  const handleAddPattern = (type: "include" | "exclude") => {
    if (!newPattern.trim()) return;

    const key = `${type}_patterns` as keyof CrawlConfig;
    const current = config[key] || [];

    if (!current.includes(newPattern)) {
      onChange({
        ...config,
        [key]: [...current, newPattern],
      });
    }

    setNewPattern("");
  };

  const handleRemovePattern = (type: "include" | "exclude", pattern: string) => {
    const key = `${type}_patterns` as keyof CrawlConfig;
    onChange({
      ...config,
      [key]: (config[key] || []).filter(p => p !== pattern),
    });
  };

  const hasAnyConfig =
    (config.allowed_domains && config.allowed_domains.length > 0) ||
    (config.excluded_domains && config.excluded_domains.length > 0) ||
    (config.include_patterns && config.include_patterns.length > 0) ||
    (config.exclude_patterns && config.exclude_patterns.length > 0);

  // Auto-expand when there's existing configuration
  useEffect(() => {
    if (hasAnyConfig && !isExpanded) {
      setIsExpanded(true);
    }
  }, [hasAnyConfig]);

  return (
    <div className="border border-gray-800 rounded-lg bg-gray-900/50 backdrop-blur-sm">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full p-4 flex items-center justify-between hover:bg-gray-800/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-gray-200 font-medium">Advanced Configuration</span>
          {hasAnyConfig && (
            <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-1 rounded-full">
              Active filters
            </span>
          )}
        </div>
        <ChevronDown
          className={`w-5 h-5 text-gray-400 transform transition-transform ${
            isExpanded ? "rotate-180" : ""
          }`}
        />
      </button>

      {isExpanded && (
        <div className="p-4 space-y-4 border-t border-gray-800">
          {/* Domain Filters Section */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <h3 className="text-sm font-medium text-gray-300">Domain Filters</h3>
              <div className="group relative">
                <Info className="w-4 h-4 text-gray-500 cursor-help" />
                <div className="absolute left-0 bottom-full mb-1 w-64 p-2 bg-gray-800 rounded text-xs text-gray-300
                  opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
                  Control which domains are crawled. Blacklist takes priority over whitelist.
                </div>
              </div>
            </div>

            {/* Domain Tabs */}
            <div className="flex gap-2 mb-3">
              <button
                onClick={() => setActiveTab("allowed")}
                className={`px-3 py-1 text-sm rounded transition-colors ${
                  activeTab === "allowed"
                    ? "bg-green-500/20 text-green-400"
                    : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                }`}
              >
                Allowed Domains ({config.allowed_domains?.length || 0})
              </button>
              <button
                onClick={() => setActiveTab("excluded")}
                className={`px-3 py-1 text-sm rounded transition-colors ${
                  activeTab === "excluded"
                    ? "bg-red-500/20 text-red-400"
                    : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                }`}
              >
                Excluded Domains ({config.excluded_domains?.length || 0})
              </button>
            </div>

            {/* Domain Input */}
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleAddDomain(activeTab);
                  }
                }}
                placeholder={`Add ${activeTab} domain (e.g., docs.example.com)`}
                className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-gray-200
                  placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
              />
              <button
                onClick={() => handleAddDomain(activeTab)}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm
                  transition-colors flex items-center gap-1"
              >
                <Plus className="w-4 h-4" />
                Add
              </button>
            </div>

            {/* Domain List */}
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {activeTab === "allowed" && config.allowed_domains?.map(domain => (
                <div
                  key={domain}
                  className="flex items-center justify-between px-3 py-1 bg-green-500/10
                    rounded text-sm text-green-400 group"
                >
                  <span>{domain}</span>
                  <button
                    onClick={() => handleRemoveDomain("allowed", domain)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="w-4 h-4 hover:text-red-400" />
                  </button>
                </div>
              ))}
              {activeTab === "excluded" && config.excluded_domains?.map(domain => (
                <div
                  key={domain}
                  className="flex items-center justify-between px-3 py-1 bg-red-500/10
                    rounded text-sm text-red-400 group"
                >
                  <span>{domain}</span>
                  <button
                    onClick={() => handleRemoveDomain("excluded", domain)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="w-4 h-4 hover:text-red-400" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* URL Patterns Section */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <h3 className="text-sm font-medium text-gray-300">URL Patterns</h3>
              <div className="group relative">
                <Info className="w-4 h-4 text-gray-500 cursor-help" />
                <div className="absolute left-0 bottom-full mb-1 w-64 p-2 bg-gray-800 rounded text-xs text-gray-300
                  opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
                  Use glob patterns to filter URLs. Example: */docs/* or *.pdf
                </div>
              </div>
            </div>

            {/* Pattern Tabs */}
            <div className="flex gap-2 mb-3">
              <button
                onClick={() => setPatternTab("include")}
                className={`px-3 py-1 text-sm rounded transition-colors ${
                  patternTab === "include"
                    ? "bg-green-500/20 text-green-400"
                    : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                }`}
              >
                Include Patterns ({config.include_patterns?.length || 0})
              </button>
              <button
                onClick={() => setPatternTab("exclude")}
                className={`px-3 py-1 text-sm rounded transition-colors ${
                  patternTab === "exclude"
                    ? "bg-red-500/20 text-red-400"
                    : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                }`}
              >
                Exclude Patterns ({config.exclude_patterns?.length || 0})
              </button>
            </div>

            {/* Pattern Input */}
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                value={newPattern}
                onChange={(e) => setNewPattern(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleAddPattern(patternTab);
                  }
                }}
                placeholder={`Add ${patternTab} pattern (e.g., */api/* or *.pdf)`}
                className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-gray-200
                  placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
              />
              <button
                onClick={() => handleAddPattern(patternTab)}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm
                  transition-colors flex items-center gap-1"
              >
                <Plus className="w-4 h-4" />
                Add
              </button>
            </div>

            {/* Pattern List */}
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {patternTab === "include" && config.include_patterns?.map(pattern => (
                <div
                  key={pattern}
                  className="flex items-center justify-between px-3 py-1 bg-green-500/10
                    rounded text-sm text-green-400 group font-mono"
                >
                  <span>{pattern}</span>
                  <button
                    onClick={() => handleRemovePattern("include", pattern)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="w-4 h-4 hover:text-red-400" />
                  </button>
                </div>
              ))}
              {patternTab === "exclude" && config.exclude_patterns?.map(pattern => (
                <div
                  key={pattern}
                  className="flex items-center justify-between px-3 py-1 bg-red-500/10
                    rounded text-sm text-red-400 group font-mono"
                >
                  <span>{pattern}</span>
                  <button
                    onClick={() => handleRemovePattern("exclude", pattern)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="w-4 h-4 hover:text-red-400" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Clear All Button */}
          {hasAnyConfig && (
            <button
              onClick={() => onChange({})}
              className="px-3 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-400
                rounded transition-colors"
            >
              Clear All Filters
            </button>
          )}
        </div>
      )}
    </div>
  );
};
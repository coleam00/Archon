/**
 * Bug Report Service for Archon Beta
 * 
 * Handles automatic context collection and GitHub issue creation for bug reports.
 */

import { getApiUrl } from '../config/api';

export interface BugContext {
  error: {
    message: string;
    stack?: string;
    name: string;
  };
  app: {
    version: string;
    url: string;
    timestamp: string;
  };
  system: {
    platform: string;
    userAgent: string;
    memory?: string;
  };
  services: {
    server: boolean;
    mcp: boolean;
    agents: boolean;
  };
  logs: string[];
}

export interface BugReportData {
  title: string;
  description: string;
  stepsToReproduce: string;
  expectedBehavior: string;
  actualBehavior: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  component: string;
  context: BugContext;
}

class BugReportService {
  /**
   * Collect automatic context information for bug reports
   */
  async collectBugContext(error?: Error): Promise<BugContext> {
    const context: BugContext = {
      error: {
        message: error?.message || 'Manual bug report',
        stack: error?.stack,
        name: error?.name || 'UserReportedError'
      },
      
      app: {
        version: await this.getVersion(),
        url: window.location.href,
        timestamp: new Date().toISOString()
      },
      
      system: {
        platform: navigator.platform,
        userAgent: navigator.userAgent,
        memory: this.getMemoryInfo()
      },
      
      services: await this.quickHealthCheck(),
      
      logs: await this.getRecentLogs(20)
    };

    return context;
  }

  /**
   * Get the current Archon version
   */
  private async getVersion(): Promise<string> {
    try {
      // Try to get version from main health endpoint
      const response = await fetch('/api/system/version');
      if (response.ok) {
        const data = await response.json();
        return data.version || 'v0.1.0';
      }
    } catch {
      // Fallback to default version
    }
    return 'v0.1.0';
  }

  /**
   * Get memory information if available
   */
  private getMemoryInfo(): string {
    try {
      const memory = (performance as any).memory;
      if (memory) {
        return `${Math.round(memory.usedJSHeapSize / 1024 / 1024)}MB used`;
      }
    } catch {
      // Memory API not available
    }
    return 'unknown';
  }

  /**
   * Quick health check of Archon services
   */
  private async quickHealthCheck(): Promise<{ server: boolean; mcp: boolean; agents: boolean; }> {
    const services = { server: false, mcp: false, agents: false };
    
    try {
      // Check services with a short timeout
      const checks = await Promise.allSettled([
        fetch('/api/health', { signal: AbortSignal.timeout(2000) }),
        fetch('/api/mcp/health', { signal: AbortSignal.timeout(2000) }),
        fetch('/api/agents/health', { signal: AbortSignal.timeout(2000) })
      ]);

      services.server = checks[0].status === 'fulfilled' && (checks[0].value as Response).ok;
      services.mcp = checks[1].status === 'fulfilled' && (checks[1].value as Response).ok;
      services.agents = checks[2].status === 'fulfilled' && (checks[2].value as Response).ok;
    } catch {
      // Health checks failed - services will remain false
    }
    
    return services;
  }

  /**
   * Get recent logs from browser console
   */
  private async getRecentLogs(limit: number): Promise<string[]> {
    // This is a simplified version - in a real implementation,
    // you'd want to capture console logs proactively
    return [
      `[${new Date().toISOString()}] Browser logs not captured - consider implementing console log capture`,
      `[${new Date().toISOString()}] To get server logs, check Docker container logs`,
      `[${new Date().toISOString()}] Current URL: ${window.location.href}`,
      `[${new Date().toISOString()}] User Agent: ${navigator.userAgent}`
    ];
  }

  /**
   * Submit bug report to GitHub via backend API
   * Handles both direct API creation (maintainers) and manual submission URLs (open source users)
   */
  async submitBugReport(bugReport: BugReportData): Promise<{ success: boolean; issueUrl?: string; issueNumber?: number; message?: string; error?: string }> {
    try {
      // Format the request to match backend API expectations
      const requestData = {
        title: bugReport.title,
        description: bugReport.description,
        stepsToReproduce: bugReport.stepsToReproduce,
        expectedBehavior: bugReport.expectedBehavior,
        actualBehavior: bugReport.actualBehavior,
        severity: bugReport.severity,
        component: bugReport.component,
        context: bugReport.context
      };

      const response = await fetch(`${getApiUrl()}/api/bug-report/github`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestData),
      });

      if (response.ok) {
        const result = await response.json();
        return {
          success: result.success,
          issueUrl: result.issue_url,
          issueNumber: result.issue_number,
          message: result.message
        };
      } else {
        const errorText = await response.text();
        return {
          success: false,
          error: `Failed to create issue: ${errorText}`
        };
      }
    } catch (error) {
      return {
        success: false,
        error: `Network error: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Format bug report for clipboard as fallback
   */
  formatReportForClipboard(bugReport: BugReportData): string {
    return `
# 🐛 Bug Report

**Version:** ${bugReport.context.app.version}
**Severity:** ${bugReport.severity}
**Component:** ${bugReport.component}
**Platform:** ${bugReport.context.system.platform}

## Description
${bugReport.description}

## Steps to Reproduce
${bugReport.stepsToReproduce}

## Expected Behavior
${bugReport.expectedBehavior}

## Actual Behavior
${bugReport.actualBehavior}

## Error Details
\`\`\`
Error: ${bugReport.context.error.name}
Message: ${bugReport.context.error.message}

${bugReport.context.error.stack || 'No stack trace available'}
\`\`\`

## System Info
- **Platform:** ${bugReport.context.system.platform}
- **URL:** ${bugReport.context.app.url}
- **Timestamp:** ${bugReport.context.app.timestamp}
- **Memory:** ${bugReport.context.system.memory}

## Service Status
- **Server:** ${bugReport.context.services.server ? '✅' : '❌'}
- **MCP:** ${bugReport.context.services.mcp ? '✅' : '❌'}
- **Agents:** ${bugReport.context.services.agents ? '✅' : '❌'}

---
*Generated by Archon Bug Reporter*
    `.trim();
  }
}

export const bugReportService = new BugReportService();
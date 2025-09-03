import { credentialsService } from './credentialsService';

interface HealthCheckCallback {
  onDisconnected: () => void;
  onReconnected: () => void;
}

// Health check interval constant - 30 seconds for reasonable balance
const HEALTH_CHECK_INTERVAL_MS = 30000; // 30 seconds

class ServerHealthService {
  private healthCheckInterval: number | null = null;
  private isConnected: boolean = true;
  private missedChecks: number = 0;
  private callbacks: HealthCheckCallback | null = null;

  // Settings
  private disconnectScreenEnabled: boolean = true;
  private maxMissedChecks: number = 2; // Show disconnect after 2 missed checks (60 seconds max with 30s interval)
  private checkInterval: number = HEALTH_CHECK_INTERVAL_MS; // Use constant for health check interval

  async loadSettings() {
    try {
      // Load disconnect screen settings from API
      const enabledRes = await credentialsService.getCredential('DISCONNECT_SCREEN_ENABLED').catch(() => ({ value: 'true' }));
      this.disconnectScreenEnabled = enabledRes.value === 'true';
    } catch (error) {
      // Failed to load disconnect screen settings
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      // Use the proxied /api/health endpoint which works in both dev and Docker
      const response = await fetch('/api/health', {
        method: 'GET',
        signal: AbortSignal.timeout(10000) // 10 second timeout (increased for heavy operations)
      });
      
      if (response.ok) {
        const data = await response.json();
        // Accept healthy, online, or initializing (server is starting up)
        const isHealthy = data.status === 'healthy' || data.status === 'online' || data.status === 'initializing';
        return isHealthy;
      }
      console.error('🏥 [Health] Response not OK:', response.status);
      return false;
    } catch (error) {
      console.error('🏥 [Health] Health check failed:', error);
      // Health check failed
      return false;
    }
  }

  startMonitoring(callbacks: HealthCheckCallback) {
    // Guard: Prevent multiple intervals by clearing any existing one
    if (this.healthCheckInterval) {
      console.warn('🏥 [Health] Health monitoring already active, stopping previous monitor');
      this.stopMonitoring();
    }

    this.callbacks = callbacks;
    this.missedChecks = 0;
    this.isConnected = true;

    // Load settings first
    this.loadSettings();

    // Start HTTP health polling
    this.healthCheckInterval = window.setInterval(async () => {
      const isHealthy = await this.checkHealth();
      
      if (isHealthy) {
        // Server is healthy
        if (this.missedChecks > 0) {
          // Was disconnected, now reconnected
          this.missedChecks = 0;
          this.handleConnectionRestored();
        }
      } else {
        // Server is not responding
        this.missedChecks++;
        // Health check failed
        
        // After maxMissedChecks failures, trigger disconnect screen
        if (this.missedChecks >= this.maxMissedChecks && this.isConnected) {
          this.isConnected = false;
          if (this.disconnectScreenEnabled && this.callbacks) {
            // Triggering disconnect screen after multiple health check failures
            this.callbacks.onDisconnected();
          }
        }
      }
    }, this.checkInterval);

    // Do an immediate check
    this.checkHealth().then(isHealthy => {
      if (!isHealthy) {
        this.missedChecks = 1;
      }
    });
  }

  private handleConnectionRestored() {
    if (!this.isConnected) {
      this.isConnected = true;
      // Connection to server restored
      if (this.callbacks) {
        this.callbacks.onReconnected();
      }
    }
  }

  stopMonitoring() {
    if (this.healthCheckInterval) {
      window.clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    this.callbacks = null;
  }

  isServerConnected(): boolean {
    return this.isConnected;
  }

  /**
   * Immediately trigger disconnect screen without waiting for health checks
   * Used when services detect immediate disconnection (e.g., polling failures, fetch errors)
   */
  handleImmediateDisconnect() {
    console.log('🏥 [Health] Immediate disconnect triggered');
    this.isConnected = false;
    this.missedChecks = this.maxMissedChecks; // Set to max to ensure disconnect screen shows
    
    if (this.disconnectScreenEnabled && this.callbacks) {
      console.log('🏥 [Health] Triggering disconnect screen immediately');
      this.callbacks.onDisconnected();
    }
  }

  /**
   * Handle when connection reconnects - reset state but let health check confirm
   */
  handleConnectionReconnect() {
    console.log('🏥 [Health] Connection reconnected, resetting missed checks');
    this.missedChecks = 0;
    // Don't immediately mark as connected - let health check confirm server is actually healthy
  }

  getSettings() {
    return {
      enabled: this.disconnectScreenEnabled
    };
  }

  async updateSettings(settings: { enabled?: boolean }) {
    if (settings.enabled !== undefined) {
      this.disconnectScreenEnabled = settings.enabled;
      await credentialsService.createCredential({
        key: 'DISCONNECT_SCREEN_ENABLED',
        value: settings.enabled.toString(),
        is_encrypted: false,
        category: 'features',
        description: 'Enable disconnect screen when server is disconnected'
      });
    }
  }
}

export const serverHealthService = new ServerHealthService();
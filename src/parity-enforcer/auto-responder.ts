import type { ActionConfig, ActionHandler, DriftAction, DriftReport, Severity } from './types';

export class AutoResponder {
  private readonly config: ActionConfig;
  private handler: ActionHandler | null;
  private errorHandler: ((error: unknown, action: DriftAction, report: DriftReport) => void) | null;
  private halted = false;

  constructor(config: ActionConfig, handler?: ActionHandler) {
    this.config = config;
    this.handler = handler ?? null;
    this.errorHandler = null;
  }

  onAction(handler: ActionHandler): void {
    this.handler = handler;
  }

  onError(handler: (error: unknown, action: DriftAction, report: DriftReport) => void): void {
    this.errorHandler = handler;
  }

  halt(): void {
    this.halted = true;
  }

  async respond(severity: Severity, report: DriftReport): Promise<DriftAction> {
    const action = this.getAction(severity);

    if (action === 'stop_trading') {
      this.halted = true;
    }

    if (this.handler) {
      try {
        await this.handler(action, report);
      } catch (error: unknown) {
        if (this.errorHandler) {
          try {
            this.errorHandler(error, action, report);
          } catch {
            // Error handler itself failed — nothing more we can do
          }
        }
      }
    }

    return action;
  }

  getAction(severity: Severity): DriftAction {
    return this.config[severity];
  }

  isHalted(): boolean {
    return this.halted;
  }

  resetHalt(): void {
    this.halted = false;
  }
}

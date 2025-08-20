/**
 * Structured logging utility for consistent logging across the application
 * Provides correlation ID support and consistent log formatting
 */

export interface LogContext {
  correlationId?: string;
  [key: string]: any;
}

export interface LogEvent {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  context?: LogContext;
  timestamp: string;
  component: string;
}

export class Logger {
  private component: string;

  constructor(component: string) {
    this.component = component;
  }

  private formatLog(
    level: LogEvent['level'],
    message: string,
    context?: LogContext
  ): LogEvent {
    return {
      level,
      message,
      context,
      timestamp: new Date().toISOString(),
      component: this.component,
    };
  }

  private writeLog(logEvent: LogEvent): void {
    const logMessage = `[${
      logEvent.timestamp
    }] ${logEvent.level.toUpperCase()} ${logEvent.component}: ${
      logEvent.message
    }`;

    const logData = logEvent.context
      ? [logMessage, logEvent.context]
      : [logMessage];

    switch (logEvent.level) {
      case 'debug':
        console.debug(...logData);
        break;
      case 'info':
        console.info(...logData);
        break;
      case 'warn':
        console.warn(...logData);
        break;
      case 'error':
        console.error(...logData);
        break;
    }
  }

  debug(message: string, context?: LogContext): void {
    this.writeLog(this.formatLog('debug', message, context));
  }

  info(message: string, context?: LogContext): void {
    this.writeLog(this.formatLog('info', message, context));
  }

  warn(message: string, context?: LogContext): void {
    this.writeLog(this.formatLog('warn', message, context));
  }

  error(message: string, context?: LogContext): void {
    this.writeLog(this.formatLog('error', message, context));
  }

  withCorrelationId(correlationId: string) {
    return {
      debug: (message: string, context?: LogContext) =>
        this.debug(message, { correlationId, ...context }),
      info: (message: string, context?: LogContext) =>
        this.info(message, { correlationId, ...context }),
      warn: (message: string, context?: LogContext) =>
        this.warn(message, { correlationId, ...context }),
      error: (message: string, context?: LogContext) =>
        this.error(message, { correlationId, ...context }),
    };
  }
}

export function createLogger(component: string): Logger {
  return new Logger(component);
}

import pino, { type Logger } from "pino";

let rootLogger: Logger | null = null;

export function getLogger(): Logger {
  if (rootLogger) return rootLogger;
  const isTty = process.stdout.isTTY;
  rootLogger = pino(
    isTty
      ? {
          level: process.env.SYMPHONY_LOG_LEVEL ?? "info",
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "SYS:standard" },
          },
        }
      : {
          level: process.env.SYMPHONY_LOG_LEVEL ?? "info",
        },
  );
  return rootLogger;
}

export function setLogLevel(level: string): void {
  const log = getLogger();
  log.level = level;
}

export type { Logger };

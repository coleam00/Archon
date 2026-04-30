import { resolve } from "node:path";
import { startService } from "./service.js";
import { getLogger } from "./logging/logger.js";

interface CliArgs {
  workflowPath: string;
  port: number | null;
  logLevel: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    workflowPath: "WORKFLOW.md",
    port: null,
    logLevel: null,
    help: false,
  };
  let positionalSeen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      args.help = true;
      continue;
    }
    if (a === "--port") {
      const v = argv[++i];
      if (typeof v !== "string") throw new Error("--port requires a value");
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`invalid --port: ${v}`);
      args.port = Math.floor(n);
      continue;
    }
    if (typeof a === "string" && a.startsWith("--port=")) {
      const n = Number(a.slice("--port=".length));
      if (!Number.isFinite(n) || n < 0) throw new Error(`invalid --port: ${a}`);
      args.port = Math.floor(n);
      continue;
    }
    if (a === "--log-level") {
      const v = argv[++i];
      if (typeof v !== "string") throw new Error("--log-level requires a value");
      args.logLevel = v;
      continue;
    }
    if (typeof a === "string" && a.startsWith("--log-level=")) {
      args.logLevel = a.slice("--log-level=".length);
      continue;
    }
    if (a && !a.startsWith("-") && !positionalSeen) {
      args.workflowPath = a;
      positionalSeen = true;
      continue;
    }
    throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(`Usage: symphony [WORKFLOW.md] [options]

Options:
  --port <n>           Start the HTTP dashboard / API on the given port
  --log-level <level>  Pino log level (debug, info, warn, error). Default: info
  -h, --help           Show this message

If no workflow path is given, ./WORKFLOW.md is used.
`);
}

async function main(): Promise<void> {
  let parsed: CliArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    process.exit(2);
  }
  if (parsed.help) {
    printHelp();
    return;
  }
  const workflowPath = resolve(parsed.workflowPath);
  let service;
  try {
    service = await startService({
      workflowPath,
      port: parsed.port,
      logLevel: parsed.logLevel ?? undefined,
    });
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    process.exit(1);
  }

  const logger = getLogger();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "received_shutdown_signal");
    try {
      await service!.stop();
      process.exit(0);
    } catch (e) {
      logger.error({ err: (e as Error).message }, "shutdown_failed");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();

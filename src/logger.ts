/**
 * Structured logger for the OpenMono Playbooks MCP server.
 *
 * Outputs JSON-structured log lines to stderr (so stdout remains clean for MCP stdio transport).
 * Supports log levels: debug, info, warn, error.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
  runId?: string;
  [key: string]: unknown;
}

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = process.env.LOG_LEVEL ? (process.env.LOG_LEVEL as LogLevel) : "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function log(
  level: LogLevel,
  component: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[currentLevel]) return;

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    component,
    message,
    ...extra,
  };

  process.stderr.write(JSON.stringify(entry) + "\n");
}

export const logger = {
  debug(component: string, message: string, extra?: Record<string, unknown>): void {
    log("debug", component, message, extra);
  },
  info(component: string, message: string, extra?: Record<string, unknown>): void {
    log("info", component, message, extra);
  },
  warn(component: string, message: string, extra?: Record<string, unknown>): void {
    log("warn", component, message, extra);
  },
  error(component: string, message: string, extra?: Record<string, unknown>): void {
    log("error", component, message, extra);
  },
};

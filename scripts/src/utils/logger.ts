export type LogLevel = "info" | "warn" | "error" | "debug";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const DEFAULT_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "info";

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[DEFAULT_LEVEL];
}

export function log(level: LogLevel, message: string, meta: Record<string, unknown> = {}): void {
  if (!shouldLog(level)) {
    return;
  }
  const payload = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"](
    `[${level.toUpperCase()}] ${message}${payload}`
  );
}

export const logger = {
  debug: (message: string, meta: Record<string, unknown> = {}) => log("debug", message, meta),
  info: (message: string, meta: Record<string, unknown> = {}) => log("info", message, meta),
  warn: (message: string, meta: Record<string, unknown> = {}) => log("warn", message, meta),
  error: (message: string, meta: Record<string, unknown> = {}) => log("error", message, meta)
};

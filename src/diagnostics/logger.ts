type LogLevel = "debug" | "info" | "warn" | "error";

type LogContext = Record<string, unknown>;

const levelWeights: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export function logDebug(message: string, context?: LogContext) {
  writeLog("debug", message, context);
}

export function logInfo(message: string, context?: LogContext) {
  writeLog("info", message, context);
}

export function logWarn(message: string, context?: LogContext) {
  writeLog("warn", message, context);
}

export function logError(message: string, error: unknown, context?: LogContext) {
  writeLog("error", message, {
    ...context,
    error: serializeError(error)
  });
}

function writeLog(level: LogLevel, message: string, context?: LogContext) {
  if (!shouldLog(level)) {
    return;
  }

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...sanitizeContext(context)
  };

  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

function shouldLog(level: LogLevel) {
  const configuredLevel = parseLogLevel(process.env.LOG_LEVEL);
  return levelWeights[level] >= levelWeights[configuredLevel];
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }

  return "info";
}

function sanitizeContext(context: LogContext | undefined) {
  if (!context) {
    return {};
  }

  const sanitized: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    sanitized[key] = sanitizeValue(value);
  }
  return sanitized;
}

function sanitizeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return serializeError(value);
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (isRecord(value)) {
    const sanitized: LogContext = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      sanitized[key] = sanitizeValue(nestedValue);
    }
    return sanitized;
  }

  return value;
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  return {
    message: String(error)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type StructuredLogLevel = "debug" | "info" | "warn" | "error";

export type StructuredLogValue = string | number | boolean | undefined;

export interface StructuredLogFields {
  readonly method?: string;
  readonly route?: string;
  readonly status?: number;
  readonly durationMs?: number;
  readonly correlationId?: string;
  readonly requestId?: string;
  readonly errorCode?: string;
  readonly retryable?: boolean;
  readonly component?: string;
  readonly [key: string]: StructuredLogValue;
}

export interface StructuredLoggerOptions {
  readonly enabled?: boolean;
  readonly now?: () => Date;
  readonly write?: (line: string) => void;
}

export interface StructuredLogger {
  log(level: StructuredLogLevel, event: string, fields?: StructuredLogFields): void;
  debug(event: string, fields?: StructuredLogFields): void;
  info(event: string, fields?: StructuredLogFields): void;
  warn(event: string, fields?: StructuredLogFields): void;
  error(event: string, fields?: StructuredLogFields): void;
}

const MAX_LABEL_LENGTH = 160;
const MAX_DURATION_MS = 600_000;
const SERVER_CORRELATION_ID_PATTERN = /^corr_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_FIELD_NAMES = new Set([
  // PROD-308 attachment.quarantined / attachment.scan_failed: identifiers and MIME pair, never the file name.
  "attachmentId",
  "resultVersionId",
  "declaredMime",
  "detectedMime",
  "sizeBytes",
  "method",
  "route",
  "status",
  "durationMs",
  "correlationId",
  "requestId",
  "errorCode",
  "retryable",
  "component",
  "reason",
  "accountId",
  "attempts",
  "distinctClients",
  "windowMs",
  "threshold"
]);
const SENSITIVE_FIELD_PATTERN = /password|secret|token|authorization|cookie|credential|api[_-]?key|connection|string|payload|body|content/i;

/**
 * Emits bounded JSON logs with an explicit field allowlist. Request bodies,
 * clinical content and credentials must never enter the application log
 * stream, even if a caller accidentally supplies them as extra metadata.
 */
export function createStructuredLogger(options: StructuredLoggerOptions = {}): StructuredLogger {
  const enabled = options.enabled ?? (process.env.NODE_ENV !== "test" && process.env.STRUCTURED_LOGGING !== "false");
  const now = options.now ?? (() => new Date());
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));

  function log(level: StructuredLogLevel, event: string, fields: StructuredLogFields = {}): void {
    if (!enabled) return;
    const record: Record<string, StructuredLogValue> = {
      timestamp: now().toISOString(),
      level,
      event: boundedLabel(event, "application.event")
    };
    for (const [name, value] of Object.entries(fields)) {
      const normalized = normalizeField(name, value);
      if (normalized !== undefined) record[name] = normalized;
    }
    try {
      write(JSON.stringify(record));
    } catch {
      // Observability must not change the outcome of a clinical request.
    }
  }

  return {
    log,
    debug: (event, fields) => log("debug", event, fields),
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields)
  };
}

export function logHttpRequest(
  fields: Pick<StructuredLogFields, "method" | "route" | "status" | "durationMs" | "correlationId">,
  options: StructuredLoggerOptions = {}
): void {
  createStructuredLogger(options).info("http.request", {
    ...fields,
    component: "http"
  });
}

function normalizeField(name: string, value: StructuredLogValue): StructuredLogValue {
  if (!ALLOWED_FIELD_NAMES.has(name) || SENSITIVE_FIELD_PATTERN.test(name) || value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return name === "durationMs" ? 0 : undefined;
    if (name === "status") return Number.isInteger(value) && value >= 100 && value <= 599 ? value : 500;
    if (name === "durationMs") return Math.max(0, Math.min(value, MAX_DURATION_MS));
    return value;
  }
  if (name === "correlationId") return SERVER_CORRELATION_ID_PATTERN.test(value) ? value : "external";
  return boundedLabel(value, "unknown");
}

function boundedLabel(value: string, fallback: string): string {
  const normalized = value.trim().replaceAll(/[\u0000-\u001f\u007f]/g, "");
  return (normalized || fallback).slice(0, MAX_LABEL_LENGTH);
}

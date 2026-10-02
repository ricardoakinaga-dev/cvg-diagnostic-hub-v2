import { ApiError } from "../http/envelope";

export const DEFAULT_PAGE_SIZE = 25;

export interface SearchCursor {
  rank: number;
  updatedAt: string;
  id: string;
}

export interface TimelineCursor {
  occurredAt: string;
  id: string;
}

export interface RequestCursor {
  createdAt: string;
  id: string;
}

export interface AuditCursor {
  occurredAt: string;
  id: string;
}

export function decodeKeysetCursor<T>(cursor: string | undefined, valid: (value: Record<string, unknown>) => boolean): T | undefined {
  if (!cursor) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) || !valid(decoded as Record<string, unknown>)) throw new Error("invalid");
    return decoded as T;
  } catch {
    throw new ApiError("VALIDATION_ERROR", "Cursor inválido.", 400);
  }
}

export function decodeSearchCursor(cursor: string | undefined): SearchCursor | undefined {
  return decodeKeysetCursor<SearchCursor>(cursor, (value) => Number.isSafeInteger(value.rank) && Number(value.rank) >= 0 && Number(value.rank) <= 2 && typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt)) && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 200);
}

export function decodeTimelineCursor(cursor: string | undefined): TimelineCursor | undefined {
  return decodeKeysetCursor<TimelineCursor>(cursor, (value) => typeof value.occurredAt === "string" && !Number.isNaN(Date.parse(value.occurredAt)) && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 200);
}

export function decodeRequestCursor(cursor: string | undefined): RequestCursor | undefined {
  return decodeKeysetCursor<RequestCursor>(cursor, (value) => typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt)) && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 200);
}

export function decodeAuditCursor(cursor: string | undefined): AuditCursor | undefined {
  return decodeKeysetCursor<AuditCursor>(cursor, (value) => typeof value.occurredAt === "string" && !Number.isNaN(Date.parse(value.occurredAt)) && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 200);
}

export function encodeKeysetCursor(value: SearchCursor | TimelineCursor | RequestCursor | AuditCursor): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function pageSize(value: number | undefined): number {
  const resolved = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 100) throw new ApiError("VALIDATION_ERROR", "O limite deve ser um inteiro entre 1 e 100.", 400);
  return resolved;
}

export function dateFilter(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!value || value.length > 100 || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value)) {
    throw new ApiError("VALIDATION_ERROR", `O filtro ${field} é inválido.`, 400);
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new ApiError("VALIDATION_ERROR", `O filtro ${field} é inválido.`, 400);
  return timestamp;
}

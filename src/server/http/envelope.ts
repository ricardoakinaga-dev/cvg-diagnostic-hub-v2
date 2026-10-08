import type { ApiErrorBody, ApiMeta, ApiSuccess } from "@cvg/contracts";

export class ApiError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status = 400,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

interface ApiErrorLike extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;
}

function isApiErrorLike(error: unknown): error is ApiErrorLike {
  if (error instanceof ApiError) return true;
  if (!(error instanceof Error) || error.name !== "ApiError") return false;
  const candidate = error as Partial<ApiErrorLike>;
  return typeof candidate.code === "string" && Number.isInteger(candidate.status);
}

export function createSuccessResponse<T>(
  data: T,
  correlationId: string,
  requestId: string,
  status = 200,
  extraMeta?: Partial<ApiMeta>
): { status: number; body: ApiSuccess<T> } {
  return {
    status,
    body: {
      data,
      meta: { ...extraMeta, correlationId, requestId }
    }
  };
}

export function createApiError(
  code: string,
  message: string,
  status: number,
  details?: Record<string, unknown>
): ApiError {
  return new ApiError(code, message, status, details);
}

export function toApiErrorResponse(
  error: unknown,
  correlationId: string,
  _requestId: string
): { status: number; body: ApiErrorBody } {
  if (isApiErrorLike(error)) {
    const safeDetails = error.details
      ? Object.fromEntries(
          Object.entries(error.details).filter(([key]) => ["currentVersion", "retryable", "existingRequestCodes", "nextAction", "importReport"].includes(key))
        )
      : undefined;
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(safeDetails && Object.keys(safeDetails).length > 0 ? { details: safeDetails } : {}),
          correlationId
        }
      }
    };
  }

  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message: "Não foi possível concluir a operação. Informe o código de correlação ao suporte.",
        correlationId
      }
    }
  };
}

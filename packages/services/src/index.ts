export interface ApiEnvelope<T> {
  data: T;
  meta: ApiResponseMeta;
}

export interface ApiResponseMeta {
  correlationId: string;
  requestId: string;
  [key: string]: unknown;
}

export interface ApiFetchResult<T> {
  data: T;
  meta: ApiResponseMeta;
}

export interface ApiFailure {
  error?: { code?: string; message?: string; details?: Record<string, unknown>; correlationId?: string };
}

/** Shown for any 403/404 on a scoped resource; the UI also uses it to know a retry can not help. */
export const ACCESS_DENIED_MESSAGE = "Você não tem acesso a este recurso.";
const GENERIC_API_ERROR = "Não foi possível concluir a operação. Informe o código de correlação ao suporte.";
const SAFE_ERROR_MESSAGES: Record<string, string> = {
  CATALOG_IMPORT_INVALID: "A planilha contém erros e nada foi importado. Valide novamente antes de aplicar.",
  CSRF_INVALID: "A sessão de segurança expirou. Atualize a página e tente novamente.",
  CURRENT_PASSWORD_INVALID: "A senha atual não confere.",
  PASSWORD_BREACHED: "Esta senha apareceu em vazamentos conhecidos; escolha outra.",
  PASSWORD_POLICY: "Esta senha é fraca. Evite repetições, sequências, seu nome ou e-mail e senhas comuns.",
  PASSWORD_RESET_INVALID: "Link de redefinição inválido ou expirado.",
  IDEMPOTENCY_KEY_REUSED: "Esta operação já foi recebida. Atualize os dados antes de tentar novamente.",
  NOT_FOUND: "O recurso solicitado não está disponível.",
  CONFLICT: "Este registro já existe ou mudou. Atualize os dados e tente novamente.",
  RATE_LIMITED: "Muitas tentativas em pouco tempo. Aguarde e tente novamente.",
  SCOPE_DENIED: ACCESS_DENIED_MESSAGE,
  SESSION_EXPIRED: "Sua sessão expirou. Entre novamente para continuar.",
  UNAUTHENTICATED: "Sua sessão não está disponível. Entre novamente para continuar.",
  VALIDATION_ERROR: "Revise os dados informados e tente novamente.",
  CRITICAL_ACK_REQUIRED: "Confirme a notificação crítica antes de revisar o resultado.",
  NOTIFICATION_NOT_DELIVERED: "A notificação ainda está sendo entregue. Atualize e tente novamente.",
  NOTIFICATION_STALE: "O resultado crítico mudou. Abra o contexto atual antes de confirmar.",
  SESSION_ALREADY_REVOKED: "Esta sessão já foi revogada.",
  OUTBOX_DEAD_LETTER_ALREADY_DISCARDED: "Esta mensagem já foi descartada.",
  OUTBOX_NOT_DEAD_LETTERED: "Esta mensagem não está disponível para operação.",
  ACCESSION_INVALID: "O código lido é inválido. Leia a etiqueta novamente ou digite o código.",
  ACCESSION_MISMATCH: "O código lido não corresponde à amostra esperada deste exame.",
  DUPLICATE_WARNING: "Já existe um exame ativo compatível. Confirme o motivo para prosseguir.",
  RESULT_RELEASE_BLOCKED: "Finalize ou remova os anexos pendentes antes de liberar o resultado.",
  SCHEDULE_CONFLICT: "O recurso já está reservado neste intervalo.",
  STALE_VERSION: "Os dados mudaram enquanto você trabalhava. Atualize a tela antes de continuar."
};

export class ApiClientError extends Error {
  readonly code?: string;
  readonly correlationId?: string;
  readonly status: number;

  constructor(status: number, failure: ApiFailure) {
    const code = typeof failure.error?.code === "string" ? failure.error.code : undefined;
    super((code && SAFE_ERROR_MESSAGES[code]) ?? GENERIC_API_ERROR);
    this.name = "ApiClientError";
    this.code = code;
    this.correlationId = typeof failure.error?.correlationId === "string" ? failure.error.correlationId : undefined;
    this.status = status;
  }
}

export function getSafeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback;
}

function normalizeApiFailure(body: unknown): ApiFailure {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
  const candidate = (body as { error?: unknown }).error;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return {};
  const error = candidate as Record<string, unknown>;
  return { error: { code: typeof error.code === "string" ? error.code : undefined, correlationId: typeof error.correlationId === "string" ? error.correlationId : undefined } };
}

function isApiEnvelope<T>(body: unknown): body is ApiEnvelope<T> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const candidate = body as { data?: unknown; meta?: unknown };
  if (!Object.prototype.hasOwnProperty.call(candidate, "data")) return false;
  if (typeof candidate.meta !== "object" || candidate.meta === null || Array.isArray(candidate.meta)) return false;
  const meta = candidate.meta as { correlationId?: unknown; requestId?: unknown };
  return typeof meta.correlationId === "string" && typeof meta.requestId === "string";
}

function csrfToken(): string | undefined {
  if (typeof document === "undefined") return undefined;
  return document.cookie.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith("cvg_csrf="))?.slice("cvg_csrf=".length);
}

export function createClientUniqueId(): string {
  const webCrypto = typeof globalThis.crypto === "undefined" ? undefined : globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();
  if (typeof webCrypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    webCrypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export async function apiFetchWithMeta<T>(path: string, init: RequestInit = {}): Promise<ApiFetchResult<T>> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (init.method && init.method !== "GET") {
    const token = csrfToken();
    if (token) headers.set("x-csrf-token", token);
    if (!headers.has("idempotency-key")) headers.set("idempotency-key", createClientUniqueId());
  }
  const response = await fetch(`/api/v1${path}`, { ...init, headers, credentials: "include" });
  let body: unknown;
  try { body = await response.json(); } catch { throw new ApiClientError(response.status, {}); }
  if (!response.ok) throw new ApiClientError(response.status, normalizeApiFailure(body));
  if (!isApiEnvelope<T>(body)) throw new ApiClientError(response.status, {});
  return { data: body.data, meta: body.meta };
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  return (await apiFetchWithMeta<T>(path, init)).data;
}

export function formatRelativeTime(value: string): string {
  const deltaMs = Date.now() - new Date(value).getTime();
  if (deltaMs < 0) {
    const futureMs = Math.abs(deltaMs);
    if (futureMs < 60_000) return "em instantes";
    const futureMinutes = Math.ceil(futureMs / 60_000);
    if (futureMinutes < 60) return `em ${futureMinutes} min`;
    const futureHours = Math.ceil(futureMinutes / 60);
    if (futureHours < 24) return `em ${futureHours} h`;
    const futureDays = Math.ceil(futureHours / 24);
    return `em ${futureDays} ${futureDays === 1 ? "dia" : "dias"}`;
  }
  const elapsedMinutes = Math.round(deltaMs / 60000);
  if (elapsedMinutes < 1) return "agora";
  if (elapsedMinutes < 60) return `há ${elapsedMinutes} min`;
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (elapsedHours < 24) return `há ${elapsedHours} h`;
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

import type { ApiMethod, ApiAuthentication, ApiMediaType, ApiRequestHeader, ApiRequestBody, ApiQueryParameter, ApiQueryConstraints, ApiConditionalRequestRule, ApiOperationDraft } from "./api-operation-model";

export const CORRELATION = { name: "x-correlation-id", required: false } as const;
export const CSRF = { name: "x-csrf-token", required: true } as const;
export const IDEMPOTENCY = { name: "idempotency-key", required: false } as const;
export const IDEMPOTENCY_REQUIRED = { name: "idempotency-key", required: true } as const;
export const IF_MATCH = { name: "if-match", required: false } as const;
export const LAST_EVENT_ID = { name: "last-event-id", required: false } as const;
export const DUPLICATE_OVERRIDE = { name: "x-duplicate-override", required: false } as const;
export const HUB_SIGNATURE = { name: "x-hub-signature-256", required: true } as const;

export const PUBLIC_READ_ERRORS = [429, 500] as const;
export const PUBLIC_COMMAND_ERRORS = [400, 401, 429, 500] as const;
export const PUBLIC_JSON_COMMAND_ERRORS = [400, 401, 415, 429, 500] as const;
export const READ_ERRORS = [400, 401, 403, 404, 429, 500] as const;
export const COMMAND_ERRORS = [400, 401, 403, 404, 409, 429, 500] as const;
export const JSON_COMMAND_ERRORS = [400, 401, 403, 404, 409, 415, 429, 500] as const;
export const JSON_COMMAND_WITH_POLICY_ERRORS = [400, 401, 403, 404, 409, 415, 422, 429, 500] as const;

export const jsonBody = (schema: string): ApiRequestBody => Object.freeze({ mediaType: "application/json", schema, required: true });
export const binaryBody = (schema: string): ApiRequestBody => Object.freeze({ mediaType: "application/octet-stream", schema, required: true });

export const read = (
  path: `/${string}`,
  operationId: string,
  summary: string,
  tag: string,
  options: Readonly<{
    authentication?: ApiAuthentication;
    queryParameters?: ReadonlyArray<ApiQueryParameter>;
    queryConstraints?: ApiQueryConstraints;
    requestHeaders?: ReadonlyArray<ApiRequestHeader>;
    successMediaTypes?: ReadonlyArray<ApiMediaType>;
    successHeaders?: ReadonlyArray<string>;
    errorStatuses?: ReadonlyArray<number>;
    serviceTokenScheme?: "metricsBearer";
  }> = {}
): ApiOperationDraft => Object.freeze({
  method: "GET",
  path,
  operationId,
  summary,
  tag,
  authentication: options.authentication ?? "session",
  csrf: false,
  requestHeaders: Object.freeze([CORRELATION, ...(options.requestHeaders ?? [])]),
  ...(options.queryParameters ? { queryParameters: Object.freeze([...options.queryParameters]) } : {}),
  ...(options.queryConstraints ? { queryConstraints: Object.freeze({
    ...(options.queryConstraints.atLeastOneOf ? { atLeastOneOf: Object.freeze([...options.queryConstraints.atLeastOneOf]) } : {}),
    ...(options.queryConstraints.fromMustNotExceedTo ? { fromMustNotExceedTo: true as const } : {})
  }) } : {}),
  successStatuses: Object.freeze([200]),
  successMediaTypes: Object.freeze([...(options.successMediaTypes ?? ["application/json"])]),
  successHeaders: Object.freeze([...(options.successHeaders ?? ["x-correlation-id", "cache-control"])]),
  errorStatuses: Object.freeze([...(options.errorStatuses ?? READ_ERRORS)]),
  ...(options.serviceTokenScheme ? { serviceTokenScheme: options.serviceTokenScheme } : {})
});

export const command = (
  method: Exclude<ApiMethod, "GET">,
  path: `/${string}`,
  operationId: string,
  summary: string,
  tag: string,
  requestBody: ApiRequestBody | undefined,
  options: Readonly<{
    authentication?: ApiAuthentication;
    headers?: ReadonlyArray<ApiRequestHeader>;
    successHeaders?: ReadonlyArray<string>;
    successStatus?: 200 | 201;
    errorStatuses?: ReadonlyArray<number>;
    conditionalRequestRules?: ReadonlyArray<ApiConditionalRequestRule>;
    concurrencyResource?: string;
    integrationTokenScheme?: "integrationBearer" | "hisV4WebhookSignature";
  }> = {}
): ApiOperationDraft => {
  const authentication = options.authentication ?? "session";
  const csrf = authentication === "session";
  const defaultErrors = authentication === "public"
    ? requestBody?.mediaType === "application/json" ? PUBLIC_JSON_COMMAND_ERRORS : PUBLIC_COMMAND_ERRORS
    : requestBody?.mediaType === "application/json" ? JSON_COMMAND_ERRORS : COMMAND_ERRORS;
  const requestHeaders = [CORRELATION, ...(csrf ? [CSRF] : []), ...(options.headers ?? [])] as const;
  const hasConcurrencyGuard = requestHeaders.some((header) => header.name === "if-match");
  if (hasConcurrencyGuard && !options.concurrencyResource) throw new Error(`${method} ${path} is missing its concurrency resource.`);
  return Object.freeze({
    method,
    path,
    operationId,
    summary,
    tag,
    authentication,
    csrf,
    ...(options.integrationTokenScheme ? { integrationTokenScheme: options.integrationTokenScheme } : {}),
    requestHeaders: Object.freeze([...requestHeaders]),
    ...(requestBody ? { requestBody } : {}),
    ...(hasConcurrencyGuard ? { concurrencyGuard: Object.freeze({
      atLeastOneOf: Object.freeze(["If-Match", "body.expectedVersion"] as const),
      malformedHeader: "reject" as const,
      conflictingSources: "reject" as const,
      resourceVersion: options.concurrencyResource!
    }) } : {}),
    ...(options.conditionalRequestRules ? { conditionalRequestRules: Object.freeze(options.conditionalRequestRules.map((rule) => Object.freeze({
      when: Object.freeze({ ...rule.when }),
      requiredHeaders: Object.freeze([...rule.requiredHeaders]),
      requiredBodyFields: Object.freeze([...rule.requiredBodyFields])
    }))) } : {}),
    successStatuses: Object.freeze([options.successStatus ?? 200]),
    successMediaTypes: Object.freeze(["application/json"] as const),
    successHeaders: Object.freeze([...(options.successHeaders ?? ["x-correlation-id", "cache-control"])]),
    errorStatuses: Object.freeze([...(options.errorStatuses ?? defaultErrors)])
  });
};

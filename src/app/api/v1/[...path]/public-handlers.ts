import { getRuntimeReadiness, getRuntimeStoreAsync } from "../../../../server/store/runtime";
import { InvalidLoginCredentialsError, loginUser, sessionCookies } from "../../../../server/security/session";
import { ApiError } from "../../../../server/http/envelope";
import { assertLoginAttempt, assertRateLimit, registerLoginFailure, registerLoginSuccess } from "../../../../server/security/rate-limit";
import { recordReadinessFailure } from "../../../../server/observability/metrics";
import { loginSchema, responseFor, jsonBody, publicUser, positiveInteger, assertHealthRateLimit } from "./route-support";
import type { ApiHandlerGroup } from "./route-support";
export const publicHandlers = {
  getLiveness: { authentication: "public", handle: async ({ operation, correlationId, id, rateLimitClientKey }) => {
      const healthRateLimit = positiveInteger(process.env.HEALTH_RATE_LIMIT, 60);
      await assertHealthRateLimit(`health:${operation.operationId}:${rateLimitClientKey}`, healthRateLimit);
      return responseFor({ status: "ok", service: "cvg-diagnostics-hub" }, correlationId, id);
    } },
  getReadiness: { authentication: "public", handle: async ({ operation, correlationId, id, rateLimitClientKey }) => {
      const healthRateLimit = positiveInteger(process.env.HEALTH_RATE_LIMIT, 60);
      await assertHealthRateLimit(`health:${operation.operationId}:${rateLimitClientKey}`, healthRateLimit);
      let readiness: {
        dataMode: string;
        storageMode: string;
      };
      try {
        readiness = await getRuntimeReadiness();
      }
      catch {
        recordReadinessFailure();
        throw new ApiError("NOT_READY", "A dependência de persistência ainda não está disponível.", 503, { retryable: true });
      }
      return responseFor({ status: "ready", ...readiness }, correlationId, id);
    } },
  login: { authentication: "public", handle: async ({ request, correlationId, id, rateLimitClientKey, clientIdentity }) => {
      const store = await getRuntimeStoreAsync();
      const loginRateLimit = positiveInteger(process.env.LOGIN_RATE_LIMIT, 10);
      if (clientIdentity.key)
        await assertRateLimit(`login-client:${clientIdentity.key}`, loginRateLimit, 60000);
      const parsed = loginSchema.safeParse(await jsonBody(request));
      if (!parsed.success)
        throw new ApiError("VALIDATION_ERROR", "Informe e-mail e senha válidos.", 400);
      const loginIdentity = { email: parsed.data.email, clientKey: rateLimitClientKey };
      await assertLoginAttempt(loginIdentity, { limit: loginRateLimit, windowMs: 60000 });
      let login: Awaited<ReturnType<typeof loginUser>>;
      try {
        login = await loginUser(store, parsed.data.email, parsed.data.password, {
          beforeSessionCreate: () => registerLoginSuccess(loginIdentity)
        });
      }
      catch (error) {
        // Only wrong passwords feed the backoff. A correct password is never
        // delayed by somebody else's guessing run.
        if (error instanceof InvalidLoginCredentialsError) {
          await registerLoginFailure(loginIdentity);
        }
        throw error;
      }
      const response = responseFor({ user: publicUser(login.user), expiresAt: login.expiresAt }, correlationId, id);
      for (const cookie of sessionCookies(login))
        response.headers.append("set-cookie", cookie);
      return response;
    } }
} satisfies ApiHandlerGroup;

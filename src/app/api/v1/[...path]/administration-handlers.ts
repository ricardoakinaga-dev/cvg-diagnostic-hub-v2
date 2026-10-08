import { listClinicalReasons } from "../../../../server/application/clinical-reasons";
import { updateOwnAlertContact } from "../../../../server/application/alert-contact";
import { reauthenticationSchema, initialPasswordSchema, passwordChangeSchema, alertContactSchema, serviceCreateSchema, servicePatchSchema, userRoleSchema, userOnCallSchema, userCreateSchema, userDeactivateSchema, userPasswordSchema, sessionRevokeSchema } from "../../../../server/http/admin-schemas";
import { changeInitialPassword, changeOwnPassword, clearSessionCookies, getCookieValue, reauthenticateUser, revokeSession, sessionCookies } from "../../../../server/security/session";
import { ApiError } from "../../../../server/http/envelope";
import { reasonCreateSchema, reasonPatchSchema, responseFor, jsonBody, objectBody, commandMeta, publicUser, parseBooleanFilter } from "./route-support";
import type { ApiHandlerGroup } from "./route-support";
export const administrationHandlers = {
  getCurrentSession: { authentication: "session", handle: async ({ correlationId, id, actor }) => {
      return responseFor({ user: publicUser(actor) }, correlationId, id);
    } },
  changeInitialPassword: { authentication: "session", handle: async ({ request, correlationId, id, store }) => {
      const parsed = initialPasswordSchema.safeParse(await jsonBody(request));
      if (!parsed.success)
        throw new ApiError("VALIDATION_ERROR", "Informe uma nova senha válida.", 400);
      const login = await changeInitialPassword(store, request, parsed.data.password, correlationId);
      const response = responseFor({ user: publicUser(login.user), expiresAt: login.expiresAt }, correlationId, id);
      sessionCookies(login).forEach((cookie) => response.headers.append("set-cookie", cookie));
      return response;
    } },
  changeOwnPassword: { authentication: "session", handle: async ({ request, correlationId, id, store }) => {
      const parsed = passwordChangeSchema.safeParse(await jsonBody(request));
      if (!parsed.success)
        throw new ApiError("VALIDATION_ERROR", "Informe a senha atual e uma nova senha válida.", 400);
      const login = await changeOwnPassword(store, request, parsed.data.currentPassword, parsed.data.newPassword, correlationId);
      const response = responseFor({ user: publicUser(login.user), expiresAt: login.expiresAt }, correlationId, id);
      sessionCookies(login).forEach((cookie) => response.headers.append("set-cookie", cookie));
      return response;
    } },
  updateOwnAlertContact: { authentication: "session", handle: async ({ request, correlationId, id, store, actor }) => {
      const parsed = alertContactSchema.safeParse(await jsonBody(request));
      if (!parsed.success)
        throw new ApiError("VALIDATION_ERROR", "Informe o celular e autorize o envio dos alertas.", 400);
      const updated = await updateOwnAlertContact(store, actor, parsed.data, correlationId);
      return responseFor({ user: publicUser(updated) }, correlationId, id);
    } },
  logout: { authentication: "session", handle: async ({ request, correlationId, id, store }) => {
      const sessionToken = getCookieValue(request, "cvg_session");
      if (sessionToken)
        await revokeSession(store, sessionToken);
      const response = responseFor({ loggedOut: true }, correlationId, id);
      for (const cookie of clearSessionCookies())
        response.headers.append("set-cookie", cookie);
      return response;
    } },
  reauthenticate: { authentication: "session", handle: async ({ request, correlationId, id, store }) => {
      const parsed = reauthenticationSchema.safeParse(await jsonBody(request));
      if (!parsed.success)
        throw new ApiError("VALIDATION_ERROR", "Informe sua senha para confirmar a identidade.", 400);
      const reauthenticated = await reauthenticateUser(store, request, parsed.data.password);
      return responseFor({ user: publicUser(reauthenticated), reauthenticatedAt: reauthenticated.reauthenticatedAt }, correlationId, id);
    } },
  listClinicalReasons: { authentication: "session", handle: async ({ correlationId, id, store, actor }) => {
      return responseFor(await listClinicalReasons(store, actor), correlationId, id);
    } },
  listUsers: { authentication: "session", handle: async ({ correlationId, id, service, actor }) => {
      return responseFor(await service.listManagedUsers(actor), correlationId, id);
    } },
  listSessions: { authentication: "session", handle: async ({ correlationId, id, service, actor }) => {
      return responseFor(await service.listManagedSessions(actor), correlationId, id);
    } },
  createUser: { authentication: "session", handle: async ({ request, operation, correlationId, id, service, actor }) => {
      const body = await objectBody(request);
      const parsed = userCreateSchema.safeParse(body);
      if (!parsed.success)
        throw new ApiError("VALIDATION_ERROR", "Os dados do colaborador são inválidos.", 400);
      return responseFor(await service.createManagedUser(actor, { ...parsed.data, ...commandMeta(request, body, operation) }), correlationId, id, 201);
    } },
  deactivateUser: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const body = await objectBody(request);
      const parsed = userDeactivateSchema.safeParse(body);
      if (!parsed.success)
        throw new ApiError("VALIDATION_ERROR", "Os dados de desativação são inválidos.", 400);
      return responseFor(await service.deactivateManagedUser(actor, path[1], { ...parsed.data, ...commandMeta(request, body, operation) }), correlationId, id);
    } },
  updateUserRole: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const body = await objectBody(request);
      const parsed = userRoleSchema.safeParse(body);
      if (!parsed.success)
        throw new ApiError("VALIDATION_ERROR", "Os dados de role são inválidos.", 400);
      return responseFor(await service.updateUserRole(actor, path[1], { ...parsed.data, ...commandMeta(request, body, operation) }), correlationId, id);
    } },
  updateUserOnCall: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const body = await objectBody(request);
      const parsed = userOnCallSchema.safeParse(body);
      if (!parsed.success)
        throw new ApiError("VALIDATION_ERROR", "Os dados de plantão são inválidos.", 400);
      return responseFor(await service.updateUserOnCall(actor, path[1], { ...parsed.data, ...commandMeta(request, body, operation) }), correlationId, id);
    } },
  revokeSession: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const body = await objectBody(request);
      const parsed = sessionRevokeSchema.safeParse(body);
      if (!parsed.success)
        throw new ApiError("VALIDATION_ERROR", "Os dados de revogação de sessão são inválidos.", 400);
      return responseFor(await service.revokeManagedSession(actor, path[1], { ...parsed.data, ...commandMeta(request, body, operation) }), correlationId, id);
    } },
  regenerateUserPassword: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const body = await objectBody(request);
      const parsed = userPasswordSchema.safeParse(body);
      if (!parsed.success)
        throw new ApiError("VALIDATION_ERROR", "Os dados de recuperação de acesso são inválidos.", 400);
      return responseFor(await service.regenerateManagedUserPassword(actor, path[1], { ...parsed.data, ...commandMeta(request, body, operation) }), correlationId, id);
    } },
  listDiagnosticServices: { authentication: "session", handle: async ({ request, correlationId, id, service, actor }) => {
      const includeInactive = parseBooleanFilter(new URL(request.url).searchParams.get("includeInactive"), "includeInactive") ?? false;
      return responseFor(await service.listServices(actor, { includeInactive }), correlationId, id);
    } },
  getResultTemplate: { authentication: "session", handle: async ({ path, correlationId, id, service, actor }) => {
      return responseFor(await service.getResultTemplate(actor, path[1]), correlationId, id);
    } },
  createDiagnosticService: { authentication: "session", handle: async ({ request, operation, correlationId, id, service, actor }) => {
      const body = await objectBody(request);
      const parsed = serviceCreateSchema.safeParse(body);
      if (!parsed.success)
        throw new ApiError("VALIDATION_ERROR", "Os dados do serviço são inválidos.", 400);
      return responseFor(await service.createDiagnosticService(actor, { ...parsed.data, ...commandMeta(request, body, operation) }), correlationId, id, 201);
    } },
  updateDiagnosticService: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const body = await objectBody(request);
      const parsed = servicePatchSchema.safeParse(body);
      if (!parsed.success)
        throw new ApiError("VALIDATION_ERROR", "Os dados do serviço são inválidos.", 400);
      return responseFor(await service.updateDiagnosticService(actor, path[1], { ...parsed.data, ...commandMeta(request, body, operation) }), correlationId, id);
    } },
  createReasonCode: { authentication: "session", handle: async ({ request, operation, correlationId, id, service, actor }) => {
      const body = await objectBody(request);
      const parsed = reasonCreateSchema.safeParse(body);
      if (!parsed.success)
        throw new ApiError("VALIDATION_ERROR", "Os dados do motivo são inválidos.", 400);
      return responseFor(await service.createReasonCode(actor, { ...parsed.data, ...commandMeta(request, body, operation) }), correlationId, id, 201);
    } },
  updateReasonCode: { authentication: "session", handle: async ({ request, path, operation, correlationId, id, service, actor }) => {
      const body = await objectBody(request);
      const parsed = reasonPatchSchema.safeParse(body);
      if (!parsed.success)
        throw new ApiError("VALIDATION_ERROR", "Os dados do motivo são inválidos.", 400);
      return responseFor(await service.updateReasonCode(actor, path[1], { ...parsed.data, ...commandMeta(request, body, operation) }), correlationId, id);
    } },
  listReasonCodes: { authentication: "session", handle: async ({ correlationId, id, service, actor }) => {
      return responseFor(await service.listReasonCodes(actor), correlationId, id);
    } }
} satisfies ApiHandlerGroup;

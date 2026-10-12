import * as schemas from "../../../../server/http/work-activity-schemas";
import { responseFor, type ApiHandlerGroup } from "./route-support";
import { planningCommand, planningFilters } from "./hospital-planning-handler-support";
export const workActivityHandlers = {
  listWorkActivityPreferences: { authentication: "session", handle: async ({ request, actor, service, correlationId, id }) => responseFor(await service.listWorkActivityPreferences(actor, planningFilters(request, schemas.workActivityPreferenceFiltersSchema)), correlationId, id) },
  putWorkActivityPreference: { authentication: "session", handle: async (c) => planningCommand(c, schemas.workActivityPreferenceSchema, (input) => c.service.putWorkActivityPreference(c.actor, input)) },
  listWorkNotifications: { authentication: "session", handle: async ({ request, actor, service, correlationId, id }) => responseFor(await service.listWorkNotifications(actor, planningFilters(request, schemas.workNotificationFiltersSchema, ["includeArchived", "unreadOnly"])), correlationId, id) },
  getWorkNotificationPreferences: { authentication: "session", handle: async ({ actor, service, correlationId, id }) => responseFor(await service.getWorkNotificationPreferences(actor), correlationId, id) },
  putWorkNotificationPreferences: { authentication: "session", handle: async (c) => planningCommand(c, schemas.workNotificationPreferenceSchema, (input) => c.service.putWorkNotificationPreferences(c.actor, input)) },
  markWorkNotificationsRead: { authentication: "session", handle: async (c) => planningCommand(c, schemas.workNotificationReadSchema, (input) => c.service.markWorkNotificationsRead(c.actor, input), false) },
  setWorkNotificationArchived: { authentication: "session", handle: async (c) => planningCommand(c, schemas.workNotificationArchiveSchema, (input) => c.service.setWorkNotificationArchived(c.actor, c.path[1], input)) }
} satisfies ApiHandlerGroup;

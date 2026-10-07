import { createApiHandlerRegistry } from "../../../../server/http/api-handler-registry";
import { API_OPERATIONS } from "../../../../server/http/api-operation-manifest";
import { administrationHandlers } from "./administration-handlers";
import { clinicalHandlers } from "./clinical-handlers";
import { operationsHandlers } from "./operations-handlers";
import { publicHandlers } from "./public-handlers";
import type { PublicHandlerContext, SessionHandlerContext } from "./route-support";

export const API_HANDLER_GROUPS = Object.freeze([
  publicHandlers, administrationHandlers, clinicalHandlers, operationsHandlers
]);

export const API_HANDLER_REGISTRY = createApiHandlerRegistry<PublicHandlerContext, SessionHandlerContext>(
  API_OPERATIONS, API_HANDLER_GROUPS
);

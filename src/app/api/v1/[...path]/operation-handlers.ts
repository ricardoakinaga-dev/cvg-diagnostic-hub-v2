import { createApiHandlerRegistry } from "../../../../server/http/api-handler-registry";
import { API_OPERATIONS } from "../../../../server/http/api-operation-manifest";
import { administrationHandlers } from "./administration-handlers";
import { departmentHandlers } from "./department-handlers";
import { accessGroupHandlers } from "./access-group-handlers";
import { examDefinitionHandlers } from "./exam-definition-handlers";
import { hospitalServiceHandlers } from "./hospital-service-handlers";
import { hospitalTaskHandlers } from "./hospital-task-handlers";
import { hospitalResourceHandlers } from "./hospital-resource-handlers";
import { hospitalPlanHandlers } from "./hospital-plan-handlers";
import { hospitalChecklistHandlers } from "./hospital-checklist-handlers";
import { hospitalShiftHandlers } from "./hospital-shift-handlers";
import { hospitalDocumentHandlers } from "./hospital-document-handlers";
import { hospitalAnalyticsHandlers } from "./hospital-analytics-handlers";
import { hospitalInstitutionHandlers } from "./hospital-institution-handlers";
import { hospitalTaskCollaborationHandlers } from "./hospital-task-collaboration-handlers";
import { workActivityHandlers } from "./work-activity-handlers";
import { hospitalExternalHandlers } from "./hospital-external-handlers";
import { plannerViewHandlers } from "./planner-view-handlers";
import { diagnosticPlanningHandlers } from "./diagnostic-planning-handlers";
import { clinicalHandlers } from "./clinical-handlers";
import { operationsHandlers } from "./operations-handlers";
import { publicHandlers } from "./public-handlers";
import { webhookHandlers } from "./webhook-handlers";
import type { PublicHandlerContext, SessionHandlerContext } from "./route-support";

export const API_HANDLER_GROUPS = Object.freeze([
  hospitalInstitutionHandlers, hospitalTaskCollaborationHandlers, workActivityHandlers,
  hospitalExternalHandlers,
  publicHandlers, administrationHandlers, departmentHandlers, accessGroupHandlers, examDefinitionHandlers, diagnosticPlanningHandlers, hospitalServiceHandlers, plannerViewHandlers, hospitalTaskHandlers, hospitalResourceHandlers, hospitalPlanHandlers, hospitalChecklistHandlers, hospitalShiftHandlers, hospitalDocumentHandlers, hospitalAnalyticsHandlers, clinicalHandlers, operationsHandlers, webhookHandlers
]);

export const API_HANDLER_REGISTRY = createApiHandlerRegistry<PublicHandlerContext, SessionHandlerContext>(
  API_OPERATIONS, API_HANDLER_GROUPS
);

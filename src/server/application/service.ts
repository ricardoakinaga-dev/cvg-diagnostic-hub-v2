import { createFileStoreFromEnv, type FileStore } from "../storage/file-store";
import { createMalwareScannerFromEnv } from "../storage/malware-scanner";
import type { StateStore } from "../domain/models";
import { createArchiveService } from "./archive-service";
import { createHospitalTaskService } from "./hospital-task-service";
import { createHospitalIntakeService } from "./hospital-intake-service";
import { createPlannerSearchService } from "./planner-search-service";
import { createPlannerViewService } from "./planner-view-service";
import { createHospitalServiceService } from "./hospital-service-service";
import { createHospitalResourceService } from "./hospital-resource-service";
import { createHospitalCalendarCommandService } from "./hospital-calendar-command-service";
import { createHospitalCalendarReadService } from "./hospital-calendar-read-service";
import { createHospitalBedCensusService } from "./hospital-bed-census-service";
import { createHospitalCapacityService } from "./hospital-capacity-service";
import { createHospitalCareService } from "./hospital-care-service";
import { createHospitalPlanService } from "./hospital-plan-service";
import { createHospitalChecklistService } from "./hospital-checklist-service";
import { createHospitalRecurrenceService } from "./hospital-recurrence-service";
import { createHospitalShiftService } from "./hospital-shift-service";
import { createHospitalPlannerOptionsService } from "./hospital-planner-options-service";
import { createHospitalDocumentService } from "./hospital-document-service";
import { createHospitalMetricsService } from "./hospital-metrics-service";
import { createHospitalReportService } from "./hospital-report-service";
import { createWorkActivityService } from "./work-activity-service";
import { createWorkNotificationService } from "./work-notification-service";
import { createHospitalTaskCommentService } from "./hospital-task-comment-service";
import { createHospitalTaskAttachmentService } from "./hospital-task-attachment-service";
import { createHospitalInstitutionService } from "./hospital-institution-service";
import { createHospitalInvitationService } from "./hospital-invitation-service";
import { createHospitalTaskArchiveService } from "./hospital-task-archive-service";
import { createHospitalTaskDraftService } from "./hospital-task-draft-service";
import { createHospitalTaskReactionService } from "./hospital-task-reaction-service";
import { createHospitalIntegrationService } from "./hospital-integration-service";
import { createHospitalAiService } from "./hospital-ai-service";
import { createHospitalHisV4Service } from "./hospital-his-v4-service";
import { createDiagnosticPlanningService } from "./diagnostic-planning-service";
import { createDepartmentService } from "./department-service";
import { createAccessGroupService } from "./access-group-service";
import { createExamDefinitionService } from "./exam-definition-service";
import { createDataSubjectService } from "./data-subject-service";
import { createAttachmentService } from "./attachment-service";
import { createAdmissionContextService } from "./admission-context-service";
import { createManagementService } from "./management-service";
import { createReadService } from "./read-service";
import { createRegistryService } from "./registry-service";
import { createRequestService } from "./request-service";
import { createResultService } from "./result-service";
import { createWorkflowService } from "./workflow-service";
import type { ApplicationServiceContext, PatientDiagnosticsAuxiliaryReader } from "./service-context";

export type * from "./service-context";
export type * from "./service-types";

export function createApplicationService(store: StateStore, dependencies: { storage?: FileStore; patientDiagnosticsAuxiliaryReader?: PatientDiagnosticsAuxiliaryReader } = {}) {
  const context: ApplicationServiceContext = {
    store,
    storage: dependencies.storage ?? createFileStoreFromEnv(),
    scanner: createMalwareScannerFromEnv(),
    patientDiagnosticsAuxiliaryReader: dependencies.patientDiagnosticsAuxiliaryReader ?? (({ state }) => ({
      samples: state.samples,
      results: state.results,
      attachments: state.attachments
    }))
  };
  return {
    ...createAccessGroupService(context),
    ...createExamDefinitionService(context),
    ...createDepartmentService(context),
    ...createDiagnosticPlanningService(context),
    ...createPlannerViewService(context),
    ...createHospitalTaskService(context),
    ...createHospitalIntakeService(context),
    ...createPlannerSearchService(context),
    ...createHospitalServiceService(context),
    ...createHospitalResourceService(context),
    ...createHospitalCalendarCommandService(context),
    ...createHospitalCalendarReadService(context),
    ...createHospitalBedCensusService(context),
    ...createHospitalCapacityService(context),
    ...createHospitalCareService(context),
    ...createHospitalPlanService(context),
    ...createHospitalChecklistService(context),
    ...createHospitalRecurrenceService(context),
    ...createHospitalShiftService(context),
    ...createHospitalPlannerOptionsService(context),
    ...createHospitalDocumentService(context),
    ...createHospitalMetricsService(context),
    ...createHospitalReportService(context),
    ...createWorkActivityService(context),
    ...createWorkNotificationService(context),
    ...createHospitalTaskCommentService(context),
    ...createHospitalTaskAttachmentService(context),
    ...createHospitalInstitutionService(context),
    ...createHospitalInvitationService(context),
    ...createHospitalTaskArchiveService(context),
    ...createHospitalTaskDraftService(context),
    ...createHospitalTaskReactionService(context),
    ...createHospitalIntegrationService(context),
    ...createHospitalAiService(context),
    ...createHospitalHisV4Service(context),
    ...createAdmissionContextService(context),
    ...createRequestService(context),
    ...createWorkflowService(context),
    ...createResultService(context),
    ...createAttachmentService(context),
    ...createManagementService(context),
    ...createRegistryService(context),
    ...createReadService(context),
    ...createArchiveService(context),
    ...createDataSubjectService(context)
  };
}

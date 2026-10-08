import { createHash, randomUUID } from "node:crypto";
import { ITEM_STATES, PRIORITIES, ROLES } from "@cvg/contracts";
import type { ItemState, Permission, Priority, RoleCode, WorkflowType } from "@cvg/contracts";
import type { Admission, Attachment, AuditEvent, DiagnosticItem, DiagnosticRequest, DiagnosticService, Notification, Procedure, ProcedureSchedule, ReasonCode, Result, ResultVersion, Sample, StateStore, StoreState, User } from "../domain/models";
import type { SampleLabelView, CommandMeta, NotificationAcknowledgeInput, CreateRequestInput, ReceiveSampleInput, RecollectionInput, ResultDraftInput, ReleaseInput, ReviewInput, AmendInput, ScheduleInput, CancelInput, RejectInput, VoidInput, AttachmentUploadInput, DiagnosticServiceCreateInput, DiagnosticServicePatchInput, ReasonCodeCreateInput, ReasonCodePatchInput, UserRoleUpdateInput, ManagedUserCreateInput, ManagedUserDeactivateInput, ManagedUser, ManagementOverview, DashboardIndicatorKey, DashboardIndicator, DashboardWindow, DashboardView, RequestListFilters, SearchResultType, SearchFilters, SearchResult, TimelineFilters, TimelineResult, RequestView, ResultView, ItemView, SampleCommandResult, ResultDraftCommandResult, ResultReleaseCommandResult, ReviewCommandResult, ItemCommandResult, ProcedureScheduleCommandResult, ProcedureRescheduleCommandResult, ProcedureExecutionCommandResult, AmendCommandResult, VoidCommandResult, PublicAttachment, AttachmentSessionResult, AttachmentFinalizationResult, PatientDiagnosticsResult, PatientWorkspaceItemContext, PatientWorkspaceResultSummary, PatientWorkspaceSampleSummary, PatientWorkspaceAttachmentSummary, ReportView } from "./service-types";
import { canAccessResource, managerCanAccessDepartment, managerDepartmentCodes } from "../security/authorization";
import { ApiError } from "../http/envelope";
import { hashPassword } from "../security/password";
import type { ApplicationServiceContext, PatientDiagnosticsAuxiliaryRead } from "./service-context";
import * as helpers from "./service-common";
import { patientAuditScope, readPatientAuditEvents } from "./audit-read";
import { reprojectRequestForActor } from "./request-projection";
import { accessionPrefixFromEnv, accessionTimeZoneFromEnv, generateAccessionCodes } from "../domain/accession";
import { code128Geometry } from "../domain/barcode-code128";
import { labelDimensionsFromEnv } from "../domain/sample-label";
import { encountersForPatient, findById, itemsForRequest, positionOfId, requestsForPatient } from "../domain/state-index";
const {
  MAX_NOTE_LENGTH,
  MAX_RESULT_NARRATIVE_LENGTH,
  MAX_ATTACHMENT_SIZE,
  DEFAULT_PAGE_SIZE,
  ALLOWED_ATTACHMENT_MIME,
  INDICATOR_DEFINITIONS,
  criticalPolicyIsReady,
  now,
  dashboardTimezone,
  managedUser,
  id,
  stableSerialize,
  hashPayload,
  idempotencyFingerprint,
  requireText,
  operationalManagedRoles,
  canManageUserTarget,
  normalizedEmail,
  validatedTimezone,
  validatedPassword,
  normalizedManagedDepartments,
  revokeUserSessions,
  requireRecentReauthentication,
  requireActiveUser,
  requirePermission,
  isExecutorRole,
  hasServicePatientContext,
  hasManagerRequestContext,
  hasManagerPatientContext,
  requirePatientPermission,
  requireRequestPermission,
  findOrThrow,
  findOrThrowScoped,
  createAudit,
  createOutbox,
  notificationFor,
  withIdempotency,
  saveIdempotency,
  requireIdempotencyKey,
  validatedSlaHours,
  validateServiceDefinition,
  serviceFor,
  requestFor,
  itemFor,
  resultFor,
  procedureFor,
  scheduleWindow,
  hasScheduleConflict,
  activeReason,
  attachmentFor,
  publicAttachment,
  safeAttachmentName,
  assertAttachmentMetadata,
  requireAttachmentOwner,
  attachmentSessionIsExpired,
  attachmentUploadClaimIsActive,
  attachmentStorageKeys,
  detectedMime,
  requestView,
  requestViewForActor,
  canViewRequest,
  canViewItem,
  requireItemPermission,
  requestForAuditEvent,
  auditEventItem,
  auditEventItemIds,
  auditEventDepartmentCode,
  canViewManagementAudit,
  requestForNotification,
  decodeKeysetCursor,
  decodeSearchCursor,
  decodeTimelineCursor,
  decodeRequestCursor,
  decodeAuditCursor,
  encodeKeysetCursor,
  pageSize,
  dateFilter,
  resultView,
  operationalContextFor,
  visibleResultVersions,
  requireCurrentResultRead,
  ensureExpectedVersion,
  calculateDueAt,
  nextRequestState,
  nextActionFor,
  deleteStoredObject,
  releaseUploadClaim,
  transitionItem,
} = helpers;

export function createRequestService({ store, storage, patientDiagnosticsAuxiliaryReader }: ApplicationServiceContext) {
  const service = {
    async createRequest(actor: User, input: CreateRequestInput, meta: CommandMeta & { allowDuplicateOverride?: boolean } = {}): Promise<RequestView> {
      const scope = "POST:/diagnostic-requests";
      return store.transaction(async (originalState) => {
        const currentActor = requireActiveUser(originalState, actor);
        requirePermission(currentActor, "request.create", { patientId: input.patientId, departmentCode: currentActor.departmentCode });
        if (meta.allowDuplicateOverride) requireIdempotencyKey(meta.idempotencyKey);
        if (!input.patientId || !input.encounterId || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 20) {
          throw new ApiError("VALIDATION_ERROR", "Paciente, atendimento e pelo menos um serviço são obrigatórios.", 400);
        }
        const patient = findOrThrow(findById(originalState.patients, input.patientId));
        const encounter = findOrThrow(findById(originalState.encounters, input.encounterId));
        if (encounter.patientId !== patient.id) throw new ApiError("VALIDATION_ERROR", "Atendimento não pertence ao paciente informado.", 400);
        const admission = input.admissionId ? findOrThrow(findById(originalState.admissions, input.admissionId)) : undefined;
        if (admission && admission.encounterId !== encounter.id) throw new ApiError("VALIDATION_ERROR", "Internação não pertence ao atendimento informado.", 400);
        const services = input.items.map((entry) => serviceFor(originalState, entry.serviceId));
        if (currentActor.role === "MANAGER" && services.some((service) => !managerCanAccessDepartment(currentActor, service.departmentCode))) {
          throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);
        }
        // Resource and delegated-department authorization must precede an
        // idempotent replay; a user's scope may have been revoked since the
        // original request was committed.
        const idempotent = withIdempotency<RequestView>(originalState, currentActor.id, scope, meta.idempotencyKey, { input, allowDuplicateOverride: meta.allowDuplicateOverride });
        if (idempotent.found) return { state: originalState, result: reprojectRequestForActor(originalState, currentActor, (idempotent.existing as RequestView).id) };
        const duplicateItems = requestsForPatient(originalState, patient.id)
          .flatMap((request) => itemsForRequest(originalState, request.id))
          .filter((item) =>
            item.status !== "COMPLETED" && item.status !== "CANCELLED" && item.status !== "REJECTED" &&
            input.items.some((requested) => requested.serviceId === item.serviceId))
          .sort((left, right) => positionOfId(originalState.items, left.id) - positionOfId(originalState.items, right.id));
        if (duplicateItems.length > 0 && !meta.allowDuplicateOverride) {
          throw new ApiError("DUPLICATE_WARNING", "Já existe um exame ativo compatível para este paciente.", 409, {
            existingRequestCodes: duplicateItems.map((item) => requestFor(originalState, item.requestId).requestCode)
          });
        }
        const duplicateOverrideReason = meta.allowDuplicateOverride ? requireText(input.overrideReason ?? "", "overrideReason", 500) : undefined;
        if (meta.allowDuplicateOverride) {
          requirePermission(currentActor, "request.duplicate_override", { patientId: patient.id, departmentCode: currentActor.departmentCode });
        }
        const createdAt = now();
        const requestId = id("request");
        const requestCode = `EX-${createdAt.slice(2, 10).replace(/-/g, "")}-${String(originalState.protocolSequence).padStart(4, "0")}`;
        const request: DiagnosticRequest = {
          id: requestId,
          requestCode,
          patientId: patient.id,
          encounterId: encounter.id,
          admissionId: admission?.id,
          requesterId: currentActor.id,
          requestingDepartmentCode: currentActor.departmentCode,
          priority: input.priority,
          aggregateStatus: "REQUESTED",
          itemIds: [],
          createdAt,
          updatedAt: createdAt,
          version: 1
        };
        const baseItems = input.items.map((entry, index) => {
          const service = services[index];
          const itemId = id("item");
          const note = entry.note ? requireText(entry.note, "note", MAX_NOTE_LENGTH) : undefined;
          return {
            id: itemId,
            requestId,
            serviceId: service.id,
            departmentCode: service.departmentCode,
            workflowType: service.workflowType,
            priority: input.priority,
            status: "REQUESTED" as const,
            note,
            requestedAt: createdAt,
            slaStartedAt: createdAt,
            dueAt: calculateDueAt(createdAt, service, input.priority),
            slaPolicyVersion: service.version,
            version: 1
          } satisfies DiagnosticItem;
        });
        // D8: every item whose service needs a sample gets a system-generated
        // EXPECTED sample so the label can be printed before collection. Items
        // sharing the same catalog sampleType share one tube.
        const groups: Array<{ sampleType: string; itemIds: string[] }> = [];
        baseItems.forEach((item, index) => {
          const service = services[index];
          if (!service.requiresSample) return;
          const catalogType = service.sampleType?.trim();
          const group = catalogType ? groups.find((entry) => entry.sampleType === catalogType) : undefined;
          if (group) group.itemIds.push(item.id);
          else groups.push({ sampleType: catalogType || "A definir", itemIds: [item.id] });
        });
        const accessionCodes = groups.length ? generateAccessionCodes(originalState, createdAt, accessionPrefixFromEnv(), groups.length, accessionTimeZoneFromEnv()) : [];
        const samples: Sample[] = groups.map((group, index) => ({ id: id("sample"), requestId, accessionCode: accessionCodes[index], sampleType: group.sampleType, status: "EXPECTED", itemIds: group.itemIds, version: 1 }));
        const sampleByItem = new Map(samples.flatMap((sample) => sample.itemIds.map((itemId) => [itemId, sample.id] as const)));
        const items: DiagnosticItem[] = baseItems.map((item) => ({ ...item, ...(sampleByItem.has(item.id) ? { currentSampleId: sampleByItem.get(item.id) } : {}) }));
        const nextRequest = { ...request, itemIds: items.map((item) => item.id) };
        const correlationId = meta.correlationId ?? id("corr");
        const audits = [
          createAudit("DiagnosticRequestCreated", currentActor.id, "DiagnosticRequest", request.id, correlationId, undefined, "REQUESTED", { requestCode, ...(duplicateOverrideReason ? { duplicateOverride: true, overrideReason: duplicateOverrideReason } : {}) }),
          ...items.map((item) => createAudit("DiagnosticItemRequested", currentActor.id, "DiagnosticRequestItem", item.id, correlationId, undefined, item.status, { serviceCode: serviceFor(originalState, item.serviceId).code })),
          ...samples.map((sample) => createAudit("SampleExpected", currentActor.id, "Sample", sample.id, correlationId, undefined, "EXPECTED", { accessionCode: sample.accessionCode, itemIds: sample.itemIds.join(",") }))
        ];
        const nextState: StoreState = {
          ...originalState,
          protocolSequence: originalState.protocolSequence + 1,
          requests: [...originalState.requests, nextRequest],
          items: [...originalState.items, ...items],
          samples: [...originalState.samples, ...samples],
          auditEvents: [...originalState.auditEvents, ...audits],
          outbox: [...originalState.outbox, createOutbox("DiagnosticRequestCreated", "DiagnosticRequest", request.id, correlationId, { requestCode, ...(samples.length ? { samples: samples.map((sample) => ({ id: sample.id, accessionCode: sample.accessionCode, itemIds: sample.itemIds })) } : {}) })]
        };
        const response = requestView(nextState, nextRequest);
        return { state: saveIdempotency(nextState, currentActor.id, scope, meta.idempotencyKey, response, { input, allowDuplicateOverride: meta.allowDuplicateOverride }), result: response };
      });
    },

    async getRequest(actor: User, requestId: string): Promise<RequestView> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const request = findOrThrowScoped(findById(state.requests, requestId));
      requireRequestPermission(state, currentActor, "request.view", request);
      return requestViewForActor(state, currentActor, request);
    },

    async getPatientDiagnostics(actor: User, patientId: string, filters: { limit?: number; cursor?: string } = {}): Promise<PatientDiagnosticsResult> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const limit = pageSize(filters.limit);
      const cursor = decodeRequestCursor(filters.cursor);
      // Authorize the opaque identifier before resolving it. The public 404
      // envelope must not reveal whether a patient exists outside the actor's
      // scope. A scoped-but-stale identifier is normalized to the same denial
      // for the same reason.
      requirePatientPermission(state, currentActor, "patient.view", patientId);
      requirePatientPermission(state, currentActor, "diagnostic.timeline.view", patientId);
      const patient = findById(state.patients, patientId);
      if (!patient) throw new ApiError("SCOPE_DENIED", "Você não tem acesso a este recurso.", 404);
      const asOf = now();
      const requests = requestsForPatient(state, patient.id)
        .filter((request) => canViewRequest(state, currentActor, request))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
      const afterCursor = cursor ? requests.filter((request) => request.createdAt < cursor.createdAt || (request.createdAt === cursor.createdAt && request.id > cursor.id)) : requests;
      const pageRequests = afterCursor.slice(0, limit);
      const page = pageRequests.map((request) => requestViewForActor(state, currentActor, request));
      const visibleRequestIds = new Set(requests.map((request) => request.id));
      const visibleItemIds = new Set(requests.flatMap((request) => request.itemIds).filter((itemId) => canViewItem(state, currentActor, itemFor(state, itemId))));
      let auxiliaryRead: PatientDiagnosticsAuxiliaryRead = { samples: [], results: [], attachments: [] };
      let dataQuality: PatientDiagnosticsResult["workspace"]["dataQuality"] = { status: "FRESH", asOf };
      try {
        auxiliaryRead = await patientDiagnosticsAuxiliaryReader({
          state,
          actor: currentActor,
          patientId: patient.id,
          requestIds: visibleRequestIds,
          itemIds: visibleItemIds
        });
      } catch {
        dataQuality = {
          status: "DEGRADED",
          asOf,
          note: "A leitura auxiliar de amostras, resultados e anexos está indisponível; os itens autorizados continuam visíveis."
        };
      }
      const scopedEncounterIds = isExecutorRole(currentActor) || currentActor.role === "MANAGER"
        ? new Set(requests.map((request) => request.encounterId))
        : undefined;
      const encounters = encountersForPatient(state, patient.id)
        .filter((encounter) => !scopedEncounterIds || scopedEncounterIds.has(encounter.id))
        .map((encounter) => ({ ...encounter }));
      const encounterIds = new Set(encounters.map((encounter) => encounter.id));
      const admissions = state.admissions
        .filter((admission) => encounterIds.has(admission.encounterId) && canAccessResource(currentActor, "admission.view", { patientId: patient.id, departmentCode: admission.departmentCode }))
        .map((admission) => ({ ...admission }));
      const activeEncounter = [...encounters]
        .sort((left, right) => Number(right.status === "OPEN") - Number(left.status === "OPEN") || right.openedAt.localeCompare(left.openedAt) || left.id.localeCompare(right.id))[0];
      const currentAdmission = activeEncounter
        ? admissions
          .filter((admission) => admission.encounterId === activeEncounter.id)
          .sort((left, right) => Number(!left.dischargedAt) - Number(!right.dischargedAt) || (right.updatedAt ?? right.admittedAt).localeCompare(left.updatedAt ?? left.admittedAt) || left.id.localeCompare(right.id))[0]
        : undefined;
      const responsibleLabel = currentAdmission?.responsibleUserId && canAccessResource(currentActor, "patient.view", {
        patientId: patient.id,
        departmentCode: currentAdmission.departmentCode
      })
        ? findById(state.users, currentAdmission.responsibleUserId)?.displayName ?? null
        : null;
      const visibleItems = requests.flatMap((request) => request.itemIds
        .map((itemId) => itemFor(state, itemId))
        .filter((item) => canViewItem(state, currentActor, item)));
      const workspaceContextFor = (item: DiagnosticItem, request: DiagnosticRequest): PatientWorkspaceItemContext => {
        const service = serviceFor(state, item.serviceId);
        const operationalContext = operationalContextFor(item, service, asOf, request.requestingDepartmentCode);
        const linkedSamples = auxiliaryRead.samples
          .filter((sample) => sample.requestId === request.id && sample.itemIds.includes(item.id))
          .sort((left, right) => {
            const leftTime = Date.parse(left.receivedAt ?? left.collectedAt ?? "") || 0;
            const rightTime = Date.parse(right.receivedAt ?? right.collectedAt ?? "") || 0;
            return rightTime - leftTime || right.id.localeCompare(left.id);
          });
        const selectedSample = item.currentSampleId
          ? linkedSamples.find((sample) => sample.id === item.currentSampleId) ?? linkedSamples[0]
          : linkedSamples[0];
        const sample: PatientWorkspaceSampleSummary | null = selectedSample
          ? {
              id: selectedSample.id,
              requestId: selectedSample.requestId,
              accessionCode: selectedSample.accessionCode,
              sampleType: selectedSample.sampleType,
              status: selectedSample.status,
              ...(selectedSample.collectedAt ? { collectedAt: selectedSample.collectedAt } : {}),
              ...(selectedSample.receivedAt ? { receivedAt: selectedSample.receivedAt } : {})
            }
          : null;
        let result: PatientWorkspaceResultSummary | null = null;
        const currentResult = item.currentResultId ? auxiliaryRead.results.find((entry) => entry.id === item.currentResultId && entry.itemId === item.id) : undefined;
        if (currentResult) {
          try {
            const resultViewForActor = resultView(state, currentResult);
            if (currentResult.lifecycleStatus === "RELEASED" && resultViewForActor.version.status === "RELEASED") {
              requireCurrentResultRead(currentActor, resultViewForActor);
              requirePermission(currentActor, "attachment.view", {
                patientId: resultViewForActor.request.patientId,
                departmentCode: resultViewForActor.service.departmentCode,
                serviceCode: resultViewForActor.service.code
              });
              result = {
                id: currentResult.id,
                versionId: resultViewForActor.version.id,
                status: "RELEASED",
                ...(resultViewForActor.version.releasedAt ? { releasedAt: resultViewForActor.version.releasedAt } : {}),
                needsReReview: currentResult.needsReReview
              };
            }
          } catch {
            result = null;
          }
        }
        const attachments: PatientWorkspaceAttachmentSummary[] = result
          ? auxiliaryRead.attachments
            .filter((attachment) => attachment.resultVersionId === result!.versionId && attachment.scanStatus === "CLEAN" && attachment.uploadStatus === "FINALIZED")
            .map((attachment) => ({
              id: attachment.id,
              resultVersionId: attachment.resultVersionId,
              safeName: attachment.safeName,
              detectedMime: attachment.detectedMime,
              sizeBytes: attachment.sizeBytes,
              scanStatus: "CLEAN",
              uploadStatus: "FINALIZED",
              createdAt: attachment.createdAt
            }))
          : [];
        return { operationalContext, sample, result, attachments };
      };
      const allContexts = visibleItems.map((item) => workspaceContextFor(item, requestFor(state, item.requestId)));
      const nextActions = requests
        .flatMap((request) => request.itemIds.map((itemId) => ({ request, item: itemFor(state, itemId) })))
        .filter(({ item }) => canViewItem(state, currentActor, item))
        .filter(({ item }) => !["COMPLETED", "CANCELLED", "REJECTED", "RESULT_VOIDED"].includes(item.status))
        .map(({ request, item }) => {
          const service = serviceFor(state, item.serviceId);
          return {
            id: item.id,
            requestId: request.id,
            requestCode: request.requestCode,
            itemId: item.id,
            label: nextActionFor(item, service),
            deepLink: `/requests/${request.id}`,
            status: item.status,
            priority: item.priority,
            dueAt: item.dueAt,
            departmentCode: item.departmentCode
          };
        })
        .sort((left, right) => left.dueAt.localeCompare(right.dueAt) || left.id.localeCompare(right.id));
      const events = await readPatientAuditEvents(store, patientAuditScope(state, patient.id, visibleRequestIds, visibleItemIds));
      const last = pageRequests.at(-1);
      const nextCursor = last && pageRequests.length < afterCursor.length ? encodeKeysetCursor({ createdAt: last.createdAt, id: last.id }) : undefined;
      // The workspace carries its own per-item sample context; the request-level samples list is not repeated.
      const items = page.map(({ samples: _samples, ...request }) => ({
        ...request,
        items: request.items.map((item) => ({
          ...item,
          workspaceContext: workspaceContextFor(item, request)
        }))
      }));
      return {
        patient: { ...patient },
        encounters,
        admissions,
        items,
        events,
        nextActions,
        workspace: {
          asOf,
          dataQuality,
          currentContext: {
            encounterId: activeEncounter?.id ?? null,
            admissionId: currentAdmission?.id ?? null,
            departmentCode: currentAdmission?.departmentCode ?? null,
            ward: currentAdmission?.ward ?? null,
            bed: currentAdmission?.bed ?? null,
            responsibleLabel
          },
          summary: {
            requestCount: requests.length,
            itemCount: visibleItems.length,
            activeItemCount: visibleItems.filter((item) => !["COMPLETED", "CANCELLED", "REJECTED", "RESULT_VOIDED"].includes(item.status)).length,
            availableResultCount: allContexts.filter((context) => context.result !== null).length,
            sampleCount: allContexts.filter((context) => context.sample !== null).length,
            attachmentCount: allContexts.reduce((count, context) => count + context.attachments.length, 0)
          }
        },
        nextCursor,
        limit,
        total: requests.length
      };
    },

    async getSampleLabel(actor: User, sampleId: string): Promise<SampleLabelView> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const sample = findOrThrowScoped(findById(state.samples, sampleId));
      const linkedItems = sample.itemIds.map((itemId) => itemFor(state, itemId));
      // Same scoped read as getDiagnosticItem: an unscoped sample is a 404.
      const visibleItems = linkedItems.filter((item) => canViewItem(state, currentActor, item));
      requireItemPermission(state, currentActor, "item.view", visibleItems[0] ?? linkedItems[0]);
      const request = requestFor(state, sample.requestId);
      const patient = findOrThrow(findById(state.patients, request.patientId));
      const encounter = findOrThrow(findById(state.encounters, request.encounterId));
      const { widthMm, heightMm } = labelDimensionsFromEnv();
      return {
        sample: { id: sample.id, accessionCode: sample.accessionCode, sampleType: sample.sampleType, status: sample.status },
        request: { id: request.id, requestCode: request.requestCode, priority: request.priority },
        patient: { id: patient.id, displayName: patient.displayName, species: patient.species, externalId: patient.externalId },
        services: visibleItems.map((item) => serviceFor(state, item.serviceId)).map((entry) => ({ code: entry.code, name: entry.name })),
        encounter: { externalId: encounter.externalId },
        requestedAt: request.createdAt,
        label: { widthMm, heightMm, barcode: { symbology: "code128", ...code128Geometry(sample.accessionCode) } }
      };
    },

    async getItem(actor: User, itemId: string): Promise<ItemView> {
      const state = await store.readState();
      const currentActor = requireActiveUser(state, actor);
      const item = findOrThrowScoped(findById(state.items, itemId));
      const request = requestFor(state, item.requestId);
      const service = serviceFor(state, item.serviceId);
      requireItemPermission(state, currentActor, "item.view", item);
      const patient = findOrThrow(findById(state.patients, request.patientId));
      return { item, request: requestViewForActor(state, currentActor, request), patient, service };
    },

  };
  return service;
}

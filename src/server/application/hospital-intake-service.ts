import type { HospitalIntake, HospitalIntakeOptions, HospitalIntakePage, HospitalIntakeView } from "@cvg/contracts";
import type { StoreState, User } from "../domain/models";
import type { ApplicationServiceContext } from "./service-context";
import type { HospitalIntakeCreateInput, HospitalIntakeFilters, HospitalIntakeTriageInput } from "./hospital-task-types";
import { ApiError } from "../http/envelope";
import { hospitalIntakeCreateSchema, hospitalIntakeFiltersSchema, hospitalIntakeOptionsSchema, hospitalIntakeTriageSchema } from "../http/hospital-task-schemas";
import { createAudit, createOutbox, ensureExpectedVersion, findOrThrowScoped, id, now, requireActiveUser, requireIdempotencyKey, requirePermission, requireRequestPermission, requireText, saveIdempotency, withIdempotency } from "./service-common";
import { canAccessHospitalTask, requireHospitalTaskAccess, taskDate, validateNewTaskContext, validateTaskDates } from "./hospital-task-policy";
import { buildHospitalTask, existingTask, pagePlannerObjects, recordTaskChange, requireOpenTask, validateTaskBody } from "./hospital-task-common";
import { approvedIntakeRejectionReason, intakeRejectionPolicyFromEnvironment } from "./hospital-intake-rejection-policy";

const terminal = new Set(["ACCEPTED", "REJECTED", "DUPLICATE"]);
function intakeView(state: StoreState, actor: User, intake: HospitalIntake): HospitalIntakeView {
  const permissions = canAccessHospitalTask(state, actor, "hospital_intake.view", intake) ? ["hospital_intake.view" as const] : [];
  const result: HospitalIntakeView = { ...intake, permissions };
  if (!terminal.has(intake.state) && canAccessHospitalTask(state, actor, "hospital_intake.triage", intake)) result.permissions.push("hospital_intake.triage");
  if (intake.destinationTaskId && !state.hospitalTasks.some((task) => task.id === intake.destinationTaskId && canAccessHospitalTask(state, actor, "hospital_task.view", task))) delete result.destinationTaskId;
  if (intake.duplicateOfIntakeId && !state.hospitalIntakes.some((entry) => entry.id === intake.duplicateOfIntakeId && canAccessHospitalTask(state, actor, "hospital_intake.view", entry))) delete result.duplicateOfIntakeId;
  if (intake.sourceRequestId) {
    const request = state.requests.find((entry) => entry.id === intake.sourceRequestId);
    try { if (!request) throw new Error("missing"); requireRequestPermission(state, actor, "request.view", request); }
    catch { delete result.sourceRequestId; delete result.destinationRequestId; }
  }
  return result;
}

export function createHospitalIntakeService({ store }: ApplicationServiceContext) {
  return {
    async getHospitalIntakeOptions(actor: User, filters: { departmentCode?: string } = {}): Promise<HospitalIntakeOptions> {
      validateTaskBody(hospitalIntakeOptionsSchema, filters);
      const state = await store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "hospital_intake.triage", {});
      if (filters.departmentCode) requireHospitalTaskAccess(state, current, "hospital_intake.triage", { departmentCode: filters.departmentCode });
      const options = intakeRejectionPolicyFromEnvironment();
      if (!options.rejectionPolicy) return options;
      const departmentCodes = options.rejectionPolicy.departmentCodes.filter((code) => (!filters.departmentCode || code === filters.departmentCode) && state.departments.some((department) => department.code === code && department.active) && canAccessHospitalTask(state, current, "hospital_intake.triage", { departmentCode: code }));
      return departmentCodes.length ? { ...options, rejectionPolicy: { ...options.rejectionPolicy, departmentCodes } } : { rejectionPolicyStatus: "OFF" };
    },
    async listHospitalIntakes(actor: User, filters: HospitalIntakeFilters = {}): Promise<HospitalIntakePage> {
      validateTaskBody(hospitalIntakeFiltersSchema, filters); validateTaskDates(taskDate(filters.from), taskDate(filters.to));
      const state = await store.readState(); const current = requireActiveUser(state, actor); requirePermission(current, "hospital_intake.view", {});
      const query = filters.query?.toLocaleLowerCase("pt-BR");
      const rows = state.hospitalIntakes.filter((entry) => canAccessHospitalTask(state, current, "hospital_intake.view", entry) && (!filters.departmentCode || entry.departmentCode === filters.departmentCode) && (!filters.patientId || entry.patientId === filters.patientId) && (!filters.state || entry.state === filters.state) && (!filters.from || entry.createdAt >= taskDate(filters.from)!) && (!filters.to || entry.createdAt <= taskDate(filters.to)!) && (!query || `${entry.title} ${entry.description ?? ""} ${entry.sourceLabel ?? ""}`.toLocaleLowerCase("pt-BR").includes(query)));
      const page = pagePlannerObjects(rows, filters, (entry) => ({ createdAt: entry.createdAt, id: entry.id }));
      return { ...page, items: page.items.map((entry) => intakeView(state, current, entry)) };
    },
    async createHospitalIntake(actor: User, input: HospitalIntakeCreateInput): Promise<HospitalIntakeView> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); requireIdempotencyKey(input.idempotencyKey); validateTaskBody(hospitalIntakeCreateSchema, input);
        const departmentCode = requireText(input.departmentCode, "setor", 60).toUpperCase();
        let patientId = input.patientId; let encounterId = input.encounterId;
        if (input.source === "DIAGNOSTIC_REQUEST") {
          const request = findOrThrowScoped(state.requests.find((entry) => entry.id === input.sourceRequestId));
          requireRequestPermission(state, current, "request.view", request);
          if (input.typeId || patientId && patientId !== request.patientId || encounterId && encounterId !== request.encounterId) throw new ApiError("VALIDATION_ERROR", "A demanda diagnóstica mantém o contexto de sua solicitação original.", 400);
          patientId = request.patientId; encounterId = request.encounterId;
        } else if (input.sourceRequestId) throw new ApiError("VALIDATION_ERROR", "A origem manual não recebe uma solicitação diagnóstica.", 400);
        const context = { departmentCode, patientId, encounterId };
        requireHospitalTaskAccess(state, current, "hospital_intake.create", context);
        const scope = "POST:/hospital-intakes"; const replay = withIdempotency<HospitalIntakeView>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) {
          const previous = findOrThrowScoped(state.hospitalIntakes.find((entry) => entry.id === replay.existing!.id));
          requireHospitalTaskAccess(state, current, "hospital_intake.create", previous);
          return { state, result: intakeView(state, current, previous) };
        }
        const type = input.source === "MANUAL" ? findOrThrowScoped(state.hospitalTaskTypes.find((entry) => entry.id === (input.typeId ?? "hospital-task-type-routine") && entry.active)) : undefined;
        validateNewTaskContext(state, context, type?.careContextRequired ?? false);
        if (input.sourceRequestId && state.hospitalIntakes.some((entry) => entry.sourceRequestId === input.sourceRequestId && entry.departmentCode === departmentCode && !["REJECTED", "DUPLICATE"].includes(entry.state))) throw new ApiError("CONFLICT", "Esta solicitação já tem uma demanda neste setor.", 409);
        const timestamp = now();
        const intake: HospitalIntake = { id: id("hospital-intake"), title: requireText(input.title, "título", 200), description: input.description?.trim() || undefined, typeId: type?.id, ...context, priority: input.priority, source: input.source, sourceRequestId: input.sourceRequestId, sourceLabel: input.sourceLabel?.trim(), state: "RECEIVED", submittedBy: current.id, version: 1, createdAt: timestamp, updatedAt: timestamp };
        const correlation = input.correlationId ?? id("corr");
        const next = { ...state, hospitalIntakes: [...state.hospitalIntakes, intake], auditEvents: [...state.auditEvents, createAudit("HospitalIntakeReceived", current.id, "HospitalIntake", intake.id, correlation, undefined, "RECEIVED", { departmentCode, patientId: patientId ?? null, source: intake.source, sourceRequestId: intake.sourceRequestId ?? null, version: 1 })], outbox: [...state.outbox, createOutbox("HospitalIntakeReceived", "HospitalIntake", intake.id, correlation, { intakeId: intake.id, version: 1 })] };
        const result = intakeView(next, current, intake);
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    },
    async triageHospitalIntake(actor: User, intakeId: string, input: HospitalIntakeTriageInput): Promise<HospitalIntakeView> {
      return store.transaction((state) => {
        const current = requireActiveUser(state, actor); requireIdempotencyKey(input.idempotencyKey);
        const previous = findOrThrowScoped(state.hospitalIntakes.find((entry) => entry.id === intakeId));
        requireHospitalTaskAccess(state, current, "hospital_intake.triage", previous);
        const scope = `POST:/hospital-intakes/${intakeId}/triage`; const replay = withIdempotency<HospitalIntakeView>(state, current.id, scope, input.idempotencyKey, { input });
        if (replay.found) return { state, result: intakeView(state, current, previous) };
        validateTaskBody(hospitalIntakeTriageSchema, input); ensureExpectedVersion(previous.version, input.expectedVersion);
        if (terminal.has(previous.state)) throw new ApiError("INVALID_STATE_TRANSITION", "A triagem desta demanda já foi encerrada.", 409);
        if (input.decision !== "ACCEPT" && (input.destinationTaskId || input.destinationDepartmentCode)) throw new ApiError("VALIDATION_ERROR", "Somente o aceite define uma atividade de destino.", 400);
        if (input.decision !== "DUPLICATE" && input.duplicateOfIntakeId) throw new ApiError("VALIDATION_ERROR", "Informe duplicidade apenas na decisão correspondente.", 400);
        const reasonPolicy = approvedIntakeRejectionReason(previous.departmentCode, input.reasonCode, input.reasonPolicyVersion);
        const reason = input.decision === "ACCEPT" ? input.reason?.trim() : requireText(input.reason?.trim() || reasonPolicy?.label || "", "motivo da triagem", 500);
        const destinationDepartmentCode = input.destinationDepartmentCode?.trim().toUpperCase() ?? previous.departmentCode;
        let next = state; let destinationTaskId: string | undefined; let destinationRequestId: string | undefined;
        if (input.decision === "ACCEPT") {
          requireHospitalTaskAccess(state, current, "hospital_intake.triage", { ...previous, departmentCode: destinationDepartmentCode });
          if (previous.source === "DIAGNOSTIC_REQUEST") {
            if (input.destinationTaskId) throw new ApiError("VALIDATION_ERROR", "Demanda diagnóstica vincula sua solicitação original, não uma tarefa substituta.", 400);
            const request = findOrThrowScoped(state.requests.find((entry) => entry.id === previous.sourceRequestId));
            requireRequestPermission(state, current, "request.view", request);
            destinationRequestId = request.id;
          } else if (input.destinationTaskId) {
            const target = existingTask(state, current, input.destinationTaskId, "hospital_task.view"); requireOpenTask(target);
            if (target.departmentCode !== destinationDepartmentCode || target.patientId !== previous.patientId || target.encounterId !== previous.encounterId || target.typeId !== previous.typeId) throw new ApiError("VALIDATION_ERROR", "A atividade de destino deve corresponder ao tipo, setor e contexto da demanda.", 400);
            destinationTaskId = target.id;
          } else {
            const task = buildHospitalTask(state, current, { title: previous.title, description: previous.description, typeId: previous.typeId!, departmentCode: destinationDepartmentCode, patientId: previous.patientId, encounterId: previous.encounterId, priority: previous.priority });
            next = recordTaskChange(state, current, undefined, task, "HospitalTaskCreatedFromIntake", input.correlationId, { intakeId }); destinationTaskId = task.id;
          }
        } else if (input.decision === "DUPLICATE") {
          const duplicate = findOrThrowScoped(state.hospitalIntakes.find((entry) => entry.id === input.duplicateOfIntakeId));
          requireHospitalTaskAccess(state, current, "hospital_intake.view", duplicate);
          if (duplicate.id === previous.id || duplicate.patientId !== previous.patientId || duplicate.encounterId !== previous.encounterId || duplicate.source !== previous.source) throw new ApiError("VALIDATION_ERROR", "Selecione outra demanda do mesmo contexto e origem.", 400);
          const visited = new Set([previous.id]); let cursor: HospitalIntake | undefined = duplicate;
          while (cursor) { if (visited.has(cursor.id)) throw new ApiError("CONFLICT", "A duplicidade criaria um ciclo.", 409); visited.add(cursor.id); cursor = state.hospitalIntakes.find((entry) => entry.id === cursor!.duplicateOfIntakeId); }
        }
        const timestamp = now(); const newState = input.decision === "ACCEPT" ? "ACCEPTED" : input.decision === "REJECT" ? "REJECTED" : input.decision === "DEFER" ? "DEFERRED" : "DUPLICATE";
        const updated: HospitalIntake = { ...previous, state: newState, decisionBy: current.id, decisionAt: timestamp, reason, reasonPolicy, destinationTaskId, destinationRequestId, duplicateOfIntakeId: input.decision === "DUPLICATE" ? input.duplicateOfIntakeId : undefined, version: previous.version + 1, updatedAt: timestamp };
        const correlation = input.correlationId ?? id("corr");
        next = { ...next, hospitalIntakes: next.hospitalIntakes.map((entry) => entry.id === intakeId ? updated : entry), auditEvents: [...next.auditEvents, createAudit("HospitalIntakeTriaged", current.id, "HospitalIntake", intakeId, correlation, previous.state, updated.state, { reason: reason ?? null, reasonCode: reasonPolicy?.code ?? null, reasonPolicyVersion: reasonPolicy?.policyVersion ?? null, reasonApprovalReference: reasonPolicy?.approvalReference ?? null, reasonApprovedAt: reasonPolicy?.approvedAt ?? null, destinationDepartmentCode, destinationTaskId: destinationTaskId ?? null, destinationRequestId: destinationRequestId ?? null, duplicateOfIntakeId: updated.duplicateOfIntakeId ?? null, previousVersion: previous.version, version: updated.version, clinicalStateChanged: false })], outbox: [...next.outbox, createOutbox("HospitalIntakeTriaged", "HospitalIntake", intakeId, correlation, { intakeId, version: updated.version })] };
        const result = intakeView(next, current, updated);
        return { state: saveIdempotency(next, current.id, scope, input.idempotencyKey, result, { input }), result };
      });
    }
  };
}

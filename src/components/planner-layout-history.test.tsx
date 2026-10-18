/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AuditEvent } from "@cvg/contracts";
import { PlannerTaskLayouts } from "./planner-task-layouts";
import { PlannerTaskHistory } from "./planner-task-history";
import { PlannerInlineEdit } from "./planner-inline-edit";
import { PLANNER_DEFAULT_DISPLAY } from "./planner-model";
import * as api from "./api-client";
import { plannerUser, taskView } from "./planner.test-helpers";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(["DEPARTMENT", "RESPONSIBLE", "TYPE", "PHASE"] as const)("groups authorized activities by %s while preserving patient context and unknown historical labels", (groupBy) => {
  const entry = taskView({ responsibleUserId: "unavailable", status: "REMOVED_STATE", departmentCode: "HISTORICAL", plannedStartAt: "2026-10-11T12:00:00Z", plannedEndAt: "2026-10-11T13:00:00Z" }); entry.patient = { id: "patient", displayName: "Paciente autorizado", externalId: "HIS-1", ownerLabel: "Tutor", species: "Canino" };
  render(<PlannerTaskLayouts items={[entry]} display={{ ...PLANNER_DEFAULT_DISPLAY, groupBy, columns: [...PLANNER_DEFAULT_DISPLAY.columns, "plannedEnd", "updatedAt"] }} departmentNames={{}} />);
  expect(screen.getByRole("link", { name: "Paciente autorizado · HIS-1" })).toHaveAttribute("href", "/patients/patient/diagnostics"); expect(screen.getByText(/tutor Tutor/)).toBeInTheDocument(); expect(screen.getAllByText("Responsável atribuído").length).toBeGreaterThan(0); expect(screen.getAllByText("HISTORICAL").length).toBeGreaterThan(0); expect(screen.getAllByText("Pendente").length).toBeGreaterThan(0);
});

it("shows all four board phases including empty lanes and uses the current authorized responsible name", () => {
  const entry = taskView({ responsibleUserId: plannerUser.id, phase: "IN_PROGRESS" }); render(<PlannerTaskLayouts items={[entry]} display={{ ...PLANNER_DEFAULT_DISPLAY, layout: "BOARD", groupBy: "NONE" }} departmentNames={{ INPATIENT: "Internação" }} />);
  expect(within(screen.getByRole("region", { name: "Em execução" })).getByRole("link", { name: entry.task.title })).toBeInTheDocument(); expect(screen.getAllByText("Nenhuma atividade neste grupo.")).toHaveLength(3); expect(screen.getByText(plannerUser.displayName)).toBeInTheDocument();
});

it("keeps table reads available without editing capabilities and renders each configured column faithfully", () => {
  const entry = taskView({ status: "HISTORICAL_STATE" }); render(<PlannerTaskLayouts items={[entry]} display={{ ...PLANNER_DEFAULT_DISPLAY, layout: "TABLE", columns: ["title", "department", "responsible", "type", "phase", "priority", "plannedStart", "plannedEnd", "updatedAt"] }} departmentNames={{ INPATIENT: "Internação" }} />);
  expect(screen.getAllByRole("columnheader")).toHaveLength(9); expect(screen.queryByRole("columnheader", { name: "Edição autorizada" })).not.toBeInTheDocument(); expect(screen.getByRole("cell", { name: "Pendente" })).toBeInTheDocument(); expect(screen.getByRole("cell", { name: "Sem responsável" })).toBeInTheDocument(); expect(screen.getByRole("link", { name: entry.task.title })).toHaveAttribute("href", "/planner/tasks/task-1");
});

it("does not expose table editing for archived, draft, readonly or withdrawn contextual grants", () => {
  const mock = vi.spyOn(api, "apiFetch");
  for (const view of [taskView({ archivedAt: "2026-10-11T12:00:00Z" }), taskView({ isDraft: true }), taskView({}, [])]) {
    const rendered = render(<PlannerInlineEdit user={plannerUser} view={view} onChanged={vi.fn()} />); expect(screen.queryByRole("form")).not.toBeInTheDocument(); rendered.unmount();
  }
  render(<PlannerInlineEdit user={plannerUser} view={taskView()} disabled onChanged={vi.fn()} />); expect(screen.queryByRole("form")).not.toBeInTheDocument(); expect(mock).not.toHaveBeenCalled();
});

it("renders actual completion, cancellation and contextual history without disclosing arbitrary audit metadata", async () => {
  const event = (id: string, eventType: string, metadata: AuditEvent["metadata"]): AuditEvent => ({ id, entityType: "HospitalTask", entityId: "task", eventType, occurredAt: "2026-10-11T12:00:00Z", metadata });
  const events = [event("complete", "HospitalTaskTransitioned", { command: "COMPLETE", note: "Referência declarada", patientId: "hidden-patient" }), event("cancel", "HospitalTaskTransitioned", { command: "CANCEL", reason: "Operação duplicada" }), event("other", "HospitalTaskTransitioned", { command: "CONFIGURED" }), event("context", "HospitalTaskContextUpdated", { reason: 4, note: 2 }), event("future", "NewServerEvent", { raw: "private metadata" })];
  vi.spyOn(api, "apiFetchWithMeta").mockResolvedValue({ data: events, meta: { correlationId: "synthetic", requestId: "synthetic", total: 5 } }); render(<PlannerTaskHistory userId="viewer" taskId="task" />);
  await screen.findByText("Atividade concluída"); expect(screen.getByText("Atividade cancelada")).toBeInTheDocument(); expect(screen.getByText("Estado da atividade atualizado")).toBeInTheDocument(); expect(screen.getByText("Vínculo assistencial atualizado")).toBeInTheDocument(); expect(screen.getByText("Atividade atualizada")).toBeInTheDocument(); expect(screen.getByText("Nota: Referência declarada")).toBeInTheDocument(); expect(screen.getByText("Motivo: Operação duplicada")).toBeInTheDocument(); expect(document.body.innerHTML).not.toContain("hidden-patient"); expect(document.body.innerHTML).not.toContain("private metadata");
});

it("keeps previous history marked partial after a temporary read failure and recovers an empty current history", async () => {
  let fail = false; let empty = false; vi.spyOn(api, "apiFetchWithMeta").mockImplementation(async () => { if (fail) throw new api.ApiClientError(503, {}); return { data: empty ? [] : [{ id: "event", entityType: "HospitalTask", entityId: "task", eventType: "HospitalTaskCreated", occurredAt: "2026-10-11T12:00:00Z", metadata: {} }], meta: { correlationId: "synthetic", requestId: "synthetic" } }; });
  render(<PlannerTaskHistory userId="viewer" taskId="task" />); await screen.findByText("Atividade criada"); fail = true; act(() => window.dispatchEvent(new Event("cvg:realtime-updated"))); await screen.findByText("Leitura parcial"); expect(screen.getByText("Atividade criada")).toBeInTheDocument(); fail = false; empty = true; fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" })); await screen.findByText("Nenhum evento registrado"); await waitFor(() => expect(screen.queryByText("Leitura parcial")).not.toBeInTheDocument());
});

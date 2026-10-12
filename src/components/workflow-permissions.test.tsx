/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Permission, SessionRole } from "@cvg/contracts";
import { WorkflowAction } from "./workflow-action";
import { WorkflowPermissionsProvider } from "./workflow-permissions";
import { StatePill } from "./work-items/properties";
import { BoardLayout } from "./work-items/layouts";
import { DEFAULT_DISPLAY, groupItems, type WorkItem } from "./work-items/model";
import * as apiClient from "./api-client";

vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
const item: WorkItem = { id: "item", requestId: "request", requestCode: "EX-1", status: "RECEIVED", priority: "ROUTINE", workflowType: "LABORATORY", departmentCode: "LABORATORY", version: 4, currentSampleId: "sample", createdAt: "2026-10-11T12:00:00Z", dueAt: "2026-10-11T14:00:00Z", overdue: false, service: { id: "service", code: "HEM", name: "Hemograma" }, patient: { id: "patient", displayName: "Thor", species: "Canino", externalId: "HIS-1" } };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each(["SUPERADMIN", "MANAGER", "ADMIN", "VETERINARIAN", "INPATIENT_TEAM", "LAB_TECH", "RADIOLOGY_TEAM", "ULTRASOUND_TEAM", "VIEWER"] satisfies SessionRole[])("fails closed for %s when its effective grants are empty", (role) => {
  const api = vi.spyOn(apiClient, "apiFetch");
  render(<WorkflowAction item={item} role={role} permissions={[]} initialAction="START_PROCESSING" />);
  expect(screen.queryByRole("button", { name: "Iniciar processamento" })).not.toBeInTheDocument();
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
  expect(api).not.toHaveBeenCalled();
});

it("does not fetch sample or reason metadata for an unauthorized initial action", () => {
  const api = vi.spyOn(apiClient, "apiFetch");
  render(<WorkflowAction item={item} role="SUPERADMIN" initialAction="REQUEST_RECOLLECTION" />);
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
  expect(api).not.toHaveBeenCalled();
});

it("removes the open state menu and command form when effective permissions are revoked", () => {
  const api = vi.spyOn(apiClient, "apiFetch");
  const onMove = vi.fn();
  const content = (permissions: readonly Permission[]) => <WorkflowPermissionsProvider permissions={permissions}><StatePill item={item} role="MANAGER" onMove={onMove} /><WorkflowAction item={item} role="MANAGER" /></WorkflowPermissionsProvider>;
  const view = render(content(["sample.process"]));
  fireEvent.click(screen.getByRole("button", { name: "Estado: Amostra recebida. Mudar estado" }));
  expect(screen.getByRole("menuitem", { name: "Em execução" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Iniciar processamento" }));
  expect(screen.getByRole("form", { name: "Iniciar processamento" })).toBeInTheDocument();
  view.rerender(content([]));
  expect(screen.getByRole("button", { name: "Estado: Amostra recebida" })).toBeDisabled();
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
  expect(onMove).not.toHaveBeenCalled();
  expect(api).not.toHaveBeenCalled();
});

it("prevents drag and drop without an effective grant while keeping the card readable", () => {
  const onMove = vi.fn();
  render(<BoardLayout groups={groupItems([item], "status", true, { departments: ["LABORATORY"] })} display={{ ...DEFAULT_DISPLAY, layout: "board" }} role="SUPERADMIN" busy={false} canCreate={false} onPeek={vi.fn()} onMove={onMove} onAction={vi.fn()} onCreate={vi.fn()} quickAdd={{ departments: [], onCreated: vi.fn() }} />);
  expect(screen.getByRole("listitem")).toHaveAttribute("draggable", "false");
  fireEvent.dragStart(screen.getByRole("listitem"), { dataTransfer: { setData: vi.fn() } });
  fireEvent.drop(screen.getByRole("region", { name: "Em execução" }));
  expect(onMove).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Abrir Hemograma — Thor" })).toBeInTheDocument();
});

it("keeps a new imaging draft readable without exposing release to a create-only grant", async () => {
  const api = vi.spyOn(apiClient, "apiFetch").mockResolvedValue({ result: { id: "draft", version: 1 } });
  render(<WorkflowAction item={{ ...item, status: "AWAITING_REPORT", workflowType: "RADIOLOGY", currentSampleId: undefined }} role="MANAGER" permissions={["result.draft.create"]} />);
  fireEvent.click(screen.getByRole("button", { name: "Registrar resultado" }));
  fireEvent.change(screen.getByLabelText("Resultado"), { target: { value: "Sem alterações." } });
  fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
  await waitFor(() => expect(screen.getByRole("link", { name: "Abrir draft" })).toHaveAttribute("href", "/results/draft"));
  expect(screen.queryByRole("button", { name: "Liberar resultado" })).not.toBeInTheDocument();
  expect(api.mock.calls.some(([path]) => path.endsWith("/release"))).toBe(false);
});

it("retains result reading when the clinician's review grant is absent", () => {
  render(<WorkflowAction item={{ ...item, status: "RESULT_AVAILABLE", currentResultId: "result" }} role="VETERINARIAN" permissions={[]} />);
  expect(screen.getByRole("link", { name: "Abrir resultado" })).toHaveAttribute("href", "/results/result");
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

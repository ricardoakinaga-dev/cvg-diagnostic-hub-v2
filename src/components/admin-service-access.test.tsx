/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticService, ManagedUser, SessionUser } from "@cvg/contracts";
import { UserCreateForm, UserRow } from "./admin-users";
import * as api from "./api-client";

const creator: SessionUser = { id: "admin", email: "admin@cvg.local", displayName: "Admin", role: "ADMIN", departmentCode: "LABORATORY", timezone: "America/Sao_Paulo" };
const hemogram: DiagnosticService = { id: "exam", code: "HEMOGRAM", name: "Hemograma", category: "LABORATORY", departmentCode: "LABORATORY", workflowType: "LABORATORY", requiresSample: true, requiresSchedule: false, allowsAttachment: false, resultSchema: "NARRATIVE", active: true, version: 1, slaHours: { ROUTINE: 24, URGENT: 4, EMERGENCY: 1 } };
const user: ManagedUser = { id: "technician", email: "tech@cvg.local", displayName: "Technician", role: "LAB_TECH", departmentCode: "LABORATORY", serviceCodes: ["HEMOGRAM"], active: true, timezone: "America/Sao_Paulo", createdAt: "2026-10-11T00:00:00Z", version: 1 };

function mockApi() {
  return vi.spyOn(api, "apiFetch").mockImplementation(async <T,>(_path: string, options?: RequestInit) => ({ ...user, ...JSON.parse(options?.body as string), version: 2 }) as T);
}
function createForm() {
  render(<UserCreateForm creator={creator} onCreated={vi.fn()} services={[hemogram]} />);
  fireEvent.change(screen.getByLabelText("Nome completo"), { target: { value: "Novo colaborador" } });
  fireEvent.change(screen.getByLabelText("E-mail institucional"), { target: { value: "new@cvg.local" } });
  fireEvent.click(screen.getByText(/^Exames autorizados/));
}
async function submitted(mock: ReturnType<typeof mockApi>) {
  await waitFor(() => expect(mock).toHaveBeenCalledTimes(1));
  return JSON.parse(mock.mock.calls[0][1]?.body as string);
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("administrator chooses exam access explicitly", () => {
  it("starts at NONE and submitting an untouched form does not imply all exams", async () => {
    const mock = mockApi(); createForm();
    expect(screen.getByLabelText("Acesso aos exames")).toHaveValue("NONE");
    expect(screen.queryByLabelText("Hemograma")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Criar acesso" }));
    expect(await submitted(mock)).toMatchObject({ serviceAccessPolicy: { mode: "NONE", includeFuture: false } });
  });

  it("keeps an explicitly empty selection instead of omitting it", async () => {
    const mock = mockApi(); createForm();
    fireEvent.change(screen.getByLabelText("Acesso aos exames"), { target: { value: "SELECTED" } });
    fireEvent.click(screen.getByRole("button", { name: "Criar acesso" }));
    expect(await submitted(mock)).toMatchObject({ serviceCodes: [], serviceAccessPolicy: { mode: "SELECTED", includeFuture: false } });
  });

  it.each([false, true])("all current exams include future exams only when chosen (%s)", async (includeFuture) => {
    const mock = mockApi(); createForm();
    fireEvent.change(screen.getByLabelText("Acesso aos exames"), { target: { value: "ALL_CURRENT" } });
    const futureChoice = screen.getByRole("checkbox", { name: /Incluir automaticamente exames futuros/ });
    expect(futureChoice).not.toBeChecked();
    if (includeFuture) fireEvent.click(futureChoice);
    fireEvent.click(screen.getByRole("button", { name: "Criar acesso" }));
    const payload = await submitted(mock);
    expect(payload.serviceAccessPolicy).toEqual({ mode: "ALL_CURRENT", includeFuture });
    expect(payload).not.toHaveProperty("serviceCodes");
  });

  it("removes future consent when changing to a selection", async () => {
    const mock = mockApi(); createForm();
    fireEvent.change(screen.getByLabelText("Acesso aos exames"), { target: { value: "ALL_CURRENT" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Incluir automaticamente exames futuros/ }));
    fireEvent.change(screen.getByLabelText("Acesso aos exames"), { target: { value: "SELECTED" } });
    fireEvent.click(screen.getByLabelText("Hemograma"));
    expect(screen.queryByRole("checkbox", { name: /Incluir automaticamente exames futuros/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Criar acesso" }));
    expect(await submitted(mock)).toMatchObject({ serviceCodes: ["HEMOGRAM"], serviceAccessPolicy: { mode: "SELECTED", includeFuture: false } });
  });

  it("presents a full legacy list as a selection without guessing future consent", async () => {
    const mock = mockApi();
    render(<UserRow user={user} technical viewerId="admin" onChanged={vi.fn()} services={[hemogram]} />);
    fireEvent.click(screen.getByText(/^Exames autorizados/));
    expect(screen.getByLabelText("Acesso aos exames")).toHaveValue("SELECTED");
    expect(screen.getByLabelText("Hemograma")).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: `Salvar ${user.email}` }));
    expect(await submitted(mock)).toMatchObject({ serviceCodes: ["HEMOGRAM"], serviceAccessPolicy: { mode: "SELECTED", includeFuture: false } });
  });

  it("changing department resets old future consent until a new scope is chosen", async () => {
    const mock = mockApi();
    render(<UserRow user={{ ...user, serviceAccessPolicy: { mode: "ALL_CURRENT", includeFuture: true } }} technical viewerId="admin" onChanged={vi.fn()} services={[hemogram]} departments={["LABORATORY", "RADIOLOGY"].map((code) => ({ id: code, code, name: code, active: true, type: "DIAGNOSTIC", memberUserIds: [], version: 1, createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z" }))} />);
    fireEvent.change(screen.getByLabelText("Setor"), { target: { value: "RADIOLOGY" } });
    fireEvent.click(screen.getByText(/^Exames autorizados/));
    expect(screen.getByLabelText("Acesso aos exames")).toHaveValue("NONE");
    fireEvent.click(screen.getByRole("button", { name: `Salvar ${user.email}` }));
    const payload = await submitted(mock);
    expect(payload).toMatchObject({ departmentCode: "RADIOLOGY", serviceAccessPolicy: { mode: "NONE", includeFuture: false } });
    expect(payload).not.toHaveProperty("serviceCodes");
  });
});

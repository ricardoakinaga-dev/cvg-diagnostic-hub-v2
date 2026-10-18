/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Department, HospitalInstitutionSettings, HospitalInstitutionView, Permission, SessionUser } from "@cvg/contracts";
import { HospitalInstitutionConsole } from "./hospital-institution-console";
import * as api from "./api-client";

const permissions: Permission[] = ["institution.manage", "department.capabilities.manage"];
const admin: SessionUser = { id: "institution-admin", email: "admin@example.invalid", displayName: "Admin sintético", role: "ADMIN", departmentCode: "IT", timezone: "America/Sao_Paulo", permissions };
const settings: HospitalInstitutionSettings = { id: "hospital-institution", name: "Hospital sintético", timezone: "America/Sao_Paulo", departmentCapabilities: [{ departmentCode: "LAB", disabledNewWork: ["TASKS"], archived: false }], version: 8, updatedAt: "2026-10-11T12:00:00Z", updatedBy: admin.id };
const departments: Department[] = [{ id: "dept-lab", code: "LAB", name: "Laboratório", type: "DIAGNOSTIC", memberUserIds: [], active: true, version: 1, createdAt: settings.updatedAt, updatedAt: settings.updatedAt }, { id: "dept-care", code: "INPATIENT", name: "Internação", type: "CLINICAL", memberUserIds: [], active: true, version: 1, createdAt: settings.updatedAt, updatedAt: settings.updatedAt }];
function mockApi(override?: (path: string, init?: RequestInit) => unknown, identity = admin, view: HospitalInstitutionView = { settings, permissions }) {
  return vi.spyOn(api, "apiFetch").mockImplementation(async <T,>(path: string, init?: RequestInit) => {
    const custom = override?.(path, init); if (custom !== undefined) return await custom as T;
    if (path === "/session/me") return { user: identity } as T;
    if (path === "/departments") return departments as T;
    if (path === "/hospital-institution") return (init?.method ? { ...settings, ...JSON.parse(init.body as string), version: settings.version + 1 } : view) as T;
    throw new Error(`Unexpected institution API ${path}`);
  });
}
function writes(mock: ReturnType<typeof mockApi>) { return mock.mock.calls.filter(([, init]) => init?.method); }
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("institution and sector capability configuration", () => {
  it("initializes a real institution using body version zero and no fabricated capabilities", async () => {
    const mock = mockApi(undefined, admin, { settings: null, permissions }); render(<HospitalInstitutionConsole />);
    fireEvent.change(await screen.findByLabelText("Nome da instituição"), { target: { value: "  Hospital novo  " } }); fireEvent.submit(screen.getByRole("form", { name: "Configurar instituição" })); await waitFor(() => expect(writes(mock)).toHaveLength(1));
    expect(JSON.parse(writes(mock)[0][1]!.body as string)).toEqual({ name: "Hospital novo", timezone: "America/Sao_Paulo", expectedVersion: 0 }); expect(new Headers(writes(mock)[0][1]!.headers).has("if-match")).toBe(false);
    expect(writes(mock).some(([path]) => path.includes("/capabilities"))).toBe(false);
  });

  it("saves name and timezone with the current revision, then uses the returned revision for independent sector choices", async () => {
    const mock = mockApi((path, init) => { if (path.endsWith("/capabilities")) return { ...settings, departmentCapabilities: [{ departmentCode: "LAB", disabledNewWork: ["CALENDAR"], archived: true }], version: 10 }; }); render(<HospitalInstitutionConsole />);
    fireEvent.change(await screen.findByLabelText("Nome da instituição"), { target: { value: "  Identidade revisada  " } }); fireEvent.change(screen.getByLabelText("Fuso institucional IANA"), { target: { value: "America/Manaus" } }); fireEvent.submit(screen.getByRole("form", { name: "Configurar instituição" }));
    await waitFor(() => expect(screen.getByLabelText("Nome da instituição")).toHaveValue("Identidade revisada"));
    const form = await screen.findByRole("form", { name: "Capacidades de Laboratório" }); expect(within(form).getByLabelText("Atividades")).toBeChecked();
    fireEvent.click(within(form).getByLabelText("Atividades")); fireEvent.click(within(form).getByLabelText("Calendário")); fireEvent.click(within(form).getByLabelText("Arquivar espaço para novas atividades")); fireEvent.click(within(form).getByLabelText("Arquivar espaço para novas atividades")); fireEvent.click(within(form).getByLabelText("Arquivar espaço para novas atividades")); fireEvent.submit(form);
    await waitFor(() => expect(writes(mock)).toHaveLength(2)); expect(JSON.parse(writes(mock)[0][1]!.body as string)).toEqual({ name: "Identidade revisada", timezone: "America/Manaus", expectedVersion: 8 }); expect(JSON.parse(writes(mock)[1][1]!.body as string)).toEqual({ disabledNewWork: ["CALENDAR"], archived: true, expectedVersion: 9 });
    await waitFor(() => expect(within(screen.getByRole("form", { name: "Capacidades de Laboratório" })).getByLabelText("Calendário")).toBeChecked());
    const other = screen.getByRole("form", { name: "Capacidades de Internação" }); expect(within(other).getByLabelText("Calendário")).not.toBeChecked(); expect(within(other).getByLabelText("Arquivar espaço para novas atividades")).not.toBeChecked();
  });

  it.each([{ session: permissions, server: [] as Permission[] }, { session: [] as Permission[], server: permissions }])("requires both session and contextual grants for institution and capability mutations ($session/$server)", async ({ session, server }) => {
    const mock = mockApi(undefined, { ...admin, permissions: session }, { settings, permissions: server }); render(<HospitalInstitutionConsole />); const form = await screen.findByRole("form", { name: "Capacidades de Laboratório" });
    expect(screen.queryByRole("form", { name: "Configurar instituição" })).not.toBeInTheDocument(); expect(within(form).getByRole("button", { name: "Salvar capacidades de Laboratório" })).toBeDisabled();
    fireEvent.submit(form); expect(writes(mock)).toHaveLength(0);
  });

  it("retains local institution edits after a rejected timezone and retries the same version without inventing success", async () => {
    let reject = true; const mock = mockApi((path, init) => { if (path === "/hospital-institution" && init?.method && reject) throw new api.ApiClientError(422, { error: { code: "VALIDATION_ERROR" } }); }); render(<HospitalInstitutionConsole />);
    fireEvent.change(await screen.findByLabelText("Fuso institucional IANA"), { target: { value: "America/Manaus" } }); fireEvent.change(screen.getByLabelText("Nome da instituição"), { target: { value: "Nome em edição" } }); const form = screen.getByRole("form", { name: "Configurar instituição" }); fireEvent.submit(form); await screen.findByRole("alert"); expect(screen.getByLabelText("Nome da instituição")).toHaveValue("Nome em edição"); expect(screen.getByLabelText("Fuso institucional IANA")).toHaveValue("America/Manaus");
    reject = false; fireEvent.submit(form); await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument()); expect(writes(mock)).toHaveLength(2); expect(writes(mock)[0][1]!.body).toBe(writes(mock)[1][1]!.body); expect(writes(mock)[0][1]!.headers).toEqual(writes(mock)[1][1]!.headers);
  });

  it("keeps the selected capability changes after a version conflict and resubmits only that sector", async () => {
    let reject = true; const mock = mockApi((path) => { if (path.endsWith("/capabilities")) { if (reject) throw new api.ApiClientError(409, { error: { code: "STALE_VERSION" } }); return { ...settings, version: 9, departmentCapabilities: [{ departmentCode: "INPATIENT", disabledNewWork: ["CARE"], archived: false }] }; } }); render(<HospitalInstitutionConsole />);
    const form = await screen.findByRole("form", { name: "Capacidades de Internação" }); fireEvent.click(within(form).getByLabelText("Cuidado")); fireEvent.submit(form); await within(form).findByRole("alert"); expect(within(form).getByLabelText("Cuidado")).toBeChecked(); expect(within(form).getByLabelText("Arquivar espaço para novas atividades")).not.toBeChecked();
    reject = false; fireEvent.submit(form); await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument()); expect(writes(mock)).toHaveLength(2); expect(writes(mock)[0][0]).toBe("/hospital-departments/INPATIENT/capabilities"); expect(JSON.parse(writes(mock)[0][1]!.body as string)).toEqual({ disabledNewWork: ["CARE"], archived: false, expectedVersion: 8 });
  });

  it("retries an unavailable initial read and removes cached mutation controls when the read access is revoked", async () => {
    let failure = 503; const mock = mockApi((path, init) => { if (path === "/hospital-institution" && !init?.method && failure) throw new api.ApiClientError(failure, {}); }); render(<HospitalInstitutionConsole />); await screen.findByText("Instituição indisponível"); expect(screen.queryByRole("form")).not.toBeInTheDocument();
    failure = 0; fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" })); await screen.findByLabelText("Nome da instituição");
    failure = 503; act(() => window.dispatchEvent(new Event("cvg:realtime-updated"))); await screen.findByText("Leitura parcial"); const form = screen.getByRole("form", { name: "Configurar instituição" }); expect(within(form).getByRole("button", { name: "Salvar instituição" })).toBeDisabled(); fireEvent.submit(form); expect(writes(mock)).toHaveLength(0);
    failure = 403; fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" })); await screen.findByText("Instituição indisponível"); expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });

  it("retries directory failures without changing institution settings or manufacturing sector grants", async () => {
    let failure = true; const mock = mockApi((path) => { if (path === "/departments" && failure) throw new api.ApiClientError(503, {}); }); render(<HospitalInstitutionConsole />); await screen.findByText("Leitura parcial"); expect(screen.queryByRole("form", { name: "Capacidades de Laboratório" })).not.toBeInTheDocument();
    failure = false; fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" })); await screen.findByRole("form", { name: "Capacidades de Laboratório" }); expect(writes(mock)).toHaveLength(0);
  });

  it("does not load institution data while identity is unavailable", async () => {
    const mock = mockApi((path) => { if (path === "/session/me") throw new api.ApiClientError(401, {}); }); render(<HospitalInstitutionConsole />); await screen.findByText("Instituição indisponível"); expect(mock.mock.calls.some(([path]) => path === "/hospital-institution")).toBe(false);
  });
});

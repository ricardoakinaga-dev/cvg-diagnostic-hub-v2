/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminConsole } from "./admin-console";
import * as apiClient from "./api-client";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>,
}));

describe("AdminConsole", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("edits versioned catalog data and keeps external policy gates explicit", async () => {
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockImplementation((path, init) => {
      if (path.startsWith("/diagnostic-services") && init?.method === "PATCH") return Promise.resolve({ id: "service-1", name: "Hemograma revisado", active: false, version: 2 }) as never;
      if (path.startsWith("/diagnostic-services")) return Promise.resolve([{ id: "service-1", code: "HEMOGRAM", name: "Hemograma", departmentCode: "LABORATORY", workflowType: "LABORATORY", active: true, version: 1, slaHours: { ROUTINE: 8, URGENT: 4, EMERGENCY: 2 } }]) as never;
      if (path === "/reason-codes") return Promise.resolve([{ id: "reason-1", type: "RECOLLECTION", code: "HEMOLYZED", label: "Amostra hemolisada", active: true, version: 1 }]) as never;
      if (path === "/users") return Promise.resolve([{ id: "user-vet", email: "vet@cvg.local", displayName: "Dra. Marina Costa", role: "VETERINARIAN", departmentCode: "INPATIENT", active: true, timezone: "America/Sao_Paulo", version: 1 }]) as never;
      if (path === "/users/user-vet/roles" && init?.method === "POST") return Promise.resolve({ id: "user-vet", email: "vet@cvg.local", displayName: "Dra. Marina Costa", role: "MANAGER", departmentCode: "INPATIENT", active: true, timezone: "America/Sao_Paulo", version: 2 }) as never;
      return Promise.reject(new Error("unexpected request")) as never;
    });

    render(<AdminConsole />);

    expect(await screen.findByRole("heading", { name: /Administração/ })).toBeInTheDocument();
    expect(screen.getByText(/política de resultado crítico/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Salvar Hemograma" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/diagnostic-services/service-1", expect.objectContaining({ method: "PATCH" })));
  });

  it("exposes versioned role administration in the same controlled console", async () => {
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockImplementation((path, init) => {
      if (path === "/diagnostic-services?includeInactive=true") return Promise.resolve([]) as never;
      if (path === "/reason-codes") return Promise.resolve([]) as never;
      if (path === "/users") return Promise.resolve([{ id: "user-vet", email: "vet@cvg.local", displayName: "Dra. Marina Costa", role: "VETERINARIAN", departmentCode: "INPATIENT", active: true, timezone: "America/Sao_Paulo", version: 1 }]) as never;
      if (path === "/session/reauth" && init?.method === "POST") return Promise.resolve({ user: { displayName: "Admin" }, reauthenticatedAt: new Date().toISOString() }) as never;
      if (path === "/users/user-vet/roles" && init?.method === "POST") return Promise.resolve({ id: "user-vet", role: "MANAGER", departmentCode: "INPATIENT", active: true, version: 2 }) as never;
      return Promise.reject(new Error("unexpected request")) as never;
    });

    render(<AdminConsole />);

    expect(await screen.findByText("Dra. Marina Costa")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Motivo da alteração"), { target: { value: "Atualizar acesso operacional" } });
    fireEvent.change(screen.getByLabelText("Senha para reautenticar"), { target: { value: "admin-password" } });
    fireEvent.click(screen.getByLabelText("Confirmo esta alteração de acesso"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar vet@cvg.local" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/users/user-vet/roles", expect.objectContaining({ method: "POST" })));
  });

  it("shows an explicit permission-denied state when both administration resources are out of scope", async () => {
    vi.spyOn(apiClient, "apiFetch").mockRejectedValue(new apiClient.ApiClientError(404, { error: { code: "SCOPE_DENIED" } }));

    render(<AdminConsole />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Administração fora do seu escopo");
    expect(screen.getByText("Seu perfil não pode consultar nem alterar o catálogo institucional.")).toBeInTheDocument();
  });

  it("covers controlled creation and reason lifecycle forms without bypassing reauthentication", async () => {
    const service = { id: "service-1", code: "HEMOGRAM", name: "Hemograma", category: "LABORATORY", departmentCode: "LABORATORY", workflowType: "LABORATORY", requiresSample: true, requiresSchedule: false, allowsAttachment: false, resultSchema: "NARRATIVE", active: true, version: 1, slaHours: { ROUTINE: 8, URGENT: 4, EMERGENCY: 2 } };
    const reason = { id: "reason-1", type: "RECOLLECTION", code: "HEMOLYZED", label: "Amostra hemolisada", active: true, version: 1 };
    const user = { id: "user-vet", email: "vet@cvg.local", displayName: "Dra. Marina Costa", role: "VETERINARIAN", departmentCode: "INPATIENT", active: true, timezone: "America/Sao_Paulo", version: 1 };
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockImplementation((path, init) => {
      if (path === "/diagnostic-services" && init?.method === "POST") return Promise.resolve({ ...service, id: "service-new" }) as never;
      if (path === "/reason-codes" && init?.method === "POST") return Promise.resolve({ ...reason, id: "reason-new" }) as never;
      if (path === "/reason-codes/reason-1" && init?.method === "PATCH") return Promise.resolve(reason) as never;
      if (path === "/session/reauth") return Promise.resolve({ user }) as never;
      if (path === "/users" && init?.method === "POST") return Promise.resolve({ ...user, id: "user-new" }) as never;
      if (path === "/diagnostic-services?includeInactive=true") return Promise.resolve([service]) as never;
      if (path === "/reason-codes") return Promise.resolve([reason]) as never;
      if (path === "/users") return Promise.resolve([user]) as never;
      if (path === "/audit-events?limit=20") return Promise.resolve([]) as never;
      if (path === "/session/me") return Promise.resolve({ user: { role: "ADMIN" } }) as never;
      return Promise.reject(new Error(`unexpected request: ${path}`)) as never;
    });

    render(<AdminConsole />);
    expect(await screen.findByRole("heading", { name: /Administração/ })).toBeInTheDocument();

    const serviceCreate = screen.getByText("Adicionar serviço").parentElement as HTMLElement;
    fireEvent.click(screen.getByText("Adicionar serviço"));
    fireEvent.change(within(serviceCreate).getByRole("textbox", { name: /Código/ }), { target: { value: "xray" } });
    fireEvent.change(within(serviceCreate).getByLabelText("Nome"), { target: { value: "RX de tórax" } });
    fireEvent.change(within(serviceCreate).getByLabelText("Categoria"), { target: { value: "IMAGING" } });
    fireEvent.change(within(serviceCreate).getByLabelText("Workflow"), { target: { value: "RADIOLOGY" } });
    fireEvent.change(within(serviceCreate).getByLabelText("Setor"), { target: { value: "radiology" } });
    fireEvent.click(within(serviceCreate).getByLabelText("Exige agenda"));
    fireEvent.click(within(serviceCreate).getByLabelText("Aceita anexo"));
    fireEvent.change(within(serviceCreate).getByLabelText("Modelo de resultado"), { target: { value: "NUMERIC_PANEL" } });
    fireEvent.change(within(serviceCreate).getByLabelText("SLA rotina (h)"), { target: { value: "10" } });
    fireEvent.change(within(serviceCreate).getByLabelText("SLA urgente (h)"), { target: { value: "5" } });
    fireEvent.change(within(serviceCreate).getByLabelText("SLA emergência (h)"), { target: { value: "3" } });
    fireEvent.click(within(serviceCreate).getByRole("button", { name: "Criar serviço" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/diagnostic-services", expect.objectContaining({ method: "POST" })));

    const reasonCreate = screen.getByText("Adicionar motivo").parentElement as HTMLElement;
    fireEvent.click(screen.getByText("Adicionar motivo"));
    fireEvent.change(within(reasonCreate).getByLabelText("Tipo"), { target: { value: "REJECT" } });
    fireEvent.change(within(reasonCreate).getByLabelText("Código"), { target: { value: "broken" } });
    fireEvent.change(within(reasonCreate).getByLabelText("Descrição"), { target: { value: "Amostra comprometida" } });
    fireEvent.click(within(reasonCreate).getByRole("button", { name: "Criar motivo" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/reason-codes", expect.objectContaining({ method: "POST" })));

    fireEvent.change(screen.getAllByLabelText("Descrição", { selector: "input" }).at(-1)!, { target: { value: "Amostra comprometida revisada" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar HEMOLYZED" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/reason-codes/reason-1", expect.objectContaining({ method: "PATCH" })));

    const serviceRow = screen.getByRole("button", { name: "Salvar Hemograma" }).closest("form") as HTMLElement;
    fireEvent.change(within(serviceRow).getByLabelText("Nome"), { target: { value: "Hemograma atualizado" } });
    fireEvent.change(within(serviceRow).getByLabelText("Categoria"), { target: { value: "IMAGING" } });
    fireEvent.change(within(serviceRow).getByLabelText("Workflow"), { target: { value: "ULTRASOUND" } });
    fireEvent.change(within(serviceRow).getByLabelText("Setor"), { target: { value: "ultrasound" } });
    fireEvent.click(within(serviceRow).getByLabelText("Exige amostra"));
    fireEvent.click(within(serviceRow).getByLabelText("Exige agenda"));
    fireEvent.click(within(serviceRow).getByLabelText("Aceita anexo"));
    fireEvent.change(within(serviceRow).getByLabelText("Modelo de resultado"), { target: { value: "NUMERIC_PANEL" } });
    fireEvent.change(within(serviceRow).getByLabelText("SLA rotina (h)"), { target: { value: "12" } });
    fireEvent.change(within(serviceRow).getByLabelText("SLA urgente (h)"), { target: { value: "6" } });
    fireEvent.change(within(serviceRow).getByLabelText("SLA emergência (h)"), { target: { value: "4" } });
    fireEvent.click(within(serviceRow).getByLabelText("Disponível no catálogo"));
    fireEvent.click(within(serviceRow).getByRole("button", { name: "Salvar Hemograma" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/diagnostic-services/service-1", expect.objectContaining({ method: "PATCH" })));

    const userCreate = screen.getByText("Adicionar colaborador").parentElement as HTMLElement;
    fireEvent.click(screen.getByText("Adicionar colaborador"));
    fireEvent.change(within(userCreate).getByLabelText("Nome completo"), { target: { value: "Gestora" } });
    fireEvent.change(within(userCreate).getByLabelText("E-mail institucional"), { target: { value: "gestora@cvg.local" } });
    fireEvent.change(within(userCreate).getByLabelText("Role"), { target: { value: "MANAGER" } });
    fireEvent.change(within(userCreate).getByLabelText("Setor"), { target: { value: "INPATIENT" } });
    fireEvent.change(within(userCreate).getByPlaceholderText("LABORATORY, RADIOLOGY, ULTRASOUND"), { target: { value: "laboratory, radiology, laboratory" } });
    fireEvent.change(within(userCreate).getByLabelText(/Senha inicial/), { target: { value: "StrongInitialPassword1" } });
    fireEvent.change(within(userCreate).getByLabelText("Fuso horário"), { target: { value: "UTC" } });
    fireEvent.change(within(userCreate).getByLabelText("Motivo da criação"), { target: { value: "Provisionamento operacional" } });
    fireEvent.change(within(userCreate).getByLabelText("Senha do gestor para confirmar"), { target: { value: "AdminPassword1" } });
    fireEvent.click(within(userCreate).getByLabelText("Confirmo a criação deste acesso"));
    fireEvent.click(within(userCreate).getByRole("button", { name: "Criar acesso" }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/users", expect.objectContaining({ method: "POST" })));
    const createCall = apiFetchMock.mock.calls.find(([path, init]) => path === "/users" && init?.method === "POST");
    expect(JSON.parse(createCall?.[1]?.body as string)).toMatchObject({ role: "MANAGER", managedDepartmentCodes: ["LABORATORY", "RADIOLOGY"] });

    const userRow = screen.getByRole("button", { name: "Salvar vet@cvg.local" }).closest("form") as HTMLElement;
    fireEvent.change(within(userRow).getByLabelText("Role"), { target: { value: "MANAGER" } });
    fireEvent.change(within(userRow).getByLabelText("Setor"), { target: { value: "laboratory" } });
    fireEvent.change(within(userRow).getByPlaceholderText("LABORATORY, RADIOLOGY, ULTRASOUND"), { target: { value: "laboratory, ultrasound" } });
    fireEvent.click(within(userRow).getByLabelText("Acesso operacional ativo"));
    fireEvent.change(within(userRow).getByLabelText("Motivo da alteração"), { target: { value: "Desativação solicitada" } });
    fireEvent.change(within(userRow).getByLabelText("Senha para reautenticar"), { target: { value: "AdminPassword1" } });
    fireEvent.click(within(userRow).getByLabelText("Confirmo esta alteração de acesso"));
    fireEvent.click(within(userRow).getByRole("button", { name: "Desativar acesso" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/users/user-vet", expect.objectContaining({ method: "DELETE" })));
  });
});

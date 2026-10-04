/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PatientList } from "./patient-list";
import * as apiClient from "./api-client";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>
}));

const patient = { id: "patient-1", displayName: "Thor", species: "Canino", breed: "Labrador", sex: "Macho", externalId: "HIS-THOR", ownerLabel: "Ana", active: true };

describe("PatientList", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads scoped patients and opens the creation dialog for an allowed actor", async () => {
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockImplementation((path, init) => {
      if (path === "/session/me") return Promise.resolve({ user: { role: "VETERINARIAN" } }) as never;
      if (path === "/patients" && init?.method === "POST") return Promise.resolve({ patient, encounter: { id: "encounter-1" } }) as never;
      return Promise.resolve([patient]) as never;
    });

    render(<PatientList />);

    expect(await screen.findByRole("link", { name: /Thor/ })).toHaveAttribute("href", "/patients/patient-1/diagnostics");
    fireEvent.change(screen.getByRole("textbox", { name: "Buscar pacientes" }), { target: { value: "thor" } });
    fireEvent.click(screen.getByRole("button", { name: /Novo paciente/ }));
    expect(screen.getByRole("dialog", { name: "Cadastrar paciente" })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Ex.: Amora"), { target: { value: "Amora" } });
    fireEvent.change(screen.getByPlaceholderText("Ex.: Canino"), { target: { value: "Canino" } });
    fireEvent.change(screen.getByPlaceholderText("Nome para identificação no atendimento"), { target: { value: "Joana" } });
    fireEvent.click(screen.getByRole("button", { name: /Confirmar cadastro de paciente/ }));

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/patients", expect.objectContaining({ method: "POST" })));
    const createCall = apiFetchMock.mock.calls.find(([path, init]) => path === "/patients" && init?.method === "POST");
    expect(JSON.parse(createCall?.[1]?.body as string)).toMatchObject({ displayName: "Amora", species: "Canino", ownerLabel: "Joana", breed: "Não informado", sex: "Não informado", encounterType: "OUTPATIENT" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Cadastrar paciente" })).not.toBeInTheDocument());
  });

  it("closes the scoped creation dialog without creating a record", async () => {
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/session/me") return Promise.resolve({ user: { role: "INPATIENT_TEAM" } }) as never;
      return Promise.resolve([patient]) as never;
    });

    render(<PatientList />);
    fireEvent.click(await screen.findByRole("button", { name: /Novo paciente/ }));
    fireEvent.click(screen.getByRole("button", { name: "Fechar cadastro de paciente" }));

    expect(screen.queryByRole("dialog", { name: "Cadastrar paciente" })).not.toBeInTheDocument();
  });

  it("keeps an empty state and denies creation when the session is out of scope", async () => {
    vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/session/me") return Promise.resolve({ user: { role: "VIEWER" } }) as never;
      return Promise.resolve([]) as never;
    });

    render(<PatientList />);

    expect(await screen.findByText("Nenhum paciente atribuído")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Novo paciente/ })).not.toBeInTheDocument();
  });

  it("keeps the newest search result when an older query resolves later", async () => {
    const pending: Array<{ path: string; resolve: (value: unknown) => void }> = [];
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/session/me") return Promise.resolve({ user: { role: "VIEWER" } }) as never;
      return new Promise((resolve) => { pending.push({ path, resolve }); }) as never;
    });

    render(<PatientList />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/patients?q="));
    fireEvent.change(screen.getByRole("textbox", { name: "Buscar pacientes" }), { target: { value: "thor" } });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/patients?q=thor"));

    await act(async () => {
      pending.find(({ path }) => path === "/patients?q=thor")?.resolve([{ ...patient, displayName: "Mel" }]);
    });
    expect(await screen.findByRole("link", { name: /Mel/ })).toBeInTheDocument();

    await act(async () => {
      pending.find(({ path }) => path === "/patients?q=")?.resolve([patient]);
    });
    expect(screen.getByRole("link", { name: /Mel/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Thor/ })).not.toBeInTheDocument();
  });
});

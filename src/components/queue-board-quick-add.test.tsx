/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueueBoardQuickAdd } from "./queue-board-quick-add";
import * as apiClient from "./api-client";

const patients = [{ id: "p1", displayName: "Thor", species: "Canino", externalId: "P1", active: true }, { id: "p2", displayName: "Mel", species: "Felino", externalId: "P2", active: true }];
const services = [{ id: "s1", name: "Hemograma", departmentCode: "LABORATORY", active: true }, { id: "s2", name: "Radiografia", departmentCode: "RADIOLOGY", active: true }];
const encounter = (patientId = "p1", id = "e1", status = "OPEN") => ({ id, patientId, externalId: id, type: "OUTPATIENT", status });

function mockApi(encounters = [encounter()]) {
  return vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => Promise.resolve(path === "/patients" ? patients : path === "/diagnostic-services" ? services : path.endsWith("/encounters") ? encounters : {}) as never);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function refresh(event = "cvg:realtime-updated") {
  act(() => { window.dispatchEvent(new Event(event)); });
}

async function selectQuickAdd() {
  await screen.findByRole("option", { name: /Thor/ });
  fireEvent.change(screen.getByLabelText("Paciente"), { target: { value: "p1" } });
  fireEvent.change(screen.getByLabelText("Exame"), { target: { value: "s1" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Adicionar exame" })).not.toBeDisabled());
}

describe("QueueBoardQuickAdd", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("adds patient plus exam with Enter and a real open encounter using the routine default", async () => {
    const api = mockApi();
    const onCreated = vi.fn();
    render(<QueueBoardQuickAdd departments={["LABORATORY"]} disabled={false} onCreated={onCreated} />);
    await selectQuickAdd();
    expect(screen.queryByRole("option", { name: "Radiografia" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("Exame"), { key: "Enter" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(api).toHaveBeenCalledWith("/diagnostic-requests", { method: "POST", body: JSON.stringify({ patientId: "p1", encounterId: "e1", priority: "ROUTINE", items: [{ serviceId: "s1" }] }) });
  });

  it("requires selection when multiple open encounters exist", async () => {
    const api = mockApi([encounter(), encounter("p1", "e2"), encounter("p1", "closed", "CLOSED")]);
    render(<QueueBoardQuickAdd departments={["LABORATORY"]} disabled={false} onCreated={vi.fn()} />);
    await selectQuickAdd();
    fireEvent.click(screen.getByRole("button", { name: "Adicionar exame" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("atendimento aberto válido");
    expect(api.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(screen.queryByRole("option", { name: /closed/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Atendimento"), { target: { value: "e2" } });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar exame" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/diagnostic-requests", expect.objectContaining({ body: expect.stringContaining('"encounterId":"e2"') })));
  });

  it("does not invent an encounter when the patient has none open", async () => {
    const api = mockApi([encounter("p1", "e1", "CLOSED")]);
    render(<QueueBoardQuickAdd departments={["LABORATORY"]} disabled={false} onCreated={vi.fn()} />);
    await selectQuickAdd();
    expect(screen.getByText(/Este paciente não tem atendimento aberto\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Abra um novo atendimento na página do paciente." })).toHaveAttribute("href", "/patients/p1/diagnostics");
    fireEvent.click(screen.getByRole("button", { name: "Adicionar exame" }));
    expect(api.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("ignores a stale encounter response after the patient changes", async () => {
    let resolveThor!: (value: unknown) => void;
    const api = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/patients/p1/encounters") return new Promise((resolve) => { resolveThor = resolve; }) as never;
      return Promise.resolve(path === "/patients" ? patients : path === "/diagnostic-services" ? services : path === "/patients/p2/encounters" ? [encounter("p2", "e2")] : {}) as never;
    });
    render(<QueueBoardQuickAdd departments={["LABORATORY"]} disabled={false} onCreated={vi.fn()} />);
    await screen.findByRole("option", { name: /Thor/ });
    fireEvent.change(screen.getByLabelText("Paciente"), { target: { value: "p1" } });
    fireEvent.change(screen.getByLabelText("Paciente"), { target: { value: "p2" } });
    fireEvent.change(screen.getByLabelText("Exame"), { target: { value: "s1" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Adicionar exame" })).not.toBeDisabled());
    resolveThor([encounter()]);
    fireEvent.click(screen.getByRole("button", { name: "Adicionar exame" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/diagnostic-requests", expect.objectContaining({ body: expect.stringContaining('"patientId":"p2","encounterId":"e2"') })));
  });

  it("keeps server duplicate warnings visible and does not bypass them", async () => {
    const api = mockApi();
    api.mockImplementation((path) => path === "/diagnostic-requests" ? Promise.reject(new apiClient.ApiClientError(409, { error: { code: "DUPLICATE_WARNING" } })) : Promise.resolve(path === "/patients" ? patients : path === "/diagnostic-services" ? services : [encounter()]) as never);
    const onCreated = vi.fn();
    render(<QueueBoardQuickAdd departments={["LABORATORY"]} disabled={false} onCreated={onCreated} />);
    await selectQuickAdd();
    fireEvent.click(screen.getByRole("button", { name: "Adicionar exame" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Já existe um exame ativo");
    expect(onCreated).not.toHaveBeenCalled();
    expect(api.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(api.mock.calls.at(-1)?.[1]?.headers).toBeUndefined();
  });
  it("refreshes newly created patients via realtime without clearing patient, exam or encounter", async () => {
    const api = mockApi([encounter(), encounter("p1", "e2")]);
    const onCreated = vi.fn();
    render(<QueueBoardQuickAdd departments={["LABORATORY"]} disabled={false} onCreated={onCreated} />);
    await selectQuickAdd();
    fireEvent.change(screen.getByLabelText("Atendimento"), { target: { value: "e2" } });
    api.mockImplementation((path) => Promise.resolve(path === "/patients" ? [...patients, { ...patients[0], id: "p3", displayName: "Novo paciente" }] : path === "/diagnostic-services" ? services : {}) as never);
    refresh();
    await screen.findByRole("option", { name: /Novo paciente/ });
    expect(screen.getByLabelText("Paciente")).toHaveValue("p1");
    expect(screen.getByLabelText("Exame")).toHaveValue("s1");
    expect(screen.getByLabelText("Atendimento")).toHaveValue("e2");
    fireEvent.keyDown(screen.getByLabelText("Paciente"), { key: "Enter" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(api).toHaveBeenCalledWith("/diagnostic-requests", expect.objectContaining({ body: expect.stringContaining('"encounterId":"e2"') }));
  });

  it("reloads after Atualizar completes, and on realtime resync", async () => {
    const api = mockApi();
    const props = { departments: [], disabled: false, onCreated: vi.fn() };
    const view = render(<QueueBoardQuickAdd {...props} refreshing />);
    await screen.findByRole("option", { name: /Thor/ });
    expect(screen.getByRole("button", { name: "Adicionar exame" })).toBeDisabled();
    expect(api.mock.calls.filter(([path]) => path === "/patients")).toHaveLength(1);
    view.rerender(<QueueBoardQuickAdd {...props} refreshing={false} />);
    await waitFor(() => expect(api.mock.calls.filter(([path]) => path === "/patients")).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Adicionar exame" })).not.toBeDisabled());
    refresh("cvg:realtime-resync");
    await waitFor(() => expect(api.mock.calls.filter(([path]) => path === "/patients")).toHaveLength(3));
    await waitFor(() => expect(screen.getByRole("button", { name: "Adicionar exame" })).not.toBeDisabled());
    view.rerender(<QueueBoardQuickAdd {...props} refreshing={false} />);
    expect(api.mock.calls.filter(([path]) => path === "/patients")).toHaveLength(3);
  });

  it("finds a patient beyond the first 100 with the authorized query and retains it outside later results", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ ...patients[0], id: `first-${index}`, displayName: `Paciente ${index}` }));
    const distant = { ...patients[1], id: "p101", displayName: "Nina & Lua" };
    const api = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => Promise.resolve(
      path === "/patients" ? firstPage : path === "/patients?q=Nina%20%26%20Lua" ? [distant] : path.startsWith("/patients?q=") ? [] : path === "/diagnostic-services" ? services : path.endsWith("/encounters") ? [encounter("p101", "e101")] : {}
    ) as never);
    const onCreated = vi.fn();
    render(<QueueBoardQuickAdd departments={[]} disabled={false} onCreated={onCreated} />);
    await screen.findByRole("option", { name: /Paciente 99/ });
    expect(screen.queryByRole("option", { name: /Nina/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Buscar paciente"), { target: { value: "  Nina & Lua  " } });
    await screen.findByRole("option", { name: /Nina & Lua/ });
    expect(api).toHaveBeenCalledWith("/patients?q=Nina%20%26%20Lua");
    fireEvent.change(screen.getByLabelText("Paciente"), { target: { value: "p101" } });
    fireEvent.change(screen.getByLabelText("Exame"), { target: { value: "s1" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Adicionar exame" })).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText("Buscar paciente"), { target: { value: "sem resultados" } });
    await screen.findByText(/Nenhum paciente encontrado/);
    expect(screen.getByLabelText("Paciente")).toHaveValue("p101");
    expect(screen.getByLabelText("Exame")).toHaveValue("s1");
    fireEvent.keyDown(screen.getByLabelText("Buscar paciente"), { key: "Enter" });
    expect(onCreated).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("Exame"), { key: "Enter" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(api).toHaveBeenCalledWith("/diagnostic-requests", expect.objectContaining({ body: expect.stringContaining('"patientId":"p101","encounterId":"e101"') }));
    fireEvent.change(screen.getByLabelText("Buscar paciente"), { target: { value: "" } });
    await screen.findByRole("option", { name: /Paciente 99/ });
    expect(screen.getByLabelText("Paciente")).toHaveValue("p101");
  });

  it.each(["resolve", "reject"] as const)("ignores a stale patient search %s while keeping the current search results", async (settle) => {
    const oldSearch = deferred<unknown>();
    const api = mockApi();
    api.mockImplementation((path) => path === "/patients?q=old" ? oldSearch.promise as never : Promise.resolve(path === "/patients" ? patients : path === "/patients?q=new" ? [{ ...patients[0], id: "new", displayName: "Atual" }] : services) as never);
    render(<QueueBoardQuickAdd departments={[]} disabled={false} onCreated={vi.fn()} />);
    await screen.findByRole("option", { name: /Thor/ });
    fireEvent.change(screen.getByLabelText("Buscar paciente"), { target: { value: "old" } });
    fireEvent.change(screen.getByLabelText("Buscar paciente"), { target: { value: "new" } });
    await screen.findByRole("option", { name: /Atual/ });
    await act(async () => { if (settle === "resolve") oldSearch.resolve(patients); else oldSearch.reject(new Error("old")); });
    expect(screen.queryByRole("option", { name: /Thor/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Atual/ })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retries a failed patient refresh using the same query and preserving all form choices", async () => {
    const api = mockApi([encounter(), encounter("p1", "e2")]);
    render(<QueueBoardQuickAdd departments={[]} disabled={false} onCreated={vi.fn()} />);
    await selectQuickAdd();
    fireEvent.change(screen.getByLabelText("Atendimento"), { target: { value: "e2" } });
    api.mockImplementation((path) => path === "/patients?q=Thor" ? Promise.reject(new Error("offline")) : Promise.resolve(services) as never);
    fireEvent.change(screen.getByLabelText("Buscar paciente"), { target: { value: "Thor" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar pacientes");
    api.mockImplementation((path) => Promise.resolve(path === "/patients?q=Thor" ? [...patients, { ...patients[0], id: "new", displayName: "Thor novo" }] : services) as never);
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await screen.findByRole("option", { name: /Thor novo/ });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Buscar paciente")).toHaveValue("Thor");
    expect(screen.getByLabelText("Paciente")).toHaveValue("p1");
    expect(screen.getByLabelText("Exame")).toHaveValue("s1");
    expect(screen.getByLabelText("Atendimento")).toHaveValue("e2");
    expect(api.mock.calls.filter(([path]) => path === "/patients/p1/encounters")).toHaveLength(1);
  });

  it("retries an initial patient load without a selected patient", async () => {
    const api = mockApi();
    api.mockImplementation((path) => path === "/patients" ? Promise.reject(new Error("offline")) : Promise.resolve(services) as never);
    render(<QueueBoardQuickAdd departments={[]} disabled={false} onCreated={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("carregar pacientes");
    api.mockImplementation((path) => Promise.resolve(path === "/patients" ? patients : services) as never);
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await screen.findByRole("option", { name: /Thor/ });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("fails closed on a catalog refresh error and retries the catalog, even with a patient selected", async () => {
    const api = mockApi();
    render(<QueueBoardQuickAdd departments={[]} disabled={false} onCreated={vi.fn()} />);
    await selectQuickAdd();
    api.mockImplementation((path) => path === "/diagnostic-services" ? Promise.reject(new Error("offline")) : Promise.resolve(patients) as never);
    refresh();
    expect(await screen.findByRole("alert")).toHaveTextContent("carregar exames");
    expect(screen.getByRole("button", { name: "Adicionar exame" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form"));
    expect(api.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    api.mockImplementation((path) => Promise.resolve(path === "/diagnostic-services" ? services : path === "/diagnostic-requests" ? {} : patients) as never);
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Adicionar exame" })).not.toBeDisabled());
    expect(screen.getByLabelText("Paciente")).toHaveValue("p1");
    expect(screen.getByLabelText("Exame")).toHaveValue("s1");
    fireEvent.submit(screen.getByRole("form"));
    await waitFor(() => expect(screen.getByText("Exame solicitado.")).toBeInTheDocument());
  });

  it.each(["inactive", "removed", "department"] as const)("prevents posting a selected exam that became %s, while retaining its choice", async (change) => {
    const api = mockApi();
    const props = { departments: ["LABORATORY"], disabled: false, onCreated: vi.fn() };
    const view = render(<QueueBoardQuickAdd {...props} />);
    await selectQuickAdd();
    if (change === "department") view.rerender(<QueueBoardQuickAdd {...props} departments={["RADIOLOGY"]} />);
    else {
      api.mockImplementation((path) => Promise.resolve(path === "/patients" ? patients : change === "inactive" ? [{ ...services[0], active: false }, services[1]] : [services[1]]) as never);
      refresh();
      await waitFor(() => expect(screen.getByRole("button", { name: "Adicionar exame" })).not.toBeDisabled());
    }
    expect(screen.getByLabelText("Exame")).toHaveValue("s1");
    expect(screen.getByRole("option", { name: /Exame indisponível/ })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form"));
    expect(await screen.findByRole("alert")).toHaveTextContent("exame não está disponível");
    expect(api.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("checks a selected patient that becomes inactive during refresh", async () => {
    const api = mockApi();
    render(<QueueBoardQuickAdd departments={[]} disabled={false} onCreated={vi.fn()} />);
    await selectQuickAdd();
    api.mockImplementation((path) => Promise.resolve(path === "/patients" ? [{ ...patients[0], active: false }, patients[1]] : services) as never);
    refresh();
    await waitFor(() => expect(screen.getByRole("button", { name: "Adicionar exame" })).not.toBeDisabled());
    fireEvent.submit(screen.getByRole("form"));
    expect(await screen.findByRole("alert")).toHaveTextContent("paciente está inativo");
    expect(api.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("retries failed encounter loading without discarding the exam", async () => {
    const api = mockApi();
    api.mockImplementation((path) => path.endsWith("/encounters") ? Promise.reject(new Error("offline")) : Promise.resolve(path === "/patients" ? patients : services) as never);
    render(<QueueBoardQuickAdd departments={[]} disabled={false} onCreated={vi.fn()} />);
    await selectQuickAdd();
    expect(await screen.findByRole("alert")).toHaveTextContent("carregar o atendimento");
    api.mockImplementation((path) => Promise.resolve(path.endsWith("/encounters") ? [encounter()] : {}) as never);
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Exame")).toHaveValue("s1");
    fireEvent.submit(screen.getByRole("form"));
    await screen.findByText("Exame solicitado.");
  });

  it("ignores a rejected encounter request when the patient selection is cleared", async () => {
    const old = deferred<unknown>();
    const api = mockApi();
    api.mockImplementation((path) => path.endsWith("/encounters") ? old.promise as never : Promise.resolve(path === "/patients" ? patients : services) as never);
    render(<QueueBoardQuickAdd departments={[]} disabled={false} onCreated={vi.fn()} />);
    await screen.findByRole("option", { name: /Thor/ });
    fireEvent.change(screen.getByLabelText("Paciente"), { target: { value: "p1" } });
    fireEvent.submit(screen.getByRole("form"));
    expect(api.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    fireEvent.change(screen.getByLabelText("Paciente"), { target: { value: "" } });
    await act(async () => { old.reject(new Error("old encounter")); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.submit(screen.getByRole("form"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Escolha paciente");
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("filters foreign encounters and checks ownership and open status again before posting", async () => {
    const owned = encounter();
    const api = mockApi([owned, encounter("p2", "foreign")]);
    render(<QueueBoardQuickAdd departments={[]} disabled={false} onCreated={vi.fn()} />);
    await selectQuickAdd();
    expect(screen.queryByLabelText("Atendimento")).not.toBeInTheDocument();
    owned.patientId = "p2";
    fireEvent.submit(screen.getByRole("form"));
    expect(await screen.findByRole("alert")).toHaveTextContent("pertencer ao paciente");
    owned.patientId = "p1";
    owned.status = "CLOSED";
    fireEvent.submit(screen.getByRole("form"));
    expect(screen.getByRole("alert")).toHaveTextContent("estar aberto");
    expect(api.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("suppresses repeated submit events until the first request completes", async () => {
    const post = deferred<unknown>();
    const api = mockApi();
    api.mockImplementation((path) => path === "/diagnostic-requests" ? post.promise as never : Promise.resolve(path === "/patients" ? patients : path === "/diagnostic-services" ? services : [encounter()]) as never);
    const onCreated = vi.fn();
    render(<QueueBoardQuickAdd departments={[]} disabled={false} onCreated={onCreated} />);
    await selectQuickAdd();
    fireEvent.submit(screen.getByRole("form"));
    fireEvent.submit(screen.getByRole("form"));
    expect(api.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(screen.getByLabelText("Buscar paciente")).toBeDisabled();
    await act(async () => { post.resolve({}); });
    expect(onCreated).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Paciente")).toHaveValue("p1");
    expect(screen.getByLabelText("Exame")).toHaveValue("");
  });

  it("preserves the selected encounter and exam after a failed submission retry", async () => {
    const api = mockApi([encounter(), encounter("p1", "e2")]);
    render(<QueueBoardQuickAdd departments={[]} disabled={false} onCreated={vi.fn()} />);
    await selectQuickAdd();
    fireEvent.change(screen.getByLabelText("Atendimento"), { target: { value: "e2" } });
    api.mockImplementation(() => Promise.reject(new Error("offline")));
    fireEvent.submit(screen.getByRole("form"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível solicitar o exame");
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(screen.getByLabelText("Paciente")).toHaveValue("p1");
    expect(screen.getByLabelText("Exame")).toHaveValue("s1");
    expect(screen.getByLabelText("Atendimento")).toHaveValue("e2");
    expect(api.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    api.mockResolvedValue({});
    fireEvent.submit(screen.getByRole("form"));
    await screen.findByText("Exame solicitado.");
    expect(api.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
    expect(api).toHaveBeenLastCalledWith("/diagnostic-requests", expect.objectContaining({ body: expect.stringContaining('"encounterId":"e2"') }));
  });

  it("keeps a valid selected patient usable while another search is pending and refreshes the typed query", async () => {
    const searching = deferred<unknown>();
    const api = mockApi();
    const onCreated = vi.fn();
    render(<QueueBoardQuickAdd departments={[]} disabled={false} onCreated={onCreated} />);
    await selectQuickAdd();
    api.mockImplementation((path) => path === "/patients?q=Mel" ? searching.promise as never : Promise.resolve(path === "/diagnostic-services" ? services : {}) as never);
    fireEvent.change(screen.getByLabelText("Buscar paciente"), { target: { value: "Mel" } });
    expect(screen.getByRole("button", { name: "Adicionar exame" })).not.toBeDisabled();
    fireEvent.submit(screen.getByRole("form"));
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    refresh();
    await waitFor(() => expect(api.mock.calls.filter(([path]) => path === "/patients?q=Mel")).toHaveLength(2));
    await act(async () => { searching.resolve([patients[1]]); });
    expect(screen.getByLabelText("Buscar paciente")).toHaveValue("Mel");
    expect(screen.getByLabelText("Paciente")).toHaveValue("p1");
    expect(screen.getByRole("option", { name: /Mel/ })).toBeInTheDocument();
  });

  it("does not submit while disabled, refreshing or the catalog is still loading", async () => {
    const catalog = deferred<unknown>();
    const api = mockApi();
    api.mockImplementation((path) => path === "/diagnostic-services" ? catalog.promise as never : Promise.resolve(patients) as never);
    const props = { departments: [], disabled: false, onCreated: vi.fn() };
    const view = render(<QueueBoardQuickAdd {...props} />);
    fireEvent.submit(screen.getByRole("form"));
    await act(async () => { catalog.resolve(services); });
    view.rerender(<QueueBoardQuickAdd {...props} disabled />);
    fireEvent.submit(screen.getByRole("form"));
    expect(screen.getByLabelText("Paciente")).toBeDisabled();
    view.rerender(<QueueBoardQuickAdd {...props} refreshing />);
    fireEvent.submit(screen.getByRole("form"));
    expect(api.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["resolve", "reject"] as const)("ignores stale catalog %s after a newer realtime refresh", async (settle) => {
    const oldCatalog = deferred<unknown>();
    const api = mockApi();
    api.mockImplementation((path) => path === "/diagnostic-services" ? oldCatalog.promise as never : Promise.resolve(patients) as never);
    render(<QueueBoardQuickAdd departments={[]} disabled={false} onCreated={vi.fn()} />);
    await screen.findByRole("option", { name: /Thor/ });
    api.mockImplementation((path) => Promise.resolve(path === "/patients" ? patients : [{ ...services[0], name: "Catálogo atual" }]) as never);
    refresh();
    await screen.findByRole("option", { name: "Catálogo atual" });
    await act(async () => { if (settle === "resolve") oldCatalog.resolve(services); else oldCatalog.reject(new Error("old catalog")); });
    expect(screen.queryByRole("option", { name: "Hemograma" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["resolve", "reject"] as const)("ignores outstanding patient, catalog and encounter %s after unmount and removes realtime listeners", async (settle) => {
    const oldPatients = deferred<unknown>();
    const oldServices = deferred<unknown>();
    const oldEncounter = deferred<unknown>();
    const api = mockApi();
    api.mockImplementation((path) => path.endsWith("/encounters") ? oldEncounter.promise as never : Promise.resolve(path === "/patients" ? patients : services) as never);
    const view = render(<QueueBoardQuickAdd departments={[]} disabled={false} onCreated={vi.fn()} />);
    await screen.findByRole("option", { name: /Thor/ });
    fireEvent.change(screen.getByLabelText("Paciente"), { target: { value: "p1" } });
    api.mockImplementation((path) => (path === "/patients" ? oldPatients.promise : oldServices.promise) as never);
    refresh();
    const calls = api.mock.calls.length;
    view.unmount();
    refresh();
    refresh("cvg:realtime-resync");
    await act(async () => {
      if (settle === "resolve") { oldPatients.resolve(patients); oldServices.resolve(services); oldEncounter.resolve([encounter()]); }
      else { oldPatients.reject(new Error("unmounted")); oldServices.reject(new Error("unmounted")); oldEncounter.reject(new Error("unmounted")); }
    });
    expect(api.mock.calls).toHaveLength(calls);
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  });

  it.each(["resolve", "reject"] as const)("does not notify creation when the submission %s after unmount", async (settle) => {
    const post = deferred<unknown>();
    const api = mockApi();
    api.mockImplementation((path) => path === "/diagnostic-requests" ? post.promise as never : Promise.resolve(path === "/patients" ? patients : path === "/diagnostic-services" ? services : [encounter()]) as never);
    const onCreated = vi.fn();
    const view = render(<QueueBoardQuickAdd departments={[]} disabled={false} onCreated={onCreated} />);
    await selectQuickAdd();
    fireEvent.submit(screen.getByRole("form"));
    view.unmount();
    await act(async () => { if (settle === "resolve") post.resolve({}); else post.reject(new Error("unmounted")); });
    expect(onCreated).not.toHaveBeenCalled();
  });
});

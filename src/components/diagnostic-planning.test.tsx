/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionUser } from "@cvg/contracts";
import { DiagnosticPlanningControls } from "./diagnostic-planning";
import * as apiClient from "./api-client";

const item = { id: "item", status: "RECEIVED" as const, version: 7, priority: "ROUTINE" as const, dueAt: "2026-10-11T15:00:00Z" };
const user: SessionUser = { id: "tech", role: "LAB_TECH", email: "test@example.invalid", displayName: "Técnica", departmentCode: "LABORATORY", timezone: "UTC", permissions: ["item.assignment.update", "item.plan.update"] };
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("assumes an eligible exam in one interaction with its exact version", async () => {
  const changed = vi.fn();
  const api = vi.spyOn(apiClient, "apiFetch").mockImplementation(async (path) => path.endsWith("/assignees") ? [{ id: "tech", displayName: "Técnica" }] : { item: { ...item, assignedUserId: "tech" } });
  render(<DiagnosticPlanningControls item={item} user={user} onChanged={changed} />);
  fireEvent.click(await screen.findByRole("button", { name: "Assumir exame" }));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(api).toHaveBeenCalledWith("/diagnostic-items/item/assignment", expect.objectContaining({ method: "PUT", headers: { "idempotency-key": expect.any(String) }, body: JSON.stringify({ userId: "tech", expectedVersion: 7 }) }));
  expect(screen.queryByRole("form", { name: "Atribuir exame" })).not.toBeInTheDocument();
  expect(screen.queryByRole("form", { name: "Planejar exame" })).not.toBeInTheDocument();
});

it("converts planned dates in the hospital timezone and does not post a reservation or clinical transition", async () => {
  vi.stubEnv("NEXT_PUBLIC_HOSPITAL_TIMEZONE", "America/Sao_Paulo");
  const api = vi.spyOn(apiClient, "apiFetch").mockImplementation(async (path) => path.endsWith("/assignees") ? [] : { item });
  render(<DiagnosticPlanningControls item={{ ...item, assignedUserId: "tech" }} user={user} onChanged={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Início planejado"), { target: { value: "2026-10-11T12:00" } });
  fireEvent.change(screen.getByLabelText("Fim planejado"), { target: { value: "2026-10-11T11:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Salvar planejamento" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("O fim deve ocorrer depois do início.");
  expect(api.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  fireEvent.change(screen.getByLabelText("Fim planejado"), { target: { value: "2026-10-11T13:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Salvar planejamento" }));
  await waitFor(() => expect(api).toHaveBeenCalledWith("/diagnostic-items/item/planning", expect.objectContaining({ body: JSON.stringify({ plannedStartsAt: "2026-10-11T15:00:00.000Z", plannedEndsAt: "2026-10-11T16:00:00.000Z", expectedVersion: 7 }) })));
  expect(api.mock.calls.some(([path]) => /schedule|processing|release/.test(path))).toBe(false);
});

it("requires a reason to reclassify the item and preserves an ambiguous command key on retry", async () => {
  const api = vi.spyOn(apiClient, "apiFetch").mockRejectedValueOnce(new Error("connection interrupted")).mockResolvedValue({ item });
  render(<DiagnosticPlanningControls item={item} user={{ ...user, role: "VETERINARIAN", permissions: ["item.priority.update"] }} onChanged={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Prioridade do exame"), { target: { value: "URGENT" } });
  fireEvent.submit(screen.getByRole("form", { name: "Reclassificar prioridade do exame" }));
  expect(api).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Motivo da reclassificação"), { target: { value: "Piora clínica" } });
  fireEvent.submit(screen.getByRole("form", { name: "Reclassificar prioridade do exame" }));
  await screen.findByRole("alert");
  fireEvent.submit(screen.getByRole("form", { name: "Reclassificar prioridade do exame" }));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  expect(api.mock.calls[0][1]?.headers).toEqual(api.mock.calls[1][1]?.headers);
  expect(JSON.parse(api.mock.calls[1][1]?.body as string)).toEqual({ priority: "URGENT", reason: "Piora clínica", expectedVersion: 7 });
});

it.each(["COMPLETED", "CANCELLED", "REJECTED", "FAILED", "RESULT_VOIDED"] as const)("keeps %s read only despite planning grants", (status) => {
  const api = vi.spyOn(apiClient, "apiFetch");
  render(<DiagnosticPlanningControls item={{ ...item, status }} user={{ ...user, role: "SUPERADMIN", permissions: ["item.assignment.update", "item.plan.update", "item.priority.update"] }} onChanged={vi.fn()} />);
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
  expect(api).not.toHaveBeenCalled();
});

it("lets management replace an unavailable historical assignee and explicitly clear the current assignment", async () => {
  const changed = vi.fn();
  const api = vi.spyOn(apiClient, "apiFetch").mockImplementation(async (path) => path.endsWith("/assignees") ? [{ id: "tech", displayName: "Técnica", departmentCode: "LABORATORY" }] : { item });
  render(<DiagnosticPlanningControls item={{ ...item, assignedUserId: "old-staff" }} user={{ ...user, role: "MANAGER" }} onChanged={changed} />);
  expect(screen.getByText("Responsável: Profissional atribuído")).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole("button", { name: "Salvar atribuição" })).toBeEnabled());
  expect(screen.getByRole("option", { name: "Atribuição existente indisponível" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Profissional responsável"), { target: { value: "tech" } });
  fireEvent.submit(screen.getByRole("form", { name: "Atribuir exame" }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(JSON.parse(api.mock.calls.find(([path]) => path.endsWith("/assignment"))![1]!.body as string)).toEqual({ userId: "tech", expectedVersion: 7 });
  fireEvent.change(screen.getByLabelText("Profissional responsável"), { target: { value: "" } });
  fireEvent.submit(screen.getByRole("form", { name: "Atribuir exame" }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
  expect(JSON.parse(api.mock.calls.at(-1)![1]!.body as string)).toEqual({ userId: null, expectedVersion: 7 });
});

it("requires a complete pair of planning dates and removes both explicitly without changing the clinical SLA", async () => {
  const changed = vi.fn(); const api = vi.spyOn(apiClient, "apiFetch").mockResolvedValue({ item });
  render(<DiagnosticPlanningControls item={{ ...item, assignedUserId: "tech", plannedStartsAt: "2026-10-11T15:00:00Z", plannedEndsAt: "2026-10-11T16:00:00Z" }} user={{ ...user, permissions: ["item.plan.update"] }} onChanged={changed} />);
  fireEvent.change(screen.getByLabelText("Fim planejado"), { target: { value: "" } });
  fireEvent.submit(screen.getByRole("form", { name: "Planejar exame" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Informe início e fim ou remova ambos."); expect(api).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Início planejado"), { target: { value: "" } });
  fireEvent.submit(screen.getByRole("form", { name: "Planejar exame" }));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(JSON.parse(api.mock.calls[0][1]!.body as string)).toEqual({ plannedStartsAt: null, plannedEndsAt: null, expectedVersion: 7 });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("disables assignment after eligibility lookup fails instead of presenting an unrestricted staff picker", async () => {
  vi.spyOn(apiClient, "apiFetch").mockRejectedValue(new Error("private directory failure"));
  render(<DiagnosticPlanningControls item={item} user={{ ...user, role: "SUPERADMIN" }} onChanged={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível consultar os profissionais elegíveis.");
  expect(screen.getByRole("button", { name: "Salvar atribuição" })).toBeDisabled();
  expect(screen.getByLabelText("Profissional responsável")).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Assumir exame" })).not.toBeInTheDocument();
});

it("ignores eligibility replies for a replaced item and displays the current authorized responsible", async () => {
  let resolveOld!: (value: unknown) => void;
  vi.spyOn(apiClient, "apiFetch").mockImplementation(async (path) => path === "/diagnostic-items/item/assignees" ? new Promise<unknown>((resolve) => { resolveOld = resolve; }) : [{ id: "tech", displayName: "Técnica atual", departmentCode: "LABORATORY" }]);
  const { rerender } = render(<DiagnosticPlanningControls item={item} user={user} onChanged={vi.fn()} />);
  rerender(<DiagnosticPlanningControls item={{ ...item, id: "current", version: 9, assignedUserId: "tech" }} user={user} onChanged={vi.fn()} />);
  await screen.findByText("Responsável: Técnica atual");
  await act(async () => resolveOld([{ id: "tech", displayName: "Resposta obsoleta", departmentCode: "LABORATORY" }]));
  expect(screen.getByText("Responsável: Técnica atual")).toBeInTheDocument(); expect(screen.queryByText(/Resposta obsoleta/)).not.toBeInTheDocument();
});

it("blocks hospital DST gaps while preserving the entered planning intent for correction", () => {
  vi.stubEnv("NEXT_PUBLIC_HOSPITAL_TIMEZONE", "America/New_York");
  const api = vi.spyOn(apiClient, "apiFetch");
  render(<DiagnosticPlanningControls item={item} user={{ ...user, role: "MANAGER", permissions: ["item.plan.update"] }} onChanged={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Início planejado"), { target: { value: "2026-03-08T02:30" } }); fireEvent.change(screen.getByLabelText("Fim planejado"), { target: { value: "2026-03-08T03:30" } });
  fireEvent.submit(screen.getByRole("form", { name: "Planejar exame" })); expect(screen.getByRole("alert")).toHaveTextContent("Este horário não existe no fuso do hospital"); expect(api).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Início planejado")).toHaveValue("2026-03-08T02:30");
});

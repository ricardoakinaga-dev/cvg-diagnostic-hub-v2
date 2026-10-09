/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataSubjectExportPanel } from "./admin-data-subject-export";
import * as apiClient from "./api-client";

const exported = { format: "cvg-hub.patient-data-export.v1", patient: { externalId: "HIS-THOR-001" }, requests: [{ archived: false }, { archived: true }] };

function fill(record: string, password = "senha-do-admin") {
  fireEvent.click(screen.getByText("Exportar dados do titular (LGPD)"));
  fireEvent.change(screen.getByLabelText("Número do prontuário"), { target: { value: record } });
  fireEvent.change(screen.getByLabelText("Sua senha (confirmação)"), { target: { value: password } });
}

describe("DataSubjectExportPanel", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("confirms the password, exports and downloads the file without showing its content", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.spyOn(apiClient, "apiFetch").mockImplementation(async <T,>(path: string, init?: RequestInit): Promise<T> => {
      calls.push([path, init]);
      return (path === "/session/reauth" ? { reauthenticatedAt: "now" } : exported) as T;
    });
    const createObjectURL = vi.fn(() => "blob:export");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<DataSubjectExportPanel />);
    fill("  HIS-THOR-001 ");
    fireEvent.click(screen.getByRole("button", { name: "Exportar" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Exportação de HIS-THOR-001 gerada e registrada na auditoria: 2 solicitação(ões), 1 arquivada(s).");
    expect(calls.map(([path]) => path)).toEqual(["/session/reauth", "/data-subject-exports?externalId=HIS-THOR-001"]);
    expect(JSON.parse(calls[0]![1]!.body as string)).toEqual({ password: "senha-do-admin" });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:export");
    // The password and the record number are cleared; the content never reaches the page.
    expect(screen.getByLabelText("Sua senha (confirmação)")).toHaveValue("");
    expect(screen.getByLabelText("Número do prontuário")).toHaveValue("");
    expect(document.body.textContent).not.toContain("cvg-hub.patient-data-export.v1");
  });

  it("explains a wrong password and an unknown record, and refuses a malformed number before calling the server", async () => {
    const mock = vi.spyOn(apiClient, "apiFetch").mockRejectedValueOnce(new apiClient.ApiClientError(401, { error: { code: "UNAUTHENTICATED" } }));
    render(<DataSubjectExportPanel />);
    fill("HIS-THOR-001", "errada");
    fireEvent.click(screen.getByRole("button", { name: "Exportar" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(mock).toHaveBeenCalledTimes(1);

    mock.mockResolvedValueOnce({ reauthenticatedAt: "now" }).mockRejectedValueOnce(new apiClient.ApiClientError(404, { error: { code: "NOT_FOUND", message: "Nenhum paciente com este número de prontuário." } }));
    fireEvent.change(screen.getByLabelText("Sua senha (confirmação)"), { target: { value: "certa" } });
    fireEvent.click(screen.getByRole("button", { name: "Exportar" }));
    await waitFor(() => expect(mock).toHaveBeenCalledTimes(3));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    mock.mockClear();
    fireEvent.change(screen.getByLabelText("Número do prontuário"), { target: { value: "HIS THOR" } });
    fireEvent.change(screen.getByLabelText("Sua senha (confirmação)"), { target: { value: "certa" } });
    fireEvent.click(screen.getByRole("button", { name: "Exportar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Informe o número do prontuário");
    expect(mock).not.toHaveBeenCalled();
  });
});

/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountView } from "./account-view";
import * as apiClient from "./api-client";

const replace = vi.fn();

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace })
}));

describe("AccountView", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the authenticated identity, operational context and allowed shortcuts", async () => {
    vi.spyOn(apiClient, "apiFetch").mockResolvedValue({
      user: {
        id: "user-vet",
        email: "vet@cvg.local",
        displayName: "Dra. Marina Costa",
        role: "VETERINARIAN",
        departmentCode: "INPATIENT",
        timezone: "America/Sao_Paulo"
      }
    } as never);

    render(<AccountView />);

    expect(await screen.findByRole("heading", { name: /Minha conta/i })).toBeInTheDocument();
    expect(screen.getByText("Dra. Marina Costa")).toBeInTheDocument();
    expect(screen.getByText("Veterinária")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Meus pacientes/i })).toHaveAttribute("href", "/patients");
    expect(screen.getByRole("link", { name: /Central de exames/i })).toHaveAttribute("href", "/queues");
  });

  it("logs out through the server before redirecting to login", async () => {
    const apiFetchMock = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => {
      if (path === "/session/me") return Promise.resolve({ user: { id: "user-1", email: "vet@cvg.local", displayName: "Ana", role: "VETERINARIAN", departmentCode: "LABORATORY", timezone: "UTC" } }) as never;
      return Promise.resolve({}) as never;
    });
    render(<AccountView />);
    expect(await screen.findByRole("button", { name: "Encerrar sessão" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Encerrar sessão" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith("/session/logout", expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
  });

  it("requires matching personal credentials and hides operational shortcuts until first-login replacement", async () => {
    const mock = vi.spyOn(apiClient, "apiFetch").mockResolvedValue({ user: { id: "new-user", email: "new@cvg.local", displayName: "Nova colaboradora", role: "LAB_TECH", departmentCode: "LABORATORY", timezone: "UTC", mustChangePassword: true } } as never);
    render(<AccountView />);
    expect(await screen.findByRole("heading", { name: "Crie sua senha" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Central de exames/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Nova senha", { exact: true }), { target: { value: "Personal-password-1234" } });
    fireEvent.change(screen.getByLabelText("Confirmar nova senha"), { target: { value: "Other-password-5678" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar nova senha" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("As senhas precisam ser iguais.");
    expect(mock).toHaveBeenCalledTimes(1);
    mock.mockRejectedValueOnce(new apiClient.ApiClientError(400, { error: { code: "VALIDATION_ERROR", message: "Senha inválida", correlationId: "corr-password" } }));
    fireEvent.change(screen.getByLabelText("Confirmar nova senha"), { target: { value: "Personal-password-1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar nova senha" }));
    await waitFor(() => expect(mock).toHaveBeenCalledWith("/session/password", { method: "POST", body: JSON.stringify({ password: "Personal-password-1234" }) }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Crie sua senha" })).toBeInTheDocument();
  });

  it("changes the password with the current one, confirms matching entries and reports the outcome", async () => {
    const user = { id: "user-vet", email: "vet@cvg.local", displayName: "Ana", role: "VETERINARIAN", departmentCode: "INPATIENT", timezone: "UTC" };
    const mock = vi.spyOn(apiClient, "apiFetch").mockImplementation((path) => (path === "/session/me" ? Promise.resolve({ user }) : Promise.resolve({ user, expiresAt: "2026-10-08T20:00:00.000Z" })) as never);
    render(<AccountView />);
    expect(await screen.findByRole("heading", { name: "Alterar senha" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Senha atual"), { target: { value: "Current-secret-1234" } });
    fireEvent.change(screen.getByLabelText("Nova senha", { exact: true }), { target: { value: "Rotated-secret-5678" } });
    fireEvent.change(screen.getByLabelText("Confirmar nova senha"), { target: { value: "Different-secret-9012" } });
    fireEvent.click(screen.getByRole("button", { name: "Alterar senha" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("As senhas novas precisam ser iguais.");
    expect(mock).toHaveBeenCalledTimes(1);

    mock.mockRejectedValueOnce(new apiClient.ApiClientError(400, { error: { code: "CURRENT_PASSWORD_INVALID", correlationId: "corr-wrong" } }));
    fireEvent.change(screen.getByLabelText("Confirmar nova senha"), { target: { value: "Rotated-secret-5678" } });
    fireEvent.click(screen.getByRole("button", { name: "Alterar senha" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("A senha atual não confere."));

    fireEvent.click(screen.getByRole("button", { name: "Alterar senha" }));
    await waitFor(() => expect(mock).toHaveBeenLastCalledWith("/session/password/change", {
      method: "POST", body: JSON.stringify({ currentPassword: "Current-secret-1234", newPassword: "Rotated-secret-5678" })
    }));
    expect(await screen.findByRole("status")).toHaveTextContent("Senha alterada. As outras sessões foram encerradas.");
    expect(screen.getByLabelText("Senha atual")).toHaveValue("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});


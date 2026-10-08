/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "@cvg/services";
import { PasswordResetForm } from "./password-reset-form";
import { apiFetch } from "./api-client";

let query = "token=tok-123";
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(query) }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => <a {...props}>{children}</a> }));
vi.mock("./api-client", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api-client")>()), apiFetch: vi.fn() }));

const NEW = "Cavalo-azul-Lua-48-xk";
function fill(password = NEW, confirmation = NEW) {
  fireEvent.change(screen.getByLabelText("Nova senha"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Confirmar nova senha"), { target: { value: confirmation } });
  fireEvent.click(screen.getByRole("button", { name: "Redefinir senha" }));
}

describe("PasswordResetForm (PROD-202)", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); query = "token=tok-123"; window.history.replaceState(null, "", "/"); });

  it("shows the policy, sends the token and password, removes the token from the address bar and links to login on success", async () => {
    window.history.replaceState(null, "", "/reset-password?token=tok-123");
    vi.mocked(apiFetch).mockResolvedValue({ email: "vet@cvg.local" });
    render(<PasswordResetForm />);
    expect(screen.getByText(/12 a 200 caracteres/)).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe(""));
    fill();
    expect(await screen.findByRole("status")).toHaveTextContent("Senha redefinida. Entre com a nova senha.");
    expect(apiFetch).toHaveBeenCalledWith("/session/password/reset", { method: "POST", body: JSON.stringify({ token: "tok-123", password: NEW }) });
    expect(screen.getByRole("link", { name: "Ir para o login" })).toHaveAttribute("href", "/login");
    expect(screen.queryByLabelText("Nova senha")).not.toBeInTheDocument();
  });

  it("requires matching confirmation before calling the API", () => {
    render(<PasswordResetForm />);
    fill(NEW, "Outra-senha-Lua-77-q");
    expect(screen.getByRole("alert")).toHaveTextContent("As senhas precisam ser iguais.");
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("explains an invalid or expired link without saying which and offers a way back", async () => {
    vi.mocked(apiFetch).mockRejectedValue(new ApiClientError(400, { error: { code: "PASSWORD_RESET_INVALID" } }));
    render(<PasswordResetForm />);
    fill();
    expect(await screen.findByRole("alert")).toHaveTextContent("Link de redefinição inválido ou expirado.");
    expect(screen.getByText(/Peça um novo link/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Voltar ao login" })).toHaveAttribute("href", "/login");
    expect(screen.queryByLabelText("Nova senha")).not.toBeInTheDocument();
  });

  it("treats a missing token as an invalid link without calling the API", () => {
    query = "";
    render(<PasswordResetForm />);
    expect(screen.getByRole("alert")).toHaveTextContent("Link de redefinição inválido ou expirado.");
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("keeps the form and shows a safe message for a policy rejection", async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new ApiClientError(400, { error: { code: "PASSWORD_BREACHED" } })).mockRejectedValueOnce(new Error("postgres://secret"));
    render(<PasswordResetForm />);
    fill();
    expect(await screen.findByRole("alert")).toHaveTextContent("Esta senha apareceu em vazamentos conhecidos; escolha outra.");
    expect(screen.getByLabelText("Nova senha")).toBeInTheDocument();
    fill();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível redefinir a senha. Tente novamente."));
    expect(screen.getByRole("alert")).not.toHaveTextContent("postgres://");
  });
});

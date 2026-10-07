/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "./login-form";
import { apiFetch } from "./api-client";

const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
}));

vi.mock("./api-client", () => ({
  apiFetch: vi.fn(),
  getSafeErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

describe("LoginForm", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not render server exception details on login failure", async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error("postgres://user:password@host/db"));
    render(<LoginForm />);

    fireEvent.change(screen.getByLabelText("E-mail profissional"), { target: { value: "vet@cvg.local" } });
    fireEvent.change(screen.getByLabelText("Senha"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar no Hub" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível entrar. Verifique os dados e tente novamente."));
    expect(screen.getByRole("alert")).not.toHaveTextContent("postgres://");
    expect(replace).not.toHaveBeenCalled();
  });

  it("directs temporary credentials to mandatory password replacement", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ user: { mustChangePassword: true } });
    render(<LoginForm />);
    fireEvent.change(screen.getByLabelText("E-mail profissional"), { target: { value: "new@cvg.local" } });
    fireEvent.change(screen.getByLabelText("Senha"), { target: { value: "Initial-password-1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar no Hub" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/account?password=required"));
  });
});

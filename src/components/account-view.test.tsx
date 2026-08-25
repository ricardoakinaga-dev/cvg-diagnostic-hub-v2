/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountView } from "./account-view";
import * as apiClient from "./api-client";

vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => <a {...props}>{children}</a>
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() })
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
});
